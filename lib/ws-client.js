/**
 * DSH 侧的 WebSocket 客户端（协议 `dsh-notify.ws.v1`）。
 *
 * 只连出去、不开入站端口：握手带 `Authorization: Bearer`，首帧 hello，收到 hello-ok
 * 才算 ready。断线后指数退避重连；task 先进内存队列，收到 ack 才出队；重连后用同一个
 * msgId 原样重发（服务端按 msgId 去重）。收到 reply 调注入回调，回 reply-result。
 *
 * 状态机：idle → connecting → hello → ready → closing → backoff（→ connecting…）
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import WebSocket from 'ws';
import { buildTaskFrame, deriveDeviceId, isWsUrl } from './notify.js';

export const CLIENT_VERSION = '0.3.3';
export const CLIENT_KIND = 'dsh';
/** hello 帧里声明的能力：接收 reply + 期待 ack。 */
export const FEATURES = ['reply', 'ack'];
export const WIRE_VERSION = 1;

/** 待发队列：内存上限 50 条 / TTL 10 分钟。 */
export const QUEUE_MAX = 50;
export const QUEUE_TTL_MS = 10 * 60 * 1000;

export const DEFAULT_HEARTBEAT_SEC = 30;
/** 连续 2 个周期没有心跳就当僵死连接（Windows 睡眠唤醒的典型症状）。 */
export const HEARTBEAT_MISS_LIMIT = 2;

export const CLOSE_NORMAL = 1000;
/** 稍后重连：服务端重启 / 背压 / 心跳僵死时用。 */
export const CLOSE_RETRY_LATER = 1013;
/** 握手超时（第 3.3 节里同一个码）。 */
export const CLOSE_HELLO_TIMEOUT = 4408;

const OPEN = 1;
const MAX_FRAME_BYTES = 64 * 1024;

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/** 公共字段 `v`/`type`/`id`/`at` + 各帧自己的字段（第 3 节）。 */
const frameOf = (type, fields = {}) => ({
  v: WIRE_VERSION,
  type,
  id: randomUUID(),
  at: new Date().toISOString(),
  ...fields,
});

function numberIn(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * 建一个 ws 客户端。`getSettings()` 每次现读配置（volatile 字段可能随时变），
 * `prompt(request)` 负责把 Coopanion 的 reply 注入会话。
 */
export function createWsClient(options = {}) {
  const {
    getSettings = () => ({}),
    prompt = async () => {},
    log = () => {},
    clientVersion = CLIENT_VERSION,
    WebSocketImpl = WebSocket,
    queueMax = QUEUE_MAX,
    queueTtlMs = QUEUE_TTL_MS,
    now = () => Date.now(),
    random = Math.random,
    hostnameOf = () => hostname(),
  } = options;

  let state = 'idle';
  let running = false;
  let stopping = false;
  let socket;
  let attempt = 0;
  let activeSignature;
  /** 「没有启用的服务」只提示一次，避免 2 秒巡检重复刷日志。 */
  let noServiceNotified = false;

  let reconnectTimer;
  let connectTimer;
  let heartbeatTimer;
  let pruneTimer;
  let reconcileTimer;

  /** 最近一次服务端应用层 ping（帧）与最近一次 ws 原生 pong。 */
  let lastPingAt = 0;
  let lastPongAt = 0;
  let heartbeatMs = DEFAULT_HEARTBEAT_SEC * 1000;

  let connectedAt;
  let lastAck;
  let lastError;
  let lastClose;
  let serverInfo;

  /** 未 ack 的 task 帧，按入队顺序发送。 */
  const queue = [];
  /** 已注入过的 replyId，防重复注入。 */
  const replySeen = new Set();
  const timers = new Set();

  const setTimer = (callback, ms) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, ms);
    timer.unref?.();
    timers.add(timer);
    return timer;
  };

  const setIntervalTimer = (callback, ms) => {
    const timer = setInterval(callback, ms);
    timer.unref?.();
    timers.add(timer);
    return timer;
  };

  const clearTimer = (timer) => {
    if (!timer) return;
    clearTimeout(timer);
    clearInterval(timer);
    timers.delete(timer);
  };

  const clearAllTimers = () => {
    for (const timer of timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    timers.clear();
  };

  const settingsNow = () => {
    try {
      return getSettings() ?? {};
    } catch {
      return {};
    }
  };

  /**
   * 当前是否有可连接的活动服务。0.3.1 的 resolveSettings 会给出 activeServerId；
   * 直接传普通 settings 的调用方（测试/工具）没有这个字段时回退为看 wsUrl。
   */
  const hasActiveService = (settings) => (
    settings.activeServerId !== undefined
      ? Boolean(settings.activeServerId)
      : isWsUrl(String(settings.wsUrl ?? '').trim())
  );

  const serviceLabelOf = (settings) => {
    const label = String(settings.activeServerLabel ?? '').trim();
    return label ? `服务「${label}」` : '当前服务';
  };

  const report = (level, message) => {
    try {
      log(level, message);
    } catch {
      // 日志失败不影响连接
    }
  };

  const setState = (next) => {
    if (state === next) return;
    state = next;
    report('debug', `[dsh-notify-sender] ws 状态：${next}`);
  };

  const signatureOf = (settings) => [
    String(settings.wsUrl ?? '').trim(),
    String(settings.token ?? ''),
    String(settings.deviceId ?? '').trim(),
    String(settings.device ?? '').trim(),
  ].join('|');

  /** 发送一帧；连接不在 OPEN 状态时返回 false（调用方决定是否入队/重试）。 */
  const sendFrame = (target, frame) => {
    if (!target || target.readyState !== OPEN) return false;
    try {
      target.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      report('debug', `[dsh-notify-sender] 发送失败：${messageOf(error)}`);
      return false;
    }
  };

  const pruneQueue = () => {
    const deadline = now() - queueTtlMs;
    let removed = 0;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index].queuedAt > deadline) continue;
      queue.splice(index, 1);
      removed += 1;
    }
    if (removed > 0) {
      report('warn', `[dsh-notify-sender] ${removed} 条通知超过 ${Math.round(queueTtlMs / 1000)} 秒未确认，已丢弃`);
    }
  };

  /** ready 后按序补发：同一 entry 的 frame 原样重发，msgId 不变。 */
  const flushQueue = (target) => {
    pruneQueue();
    for (const entry of queue) {
      if (entry.acked) continue;
      sendFrame(target, entry.frame);
      entry.sentAt = now();
    }
  };

  const handleAck = (frame) => {
    const ref = String(frame.ref ?? '').trim();
    if (!ref) return;
    const index = queue.findIndex((entry) => entry.msgId === ref);
    if (index >= 0) queue.splice(index, 1);
    lastAck = {
      ref,
      cursor: frame.cursor ?? null,
      duplicate: frame.duplicate === true,
      at: new Date().toISOString(),
    };
  };

  const stopHeartbeat = () => {
    clearTimer(heartbeatTimer);
    heartbeatTimer = undefined;
  };

  const startHeartbeat = (target) => {
    stopHeartbeat();
    lastPingAt = now();
    lastPongAt = now();
    const tickMs = Math.max(10, heartbeatMs);
    heartbeatTimer = setIntervalTimer(() => {
      if (socket !== target || state !== 'ready') return;
      const appIdle = now() - lastPingAt;
      if (appIdle >= heartbeatMs * HEARTBEAT_MISS_LIMIT) {
        lastError = `应用层心跳超时：${HEARTBEAT_MISS_LIMIT} 个周期没有收到服务端 ping`;
        report('warn', `[dsh-notify-sender] ${lastError}，主动重连`);
        failSocket(target, CLOSE_RETRY_LATER, 'heartbeat timeout');
        return;
      }
      const transportIdle = now() - lastPongAt;
      if (transportIdle >= heartbeatMs * HEARTBEAT_MISS_LIMIT) {
        lastError = `传输层心跳超时：${HEARTBEAT_MISS_LIMIT} 个周期没有收到 pong`;
        report('warn', `[dsh-notify-sender] ${lastError}，主动重连`);
        failSocket(target, CLOSE_RETRY_LATER, 'transport timeout');
        return;
      }
      // 应用层 ping 之外再发一个 ws 原生 ping（双保险）。
      try {
        target.ping();
      } catch {
        // 连接已断，close 事件会兜底
      }
    }, tickMs);
  };

  /** 主动结束一条连接：先礼貌 close，对端不配合时强断。 */
  const failSocket = (target, code, reason) => {
    if (socket !== target) return;
    stopHeartbeat();
    try {
      target.close(code, reason);
    } catch {
      try {
        target.terminate();
      } catch {
        // 忽略
      }
      return;
    }
    setTimer(() => {
      if (socket === target) {
        try {
          target.terminate();
        } catch {
          // 忽略
        }
      }
    }, 200);
  };

  /** 主动下线/换配置：发 bye 再 close(1000)。 */
  const closeGracefully = (target, reason) => {
    if (socket !== target) return;
    stopHeartbeat();
    sendFrame(target, frameOf('bye', { reason }));
    setState('closing');
    try {
      target.close(CLOSE_NORMAL, 'bye');
    } catch {
      try {
        target.terminate();
      } catch {
        // 忽略
      }
      return;
    }
    setTimer(() => {
      if (socket === target) {
        try {
          target.terminate();
        } catch {
          // 忽略
        }
      }
    }, 500);
  };

  const scheduleReconnect = () => {
    if (!running || stopping) {
      setState('idle');
      return;
    }
    if (reconnectTimer) return;
    const settings = settingsNow();
    const minMs = numberIn(settings.reconnectMinMs, 1000, 10, 60_000);
    const maxMs = Math.max(minMs, numberIn(settings.reconnectMaxMs, 30_000, 10, 600_000));
    // 1s × 2ⁿ 封顶 maxMs，±20% 抖动。
    const base = Math.min(maxMs, minMs * 2 ** attempt);
    const delay = Math.max(1, Math.round(base * (0.8 + random() * 0.4)));
    attempt += 1;
    setState('backoff');
    report('debug', `[dsh-notify-sender] ${delay}ms 后重连（第 ${attempt} 次）`);
    reconnectTimer = setTimer(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };

  const handleClose = (target, code, reason) => {
    if (socket !== target) return;
    socket = undefined;
    clearTimer(connectTimer);
    connectTimer = undefined;
    stopHeartbeat();
    lastClose = { code, reason: String(reason ?? ''), at: new Date().toISOString() };
    if (stopping || !running) {
      setState('idle');
      return;
    }
    const settings = settingsNow();
    if (!settings.enabled || !hasActiveService(settings)) {
      setState('idle');
      return;
    }
    if (code === 4401 || code === 4403) {
      lastError = `服务端拒绝认证（close ${code}）`;
      report('warn', `[dsh-notify-sender] ${lastError}：请检查 token 是否与 Coopanion 的令牌一致`);
    } else if (code === 4409) {
      report('warn', '[dsh-notify-sender] 同 deviceId 的新连接顶掉了这条连接，稍后重连');
    } else if (code === 4429) {
      lastError = '同时在线设备数超过 Coopanion 的 maxDevices 上限';
      report('warn', `[dsh-notify-sender] ${lastError}，稍后重连`);
    }
    scheduleReconnect();
  };

  const sendHello = (target) => {
    const settings = settingsNow();
    const host = String(hostnameOf() ?? '').trim();
    const deviceName = String(settings.device || '').trim() || host;
    const deviceId = String(settings.deviceId || '').trim() || deriveDeviceId(host);
    const hello = frameOf('hello', {
      deviceId,
      deviceName,
      client: CLIENT_KIND,
      clientVersion: String(clientVersion),
      features: [...FEATURES],
    });
    // 令牌只走握手头，不进帧、不进日志。
    if (!sendFrame(target, hello)) report('warn', '[dsh-notify-sender] hello 帧发送失败');
  };

  const handleHelloOk = (target, frame) => {
    if (socket !== target) return;
    clearTimer(connectTimer);
    connectTimer = undefined;
    const heartbeatSec = numberIn(frame.heartbeatSec, DEFAULT_HEARTBEAT_SEC, 0.05, 300);
    heartbeatMs = heartbeatSec * 1000;
    serverInfo = {
      serverVersion: String(frame.serverVersion ?? ''),
      deviceId: String(frame.deviceId ?? ''),
      heartbeatSec,
      limits: frame.limits && typeof frame.limits === 'object' ? { ...frame.limits } : undefined,
    };
    attempt = 0;
    connectedAt = new Date().toISOString();
    lastError = undefined;
    setState('ready');
    report('info', `[dsh-notify-sender] 已连上 Coopanion（${serviceLabelOf(settingsNow())}，server ${serverInfo.serverVersion || '?'}，心跳 ${heartbeatSec}s）`);
    startHeartbeat(target);
    flushQueue(target);
  };

  const handleReply = async (target, frame) => {
    const replyId = String(frame.replyId ?? '').trim();
    const sessionId = String(frame.sessionId ?? '').trim();
    const text = String(frame.text ?? '');
    if (!replyId || !sessionId || !text.trim()) {
      report('warn', '[dsh-notify-sender] reply 帧缺少 replyId/sessionId/text，已忽略');
      if (replyId) sendFrame(target, frameOf('reply-result', { replyId, ok: false, error: 'invalid reply' }));
      return;
    }
    if (replySeen.has(replyId)) {
      // 同一个 replyId 只注入一次；重复帧按成功回复，让服务端停止重发。
      sendFrame(target, frameOf('reply-result', { replyId, ok: true }));
      return;
    }
    if (!settingsNow().acceptReplies) {
      sendFrame(target, frameOf('reply-result', { replyId, ok: false, error: 'replies disabled' }));
      return;
    }
    try {
      await prompt({ requestId: replyId, sessionId, text, taskId: frame.taskId });
      replySeen.add(replyId);
      if (replySeen.size > 1000) replySeen.clear();
      sendFrame(target, frameOf('reply-result', { replyId, ok: true }));
      report('info', `[dsh-notify-sender] 已把 Coopanion 回复注入 ${sessionId}`);
    } catch (error) {
      // 注入失败不缓存去重键：服务端重发同一条 reply 时再试一次。
      lastError = `注入失败：${messageOf(error)}`;
      sendFrame(target, frameOf('reply-result', { replyId, ok: false, error: messageOf(error) }));
      report('warn', `[dsh-notify-sender] ${lastError}`);
    }
  };

  const handleMessage = (target, data) => {
    let frame;
    try {
      const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      frame = JSON.parse(text);
    } catch {
      report('debug', '[dsh-notify-sender] 收到无法解析的帧，已忽略');
      return;
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return;
    if (frame.v !== WIRE_VERSION) {
      report('debug', `[dsh-notify-sender] 帧版本不符（${String(frame.v)}），已忽略`);
      return;
    }
    if (frame.type === 'hello-ok') {
      handleHelloOk(target, frame);
      return;
    }
    if (state !== 'ready') {
      report('debug', `[dsh-notify-sender] 未就绪，忽略 ${String(frame.type)} 帧`);
      return;
    }
    switch (frame.type) {
      case 'ack':
        handleAck(frame);
        break;
      case 'reply':
        void handleReply(target, frame);
        break;
      case 'ping':
        lastPingAt = now();
        sendFrame(target, frameOf('pong'));
        break;
      case 'error':
        lastError = `服务端错误 ${String(frame.code ?? '?')}：${String(frame.message ?? '')}`;
        report('warn', `[dsh-notify-sender] ${lastError}`);
        break;
      default:
        report('debug', `[dsh-notify-sender] 忽略未知帧类型 ${String(frame.type)}`);
    }
  };

  const connect = () => {
    if (!running || stopping || socket) return;
    clearTimer(reconnectTimer);
    reconnectTimer = undefined;
    const settings = settingsNow();
    if (!settings.enabled) {
      setState('idle');
      return;
    }
    if (!hasActiveService(settings)) {
      if (!noServiceNotified) {
        noServiceNotified = true;
        report('info', '[dsh-notify-sender] 没有启用的服务，保持空闲（请在配置卡片新增并启用一条服务）');
      }
      setState('idle');
      return;
    }
    noServiceNotified = false;
    const wsUrl = String(settings.wsUrl ?? '').trim();
    if (!isWsUrl(wsUrl)) {
      lastError = `${serviceLabelOf(settings)}的 wsUrl 不是 ws(s) 地址：${wsUrl || '(空)'}`;
      report('warn', `[dsh-notify-sender] ${lastError}，已跳过连接`);
      scheduleReconnect();
      return;
    }
    setState('connecting');
    const headers = {};
    // 令牌只进握手头，不进 URL、不进日志。
    if (settings.token) headers.authorization = `Bearer ${settings.token}`;
    const connectTimeoutMs = numberIn(settings.connectTimeoutMs, 8000, 50, 120_000);
    let target;
    try {
      target = new WebSocketImpl(wsUrl, {
        headers,
        handshakeTimeout: connectTimeoutMs,
        maxPayload: MAX_FRAME_BYTES,
      });
    } catch (error) {
      lastError = `无法创建 WebSocket：${messageOf(error)}`;
      report('warn', `[dsh-notify-sender] ${lastError}`);
      scheduleReconnect();
      return;
    }
    socket = target;
    activeSignature = signatureOf(settings);

    // 连上之后 connectTimeoutMs 内必须收到 hello-ok，否则按握手超时断开。
    connectTimer = setTimer(() => {
      if (socket !== target || state === 'ready') return;
      lastError = state === 'hello' ? '握手超时：没有收到 hello-ok' : '连接超时：没能建立 WebSocket';
      report('warn', `[dsh-notify-sender] ${lastError}`);
      failSocket(target, CLOSE_HELLO_TIMEOUT, 'hello timeout');
    }, connectTimeoutMs);

    target.on('open', () => {
      if (socket !== target) return;
      if (stopping || !running) {
        try {
          target.close(CLOSE_NORMAL, 'bye');
        } catch {
          // 忽略
        }
        return;
      }
      setState('hello');
      sendHello(target);
    });

    target.on('message', (data) => {
      if (socket !== target) return;
      handleMessage(target, data);
    });

    // 服务端 ws 原生 ping/pong 也算连接还活着的证据。
    target.on('ping', () => {
      if (socket === target) lastPingAt = now();
    });
    target.on('pong', () => {
      if (socket === target) lastPongAt = now();
    });

    target.on('error', (error) => {
      if (socket !== target) return;
      const detail = messageOf(error);
      lastError = detail;
      const rejected = /401|403|Unexpected server response/i.test(detail);
      report(rejected ? 'warn' : 'debug', `[dsh-notify-sender] WebSocket 错误：${detail}`);
    });

    target.on('close', (code, reason) => {
      handleClose(target, code, reason?.toString?.('utf8') ?? '');
    });
  };

  const reconcile = () => {
    if (!running) return;
    const settings = settingsNow();
    if (!settings.enabled) {
      if (socket) {
        report('info', '[dsh-notify-sender] enabled 已关闭，断开 Coopanion 连接');
        closeGracefully(socket, 'disabled');
      }
      return;
    }
    // 没有启用的服务：不连接，也不安排重连（配置卡片里启用一条后会经巡检自动连上）。
    if (!hasActiveService(settings)) {
      if (!noServiceNotified) {
        noServiceNotified = true;
        report('info', '[dsh-notify-sender] 没有启用的服务，保持空闲（请在配置卡片新增并启用一条服务）');
      }
      clearTimer(reconnectTimer);
      reconnectTimer = undefined;
      if (socket) closeGracefully(socket, 'no active service');
      else setState('idle');
      return;
    }
    noServiceNotified = false;
    if (!socket && state === 'idle') {
      connect();
      return;
    }
    // 地址/令牌/设备名在 volatile 配置里改了：静默换一条连接。
    if (socket && state === 'ready' && signatureOf(settings) !== activeSignature) {
      report('info', `[dsh-notify-sender] 连接配置已变化（${serviceLabelOf(settings)}），重新连接`);
      attempt = 0;
      closeGracefully(socket, 'config changed');
    }
  };

  const start = () => {
    if (running) return;
    running = true;
    stopping = false;
    pruneTimer = setIntervalTimer(pruneQueue, Math.max(1000, Math.min(60_000, queueTtlMs)));
    // enabled / wsUrl / token 是 volatile 配置：不重载插件也可能变化，用轻量巡检兜住。
    reconcileTimer = setIntervalTimer(reconcile, 2000);
    reconcile();
  };

  const stop = async () => {
    running = false;
    stopping = true;
    clearAllTimers();
    reconnectTimer = undefined;
    connectTimer = undefined;
    heartbeatTimer = undefined;
    pruneTimer = undefined;
    reconcileTimer = undefined;
    stopHeartbeat();
    const target = socket;
    socket = undefined;
    activeSignature = undefined;
    if (!target) {
      setState('idle');
      stopping = false;
      return;
    }
    setState('closing');
    await new Promise((resolve) => {
      let settled = false;
      let force;
      const done = () => {
        if (settled) return;
        settled = true;
        if (force) clearTimer(force);
        resolve();
      };
      target.once('close', done);
      force = setTimer(() => {
        try {
          target.terminate();
        } catch {
          // 忽略
        }
        done();
      }, 500);
      if (target.readyState === OPEN) {
        sendFrame(target, frameOf('bye', { reason: 'shutdown' }));
        try {
          target.close(CLOSE_NORMAL, 'bye');
        } catch {
          done();
        }
      } else {
        try {
          target.terminate();
        } catch {
          // 忽略
        }
      }
    });
    setState('idle');
    stopping = false;
  };

  /** 入队一条通知；未连接时不丢，连上后按序补发。 */
  const sendTask = (payload) => {
    if (!payload || typeof payload !== 'object') return false;
    pruneQueue();
    const msgId = String(payload.msgId ?? '').trim();
    if (!msgId) {
      report('warn', '[dsh-notify-sender] 通知缺少 msgId，已忽略');
      return false;
    }
    if (queue.some((entry) => entry.msgId === msgId)) return true;
    if (queue.length >= queueMax) {
      const dropped = queue.shift();
      report('warn', `[dsh-notify-sender] 待发队列已满（${queueMax} 条），丢弃最早的通知 ${dropped?.msgId ?? ''}`);
    }
    const entry = {
      msgId,
      frame: buildTaskFrame(payload),
      queuedAt: now(),
      sentAt: null,
      acked: false,
    };
    queue.push(entry);
    if (state === 'ready' && socket) {
      sendFrame(socket, entry.frame);
      entry.sentAt = now();
    } else {
      report('debug', `[dsh-notify-sender] ws 未就绪，通知 ${msgId} 已入队（${queue.length} 条）`);
    }
    return true;
  };

  /** 状态快照：给配置页/排障用。 */
  const status = () => {
    const settings = settingsNow();
    const host = String(hostnameOf() ?? '').trim();
    return {
      state,
      connected: state === 'ready',
      pending: queue.length,
      attempts: attempt,
      wsUrl: String(settings.wsUrl ?? ''),
      activeServerId: String(settings.activeServerId ?? ''),
      activeServerLabel: String(settings.activeServerLabel ?? ''),
      deviceId: String(settings.deviceId || '').trim() || deriveDeviceId(host),
      deviceName: String(settings.device || '').trim() || host,
      connectedAt,
      lastAck,
      lastClose,
      lastError,
      server: serverInfo,
      heartbeatSec: heartbeatMs / 1000,
    };
  };

  return { start, stop, sendTask, status };
}
