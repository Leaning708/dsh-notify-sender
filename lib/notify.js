/**
 * 纯逻辑：读配置、判断要不要通知、从 session 事件里取标题与摘要、拼协议帧。
 * 不 import schemastery，也不碰 cordis，便于用 node --test 直接单测。
 *
 * 0.3.0 起不再有 HTTP 入口：这里只产出 `dsh-notify.ws.v1` 的 task 帧，
 * 连接、发送队列与重发都交给 lib/ws-client.js。
 */
import { createHash, randomUUID } from 'node:crypto';

/** ws 入口默认地址；旧配置迁移失败时也回退到这里。 */
export const DEFAULT_WS_URL = 'ws://127.0.0.1:3210/ws';

export const DEFAULTS = {
  enabled: false,
  // 多服务：0.3.1 起连接配置在 servers 里；wsUrl/token 只用于迁移旧配置。
  servers: [],
  wsUrl: DEFAULT_WS_URL,
  token: '',
  device: '',
  deviceId: '',
  notifyOnCompleted: true,
  notifyOnFailed: true,
  notifyMode: 'auto',
  minTurnMs: 0,
  maxSummaryChars: 600,
  acceptReplies: true,
  connectTimeoutMs: 8000,
  reconnectMinMs: 1000,
  reconnectMaxMs: 30000,
};

/** 配置字段可能是普通值，也可能是 volatile 字段的活引用（带 get()）。 */
export function readSetting(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'object' && typeof value.get === 'function') {
    const current = value.get();
    return current === undefined ? fallback : current;
  }
  return value;
}

function numberSetting(value, fallback, min, max) {
  const raw = Number(readSetting(value, fallback));
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

/**
 * 旧配置迁移：0.2 的 endpoint 是 `http://host:port/notify`，
 * 换成 0.3 的 `ws://host:port/ws`（https → wss，路径 /notify → /ws）。
 * 不能识别时返回空串，由调用方回退到默认地址。
 */
export function deriveWsUrlFromEndpoint(endpoint) {
  const raw = String(endpoint ?? '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const pathname = url.pathname || '/';
  let wsPath;
  if (pathname === '/' || pathname === '') wsPath = '/ws';
  else if (pathname.endsWith('/notify')) wsPath = `${pathname.slice(0, -'/notify'.length)}/ws`;
  else wsPath = '/ws';
  return `${protocol}//${url.host}${wsPath}`;
}

/** 旧配置（顶层 wsUrl/token）迁移出的服务 id / 名称。 */
export const LEGACY_SERVER_ID = 'legacy';
export const LEGACY_SERVER_LABEL = '默认';

/** 没有 id 的服务用 index+label 派生一个稳定 id（中文等非 ASCII 标签回退到序号）。 */
export function deriveServerId(index, label) {
  const slug = String(label ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return slug ? `server-${index + 1}-${slug}` : `server-${index + 1}`;
}

/**
 * 规范化 servers 数组，并选出唯一的活动服务：
 * - 非对象条目丢弃；缺 id 用 index+label 派生；缺 label 用「服务 N」；
 * - wsUrl 不是 ws(s) 的条目留在列表里（usable:false），但不能被启用；
 * - 多个 enabled 时取第一个，warnings 里给一条提示（由调用方去重后 warn 一次）；
 * - servers 为空且旧 wsUrl 非空时，迁移成一条启用的「默认」服务。
 *
 * 返回的 warnings 带 code（便于调用方去重），message 已经带插件前缀、不含令牌。
 */
export function normalizeServers(rawServers, legacy = {}) {
  const warnings = [];
  const servers = [];
  if (Array.isArray(rawServers)) {
    rawServers.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        warnings.push({
          code: 'invalid-server-entry',
          message: `[dsh-notify-sender] servers[${index}] 不是对象，已忽略`,
        });
        return;
      }
      const label = String(entry.label ?? '').trim() || `服务 ${index + 1}`;
      const id = String(entry.id ?? '').trim() || deriveServerId(index, label);
      const wsUrl = String(entry.wsUrl ?? '').trim();
      servers.push({
        id,
        label,
        wsUrl,
        token: String(entry.token ?? '').trim(),
        enabled: entry.enabled === true,
        usable: isWsUrl(wsUrl),
      });
    });
  } else if (rawServers !== undefined && rawServers !== null) {
    warnings.push({
      code: 'invalid-servers',
      message: '[dsh-notify-sender] servers 不是数组，已忽略',
    });
  }

  const legacyWsUrl = String(legacy.wsUrl ?? '').trim();
  const legacyToken = String(legacy.token ?? '').trim();
  let legacyFallback = false;
  if (servers.length === 0 && legacyWsUrl) {
    legacyFallback = true;
    servers.push({
      id: LEGACY_SERVER_ID,
      label: LEGACY_SERVER_LABEL,
      wsUrl: legacyWsUrl,
      token: legacyToken,
      enabled: true,
      usable: isWsUrl(legacyWsUrl),
      legacy: true,
    });
    warnings.push({
      code: 'legacy-server',
      message: `[dsh-notify-sender] 已把旧配置的 wsUrl=${legacyWsUrl} 当作服务「${LEGACY_SERVER_LABEL}」；建议在配置卡片里改用服务列表。`,
    });
  }

  const enabledServers = servers.filter((server) => server.enabled);
  for (const server of enabledServers) {
    if (server.usable) continue;
    warnings.push({
      code: 'invalid-server-url',
      id: server.id,
      message: `[dsh-notify-sender] 服务「${server.label}」的地址不是 ws(s)，已忽略：${server.wsUrl || '(空)'}`,
    });
  }
  const candidates = enabledServers.filter((server) => server.usable);
  if (candidates.length > 1) {
    warnings.push({
      code: 'multiple-enabled',
      message: `[dsh-notify-sender] 有 ${candidates.length} 个启用的服务，只使用第一个「${candidates[0].label}」`,
    });
  }

  return { servers, active: candidates[0], warnings, legacyFallback };
}

/** 把 apply(ctx, config) 收到的配置收成一份普通对象。 */
export function resolveSettings(config) {
  const source = config ?? {};
  const rawWsUrl = String(readSetting(source.wsUrl, '') ?? '').trim();
  // endpoint 自 0.3.0 起已废弃，仅保留读取用于把旧配置迁移成 wsUrl。
  const legacyEndpoint = String(readSetting(source.endpoint, '') ?? '').trim();
  const derivedWsUrl = deriveWsUrlFromEndpoint(legacyEndpoint);
  const wsUrlMigrated = !rawWsUrl && Boolean(derivedWsUrl);
  const legacyToken = String(readSetting(source.token, DEFAULTS.token) ?? '').trim();
  const {
    servers,
    active,
    warnings,
    legacyFallback,
  } = normalizeServers(readSetting(source.servers, DEFAULTS.servers), {
    wsUrl: rawWsUrl || derivedWsUrl,
    token: legacyToken,
  });
  const enabled = Boolean(readSetting(source.enabled, DEFAULTS.enabled));
  if (enabled && !active) {
    warnings.push({
      code: 'no-active-server',
      message: '[dsh-notify-sender] 「启用通知」已打开，但没有可用的服务；请到配置卡片新增并启用一条服务。',
    });
  }
  const reconnectMinMs = numberSetting(source.reconnectMinMs, DEFAULTS.reconnectMinMs, 10, 60_000);
  return {
    enabled,
    // wsUrl/token 指向活动服务，ws-client 继续只消费这两个字段。
    wsUrl: active ? active.wsUrl : '',
    wsUrlMigrated,
    legacyServer: legacyFallback,
    token: active ? active.token : '',
    servers,
    activeServerId: active ? active.id : '',
    activeServerLabel: active ? active.label : '',
    warnings,
    device: String(readSetting(source.device, DEFAULTS.device) ?? '').trim(),
    deviceId: String(readSetting(source.deviceId, DEFAULTS.deviceId) ?? '').trim(),
    notifyOnCompleted: Boolean(readSetting(source.notifyOnCompleted, DEFAULTS.notifyOnCompleted)),
    notifyOnFailed: Boolean(readSetting(source.notifyOnFailed, DEFAULTS.notifyOnFailed)),
    notifyMode: (() => {
      const mode = String(readSetting(source.notifyMode, DEFAULTS.notifyMode) ?? '');
      return mode === 'turn' || mode === 'goal' ? mode : 'auto';
    })(),
    minTurnMs: numberSetting(source.minTurnMs, DEFAULTS.minTurnMs, 0, 24 * 60 * 60 * 1000),
    maxSummaryChars: numberSetting(source.maxSummaryChars, DEFAULTS.maxSummaryChars, 80, 4000),
    acceptReplies: Boolean(readSetting(source.acceptReplies, DEFAULTS.acceptReplies)),
    connectTimeoutMs: numberSetting(source.connectTimeoutMs, DEFAULTS.connectTimeoutMs, 50, 120_000),
    reconnectMinMs,
    reconnectMaxMs: Math.max(
      reconnectMinMs,
      numberSetting(source.reconnectMaxMs, DEFAULTS.reconnectMaxMs, 10, 600_000),
    ),
  };
}

/** 只接受 ws(s) 地址；HTTP 地址说明用户还没迁移配置。 */
export function isWsUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'ws:' || url.protocol === 'wss:';
  } catch {
    return false;
  }
}

/** deviceId 留空时的默认值：主机名的 12 位 sha256 前缀，同机重装不变。 */
export function deriveDeviceId(name) {
  const value = String(name ?? '').trim() || 'dsh';
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

/** 从消息的 content 里取文本块；只取 text，不碰 reasoning 与工具调用。 */
export function textOfMessage(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export function truncate(text, limit) {
  const value = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!Number.isFinite(limit) || limit <= 0 || value.length <= limit) return value;
  return `${value.slice(0, limit)}…`;
}

const collapse = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * 这一轮任务的标题、最后回复摘要与耗时。
 * 标题取本轮 `turn/start` 之前最近一条 user/message（回合开始后注入的 steering 不算标题）；
 * 摘要取本轮最后一段有文本的 assistant/message。
 */
export function collectTurnContext(session, turn, maxSummaryChars, endedAt) {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
  let startIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const row = events[index];
    if (row?.type === 'turn/start' && row.data?.turn === turn) {
      startIndex = index;
      break;
    }
  }

  let title = '';
  if (startIndex > 0) {
    for (let index = startIndex - 1; index >= 0; index -= 1) {
      if (events[index]?.type === 'user/message') {
        title = collapse(textOfMessage(events[index].data));
        break;
      }
    }
  }

  let summary = '';
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const row = events[index];
    if (row?.type !== 'assistant/message' || row.data?.turn !== turn) continue;
    const text = textOfMessage(row.data.message);
    if (!text) continue;
    summary = text;
    break;
  }

  let durationMs;
  const startedAt = startIndex >= 0 ? events[startIndex]?.time : undefined;
  if (typeof startedAt === 'number' && typeof endedAt === 'number' && endedAt >= startedAt) {
    durationMs = Math.round(endedAt - startedAt);
  }
  return { title: truncate(title, 120), summary: truncate(summary, maxSummaryChars), durationMs };
}

/** 会话里最后一段有文本的 assistant 回复；goal 通知没有 turn 上下文时用它。 */
export function latestAssistantText(session, maxChars) {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const row = events[index];
    if (row?.type !== 'assistant/message') continue;
    const text = textOfMessage(row.data?.message);
    if (text) return truncate(text, maxChars);
  }
  return '';
}

/** 会话里最后一个 turn/end 的轮号；goal 事件没有轮号，只能取最近一次。 */
function lastTurnNumber(session) {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const row = events[index];
    if (row?.type === 'turn/end' && Number.isSafeInteger(row.data?.turn)) return row.data.turn;
  }
  return undefined;
}

/**
 * goal complete / block 的通知内容。complete 用最后回复摘要；block 优先用 blockedReason，
 * 没有时回退最后回复。
 */
export function buildGoalPayload(session, change, settings, options = {}) {
  const goal = change?.goal;
  if (!goal || (change.operation !== 'complete' && change.operation !== 'block')) return null;
  const blocked = change.operation === 'block';
  const summary = latestAssistantText(session, settings.maxSummaryChars);
  const reason = String(goal.blockedReason?.message ?? '').trim();
  const title = truncate(goal.objective, 120) || (blocked ? 'DSH 目标未完成' : 'DSH 目标完成');
  const payload = {
    msgId: options.msgId ?? randomUUID(),
    status: blocked ? 'failed' : 'completed',
    title,
    text: blocked ? (reason || summary) : summary,
    sessionId: String(session?.id ?? ''),
    at: new Date().toISOString(),
  };
  const turn = lastTurnNumber(session);
  if (turn !== undefined) payload.turn = turn;
  if (Number.isFinite(goal.createdAt)) {
    payload.durationMs = Math.max(0, Date.now() - goal.createdAt);
  }
  if (session?.header?.cwd) payload.cwd = session.header.cwd;
  return payload;
}

/**
 * 子代理会话不通知：0.3.2 起固定行为，没有开关。
 * subagent 的 header 上带 parentSession，主会话没有这个字段。
 */
export function isSubagentSession(session) {
  return Boolean(session?.header?.parentSession);
}

/** 这一条 turn/end 是否值得通知；不认识的原因（中断、fork、blocked）一律不打扰。 */
export function shouldNotify(session, event, settings) {
  if (!settings.enabled) return false;
  if (event?.type !== 'turn/end') return false;
  if (isSubagentSession(session)) return false;
  const kind = event.data?.reason?.kind;
  if (kind === 'completed') return settings.notifyOnCompleted;
  if (kind === 'error') return settings.notifyOnFailed;
  return false;
}

/** DSH -> Coopanion 的通知内容（task 帧的业务字段，不含公共字段）。 */
export function buildPayload(session, event, settings, options = {}) {
  const turn = event.data?.turn ?? 0;
  const context = collectTurnContext(session, turn, settings.maxSummaryChars, event.time);
  const kind = event.data?.reason?.kind;
  const failed = kind === 'error';
  const errorMessage = failed ? String(event.data?.reason?.error?.message ?? '').trim() : '';
  const payload = {
    msgId: options.msgId ?? randomUUID(),
    status: failed ? 'failed' : 'completed',
    title: context.title,
    text: failed ? errorMessage : context.summary,
    sessionId: String(session?.id ?? ''),
    turn,
    at: new Date().toISOString(),
  };
  if (context.durationMs !== undefined) payload.durationMs = context.durationMs;
  if (session?.header?.cwd) payload.cwd = session.header.cwd;
  return payload;
}

/**
 * 把 payload 收成 3.1 节的 task 帧：公共字段 `v`/`type`/`id`/`at` +
 * 表里列出的业务字段（`msgId`/`status`/`title`/`text`/`sessionId`/`turn?`/`durationMs?`/`cwd?`）。
 * 只发协议里有的字段，避免和 Coopanion 的校验器打架。
 */
export function buildTaskFrame(payload, options = {}) {
  const source = payload ?? {};
  const frame = {
    v: 1,
    type: 'task',
    id: options.id ?? randomUUID(),
    at: String(source.at ?? options.at ?? new Date().toISOString()),
    msgId: String(source.msgId ?? ''),
    status: source.status === 'failed' ? 'failed' : 'completed',
    title: String(source.title ?? ''),
    text: String(source.text ?? ''),
    sessionId: String(source.sessionId ?? ''),
  };
  if (Number.isSafeInteger(source.turn)) frame.turn = source.turn;
  if (Number.isFinite(source.durationMs)) frame.durationMs = source.durationMs;
  if (source.cwd) frame.cwd = String(source.cwd);
  return frame;
}
