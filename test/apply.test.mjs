import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { apply, Config } from '../index.js';
import { resolveSettings } from '../lib/notify.js';

const events = [
  { type: 'user/message', time: 1_000, data: { role: 'user', content: [{ type: 'text', text: '修复登录页' }] } },
  { type: 'turn/start', time: 1_000, data: { turn: 1 } },
  {
    type: 'assistant/message',
    time: 10_000,
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '测试全部通过' }] } },
  },
  { type: 'turn/end', time: 11_000, data: { turn: 1, reason: { kind: 'completed' } } },
];

const session = {
  id: 'session-1',
  header: { cwd: '/work' },
  snapshotEvents: () => events,
};

/** 子代理会话：header 上带 parentSession；0.3.2 起固定不通知。 */
const subagentSession = {
  ...session,
  id: 'session-sub',
  header: { cwd: '/work', parentSession: 'session-1' },
};

const turnEnd = events[3];

const goalView = (overrides = {}) => ({
  id: 'goal-1',
  revision: 1,
  objective: '把测试全部修到通过',
  phase: 'active',
  maxGoalRounds: 10,
  roundsStarted: 3,
  createdAt: Date.now() - 5_000,
  updatedAt: Date.now(),
  activation: 'armed',
  ...overrides,
});

const goalChange = (operation, overrides = {}) => ({
  agent: { id: 'session-1' },
  change: {
    operation,
    ref: { id: 'goal-1', revision: overrides.revision ?? 1 },
    goal: goalView(overrides),
  },
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeout = 3000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(interval);
  }
  return false;
}

const helloOkFrame = () => ({
  v: 1,
  type: 'hello-ok',
  id: 'hello-ok-1',
  at: new Date().toISOString(),
  serverVersion: '0.3.0',
  deviceId: 'coo-1',
  heartbeatSec: 30,
  limits: { maxFrameBytes: 65_536, maxReplyChars: 8000 },
});

/** 假的 Coopanion 服务端：收到 hello 就回 hello-ok，其余帧交给 onFrame。 */
function startServer(options = {}) {
  return new Promise((resolve) => {
    const state = { frames: [], hellos: [], headers: [], connections: 0, sockets: [], closes: [] };
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    wss.once('listening', () => {
      resolve({
        state,
        url: `ws://127.0.0.1:${wss.address().port}/ws`,
        close: () => new Promise((done) => {
          for (const socket of state.sockets) {
            try {
              socket.terminate();
            } catch {
              // 忽略
            }
          }
          wss.close(() => done());
        }),
      });
    });
    wss.on('connection', (socket, request) => {
      state.connections += 1;
      state.sockets.push(socket);
      state.headers.push(request.headers);
      socket.on('error', () => {});
      socket.on('close', (code) => state.closes.push(code));
      socket.on('message', (data) => {
        const frame = JSON.parse(data.toString('utf8'));
        state.frames.push(frame);
        if (frame.type === 'hello') {
          state.hellos.push(frame);
          socket.send(JSON.stringify(helloOkFrame()));
        }
        options.onFrame?.(frame, socket, state);
      });
    });
  });
}

/** 假的根上下文：记录 on() 的注册与 effect 清理，测试里手动触发。 */
function makeContext() {
  const listeners = new Map();
  const effects = [];
  const sessions = new Map();
  const prompts = [];
  const warns = [];
  const ctx = {
    logger: { warn: (message) => warns.push(String(message)), info() {}, debug() {} },
    sessionController: {
      prompt: async (request) => {
        prompts.push(request);
        return { accepted: true };
      },
    },
    sessions: { get: (id) => sessions.get(id) },
    effect(callback) {
      const disposer = callback();
      if (typeof disposer === 'function') effects.push(disposer);
      return disposer;
    },
    on(name, callback, options) {
      listeners.set(name, { callback, options });
      return () => listeners.delete(name);
    },
  };
  return {
    ctx,
    sessions,
    prompts,
    warns,
    emit(name, ...args) {
      const entry = listeners.get(name);
      assert.ok(entry, `没有注册 ${name} 监听`);
      return entry.callback(...args);
    },
    options(name) {
      return listeners.get(name)?.options;
    },
    async dispose() {
      while (effects.length) {
        try {
          await effects.pop()();
        } catch {
          // 清理失败不掩盖测试结果
        }
      }
    },
  };
}

test('Config 暴露 0.3 的 ws 配置字段，旧的入站回传字段已删除', () => {
  const config = Config({});
  const keys = Object.keys(config);
  for (const key of [
    'enabled', 'servers', 'wsUrl', 'token', 'device', 'deviceId', 'acceptReplies',
    'notifyOnCompleted', 'notifyOnFailed', 'notifyMode',
    'minTurnMs', 'maxSummaryChars', 'connectTimeoutMs', 'reconnectMinMs', 'reconnectMaxMs',
  ]) {
    assert.ok(keys.includes(key), `缺少配置项 ${key}`);
  }
  assert.ok(!keys.includes('includeSubagents'), 'includeSubagents 应该删除');
  assert.deepEqual(config.servers.get(), []);
  assert.equal(config.wsUrl.get(), '');
  assert.equal(config.acceptReplies.get(), true);
  assert.equal(config.connectTimeoutMs.get(), 8000);
  assert.equal(config.reconnectMinMs.get(), 1000);
  assert.equal(config.reconnectMaxMs.get(), 30_000);
  for (const removed of ['timeoutMs', 'replyEnabled', 'replyHost', 'replyPort', 'includeSubagents']) {
    assert.ok(!keys.includes(removed), `配置项 ${removed} 应该删除`);
  }
  // endpoint 只是迁移用的隐藏兼容键，默认空
  assert.equal(config.endpoint.get(), '');

  // 走一遍真实的 Config 输出，确认旧 endpoint 能迁移成 wsUrl
  const migrated = resolveSettings(Config({ endpoint: 'http://127.0.0.1:3210/notify' }));
  assert.equal(migrated.wsUrl, 'ws://127.0.0.1:3210/ws');
  assert.equal(migrated.wsUrlMigrated, true);

  // servers 数组按 schema 校验后能完整取回，并成为活动服务
  const configured = Config({
    servers: [
      { id: 'home', label: '家里', wsUrl: 'ws://192.168.1.20:3210/ws', token: 'tok', enabled: true },
      { id: 'office', label: '公司', wsUrl: 'wss://coop.example.com/ws', token: '', enabled: false },
    ],
  });
  assert.deepEqual(configured.servers.get(), [
    { id: 'home', label: '家里', wsUrl: 'ws://192.168.1.20:3210/ws', token: 'tok', enabled: true },
    { id: 'office', label: '公司', wsUrl: 'wss://coop.example.com/ws', token: '', enabled: false },
  ]);
  const resolved = resolveSettings(configured);
  assert.equal(resolved.activeServerId, 'home');
  assert.equal(resolved.activeServerLabel, '家里');
  assert.equal(resolved.wsUrl, 'ws://192.168.1.20:3210/ws');
  assert.equal(resolved.token, 'tok');
});

test('turn/end 时通过 WebSocket 发 hello + task 帧', { timeout: 10_000 }, async () => {
  const server = await startServer();
  const { ctx, emit, options, dispose } = makeContext();
  apply(ctx, {
    enabled: true,
    wsUrl: server.url,
    token: 'secret',
    device: 'dev-box',
    notifyOnCompleted: true,
  });
  try {
    assert.deepEqual(options('session/event'), { global: true });
    emit('session/event', session, turnEnd);
    assert.ok(await waitFor(() => server.state.frames.some((frame) => frame.type === 'task')), '没有收到 task 帧');

    const task = server.state.frames.find((frame) => frame.type === 'task');
    assert.equal(task.v, 1);
    assert.equal(task.status, 'completed');
    assert.equal(task.title, '修复登录页');
    assert.equal(task.text, '测试全部通过');
    assert.equal(task.durationMs, 10_000);
    assert.equal(task.turn, 1);
    assert.equal(task.sessionId, 'session-1');
    assert.equal(task.cwd, '/work');
    assert.match(task.msgId, /^[0-9a-f]{8}-/);
    assert.match(task.id, /^[0-9a-f]{8}-/);
    assert.equal(task.device, undefined);
    assert.equal(task.version, undefined);

    const hello = server.state.hellos[0];
    assert.equal(hello.v, 1);
    assert.equal(hello.client, 'dsh');
    assert.equal(hello.deviceName, 'dev-box');
    assert.match(hello.deviceId, /^[0-9a-f]{12}$/);
    assert.equal(hello.clientVersion, '0.3.3');
    assert.deepEqual(hello.features, ['reply', 'ack']);
    assert.equal(hello.token, undefined, '令牌不应该进 hello 帧');
    assert.equal(server.state.headers[0].authorization, 'Bearer secret');
  } finally {
    await dispose();
    await server.close();
  }
});

test('同一个 turn 重复的 turn/end 只发一次', { timeout: 10_000 }, async () => {
  const server = await startServer();
  const { ctx, emit, dispose } = makeContext();
  apply(ctx, { enabled: true, wsUrl: server.url, device: 'dev-box' });
  try {
    emit('session/event', session, turnEnd);
    emit('session/event', session, turnEnd);
    assert.ok(await waitFor(() => server.state.frames.some((frame) => frame.type === 'task')));
    await delay(100);
    assert.equal(server.state.frames.filter((frame) => frame.type === 'task').length, 1);
  } finally {
    await dispose();
    await server.close();
  }
});

test('子代理会话不通知：每轮与 goal 都跳过（includeSubagents 已删除）', { timeout: 10_000 }, async () => {
  const server = await startServer();
  const { ctx, sessions, emit, dispose } = makeContext();
  sessions.set('session-1', subagentSession);
  // 旧配置里残留的 includeSubagents 不再有任何效果
  apply(ctx, { enabled: true, wsUrl: server.url, device: 'dev-box', includeSubagents: true });
  try {
    emit('session/event', subagentSession, turnEnd);
    emit('goal/changed', goalChange('complete', { phase: 'complete', revision: 2 }));
    await delay(200);
    assert.equal(server.state.frames.filter((frame) => frame.type === 'task').length, 0);
  } finally {
    await dispose();
    await server.close();
  }
});

test('enabled 为 false 时不连接也不发', { timeout: 10_000 }, async () => {
  const server = await startServer();
  const { ctx, emit, dispose } = makeContext();
  apply(ctx, { enabled: false, wsUrl: server.url });
  try {
    emit('session/event', session, turnEnd);
    await delay(150);
    assert.equal(server.state.connections, 0);
    assert.equal(server.state.frames.length, 0);
  } finally {
    await dispose();
    await server.close();
  }
});

test('goal 模式：只在 complete/block 时通知', { timeout: 10_000 }, async () => {
  const server = await startServer();
  const { ctx, sessions, emit, dispose } = makeContext();
  sessions.set('session-1', session);
  apply(ctx, { enabled: true, wsUrl: server.url, device: 'dev-box', notifyMode: 'goal' });
  try {
    emit('goal/changed', goalChange('complete', { phase: 'complete', revision: 2 }));
    assert.ok(await waitFor(() => server.state.frames.some((frame) => frame.type === 'task')));
    const first = server.state.frames.find((frame) => frame.type === 'task');
    assert.equal(first.status, 'completed');
    assert.equal(first.title, '把测试全部修到通过');
    assert.equal(first.text, '测试全部通过');

    emit('session/event', session, turnEnd);
    await delay(100);
    assert.equal(server.state.frames.filter((frame) => frame.type === 'task').length, 1);
  } finally {
    await dispose();
    await server.close();
  }
});

test('goal 模式：blocked 发失败通知并带原因', { timeout: 10_000 }, async () => {
  const server = await startServer();
  const { ctx, sessions, emit, dispose } = makeContext();
  sessions.set('session-1', session);
  apply(ctx, { enabled: true, wsUrl: server.url, device: 'dev-box', notifyMode: 'goal' });
  try {
    emit('goal/changed', goalChange('block', {
      phase: 'blocked',
      revision: 3,
      blockedReason: { code: 'stalled', message: '连续三轮没有进展' },
    }));
    assert.ok(await waitFor(() => server.state.frames.some((frame) => frame.type === 'task')));
    const task = server.state.frames.find((frame) => frame.type === 'task');
    assert.equal(task.status, 'failed');
    assert.equal(task.text, '连续三轮没有进展');
  } finally {
    await dispose();
    await server.close();
  }
});

test('auto 模式：活跃 goal 时中间轮静默，goal 结束只发一条', { timeout: 10_000 }, async () => {
  const server = await startServer();
  const { ctx, sessions, emit, dispose } = makeContext();
  sessions.set('session-1', session);
  apply(ctx, { enabled: true, wsUrl: server.url, device: 'dev-box', notifyMode: 'auto' });
  try {
    emit('goal/changed', goalChange('create', { phase: 'active', revision: 1 }));
    emit('session/event', session, turnEnd);
    await delay(100);
    assert.equal(server.state.frames.filter((frame) => frame.type === 'task').length, 0);

    emit('goal/changed', goalChange('complete', { phase: 'complete', revision: 2 }));
    assert.ok(await waitFor(() => server.state.frames.some((frame) => frame.type === 'task')));
    assert.equal(server.state.frames.filter((frame) => frame.type === 'task').length, 1);

    // 最终 turn/end 可能晚于 goal 事件；10 秒窗口内不再发第二条。
    await delay(50);
    emit('session/event', session, { ...turnEnd, data: { ...turnEnd.data, turn: 2 } });
    await delay(100);
    assert.equal(server.state.frames.filter((frame) => frame.type === 'task').length, 1);
  } finally {
    await dispose();
    await server.close();
  }
});

test('auto 模式：没有 goal 时按轮通知', { timeout: 10_000 }, async () => {
  const server = await startServer();
  const { ctx, emit, dispose } = makeContext();
  apply(ctx, { enabled: true, wsUrl: server.url, device: 'dev-box', notifyMode: 'auto' });
  try {
    emit('session/event', session, turnEnd);
    assert.ok(await waitFor(() => server.state.frames.some((frame) => frame.type === 'task')));
  } finally {
    await dispose();
    await server.close();
  }
});

test('turn 模式：有活跃 goal 也照常每轮通知', { timeout: 10_000 }, async () => {
  const server = await startServer();
  const { ctx, sessions, emit, dispose } = makeContext();
  sessions.set('session-1', session);
  apply(ctx, { enabled: true, wsUrl: server.url, device: 'dev-box', notifyMode: 'turn' });
  try {
    emit('goal/changed', goalChange('create', { phase: 'active', revision: 1 }));
    emit('session/event', session, turnEnd);
    assert.ok(await waitFor(() => server.state.frames.some((frame) => frame.type === 'task')));
  } finally {
    await dispose();
    await server.close();
  }
});

test('reply 帧注入原会话并回 reply-result', { timeout: 10_000 }, async () => {
  const server = await startServer();
  const { ctx, prompts, dispose } = makeContext();
  apply(ctx, { enabled: true, wsUrl: server.url, device: 'dev-box', acceptReplies: true });
  try {
    assert.ok(await waitFor(() => server.state.connections > 0 && server.state.frames.some((frame) => frame.type === 'hello')));
    const socket = server.state.sockets[0];
    const reply = {
      v: 1,
      type: 'reply',
      id: 'reply-frame-1',
      at: new Date().toISOString(),
      replyId: 'reply-1',
      taskId: 'msg-1',
      sessionId: 'session-42',
      text: '把测试也跑一下',
    };
    socket.send(JSON.stringify(reply));
    assert.ok(await waitFor(() => server.state.frames.some((frame) => frame.type === 'reply-result')));

    const result = server.state.frames.find((frame) => frame.type === 'reply-result');
    assert.equal(result.replyId, 'reply-1');
    assert.equal(result.ok, true);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].requestId, 'reply-1');
    assert.equal(prompts[0].sessionId, 'session-42');
    assert.equal(prompts[0].mode, 'queue');
    assert.deepEqual(prompts[0].content, [{ type: 'text', text: '把测试也跑一下' }]);
  } finally {
    await dispose();
    await server.close();
  }
});

test('acceptReplies 关闭时回 reply-result 失败', { timeout: 10_000 }, async () => {
  const server = await startServer();
  const { ctx, prompts, dispose } = makeContext();
  apply(ctx, { enabled: true, wsUrl: server.url, device: 'dev-box', acceptReplies: false });
  try {
    assert.ok(await waitFor(() => server.state.sockets.length > 0 && server.state.frames.some((frame) => frame.type === 'hello')));
    server.state.sockets[0].send(JSON.stringify({
      v: 1,
      type: 'reply',
      id: 'reply-frame-2',
      at: new Date().toISOString(),
      replyId: 'reply-2',
      taskId: 'msg-1',
      sessionId: 'session-42',
      text: '继续',
    }));
    assert.ok(await waitFor(() => server.state.frames.some((frame) => frame.type === 'reply-result')));
    const result = server.state.frames.find((frame) => frame.type === 'reply-result');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'replies disabled');
    assert.equal(prompts.length, 0);
  } finally {
    await dispose();
    await server.close();
  }
});

test('插件清理时发 bye 并正常关闭连接', { timeout: 10_000 }, async () => {
  const server = await startServer();
  const { ctx, dispose } = makeContext();
  apply(ctx, { enabled: true, wsUrl: server.url, device: 'dev-box' });
  try {
    assert.ok(await waitFor(() => server.state.frames.some((frame) => frame.type === 'hello')));
    await dispose();
    assert.ok(await waitFor(() => server.state.closes.includes(1000)), `关闭码为 ${server.state.closes.join(',')}`);
    const bye = server.state.frames.find((frame) => frame.type === 'bye');
    assert.ok(bye, '没有收到 bye 帧');
    assert.equal(bye.reason, 'shutdown');
  } finally {
    await server.close();
  }
});

test('apply 直接接 Config 输出：活动服务与令牌经 volatile 引用生效', { timeout: 10_000 }, async () => {
  const server = await startServer();
  const { ctx, emit, dispose } = makeContext();
  apply(ctx, Config({
    enabled: true,
    servers: [
      { id: 'home', label: '家里', wsUrl: server.url, token: 'config-token', enabled: true },
      { id: 'office', label: '公司', wsUrl: 'ws://127.0.0.1:1/ws', token: 'other-token', enabled: false },
    ],
    device: 'dev-box',
  }));
  try {
    assert.ok(await waitFor(() => server.state.frames.some((frame) => frame.type === 'hello')));
    assert.equal(server.state.headers[0].authorization, 'Bearer config-token');
    emit('session/event', session, turnEnd);
    assert.ok(await waitFor(() => server.state.frames.some((frame) => frame.type === 'task')));
  } finally {
    await dispose();
    await server.close();
  }
});

test('多服务：只连第一条启用的服务，多个 enabled 只 warn 一次', { timeout: 10_000 }, async () => {
  const home = await startServer();
  const office = await startServer();
  const { ctx, emit, warns, dispose } = makeContext();
  apply(ctx, {
    enabled: true,
    servers: [
      { id: 'home', label: '家里', wsUrl: home.url, token: 'token-home', enabled: true },
      { id: 'office', label: '公司', wsUrl: office.url, token: 'token-office', enabled: true },
    ],
  });
  try {
    assert.ok(await waitFor(() => home.state.frames.some((frame) => frame.type === 'hello')), '没有连到第一条启用的服务');
    assert.equal(home.state.headers[0].authorization, 'Bearer token-home');
    await delay(120);
    assert.equal(office.state.connections, 0, '第二条服务不应该被连接');
    assert.equal(home.state.connections, 1);

    // 多次触发 settingsNow 也只提示一次
    emit('session/event', session, turnEnd);
    const multiple = warns.filter((message) => /只使用第一个/.test(message));
    assert.equal(multiple.length, 1, `warn 了 ${multiple.length} 次：${warns.join(' | ')}`);
    assert.ok(!warns.some((message) => /token-(home|office)/.test(message)), '令牌不能进日志');
  } finally {
    await dispose();
    await home.close();
    await office.close();
  }
});

test('多服务：切换启用项后静默重连到新服务', { timeout: 10_000 }, async () => {
  const home = await startServer();
  const office = await startServer();
  const { ctx, dispose } = makeContext();
  const config = {
    enabled: true,
    servers: [
      { id: 'home', label: '家里', wsUrl: home.url, token: '', enabled: true },
      { id: 'office', label: '公司', wsUrl: office.url, token: '', enabled: false },
    ],
  };
  apply(ctx, config);
  try {
    assert.ok(await waitFor(() => home.state.frames.some((frame) => frame.type === 'hello')));
    assert.equal(office.state.connections, 0);

    // 模拟配置卡片保存后 servers 的 enabled 交换
    config.servers[0].enabled = false;
    config.servers[1].enabled = true;

    assert.ok(await waitFor(() => office.state.frames.some((frame) => frame.type === 'hello'), { timeout: 6000 }), '没有重连到新服务');
    const bye = home.state.frames.find((frame) => frame.type === 'bye');
    assert.ok(bye, '旧连接没有收到 bye');
    assert.equal(bye.reason, 'config changed');
  } finally {
    await dispose();
    await home.close();
    await office.close();
  }
});

test('多服务：没有启用的服务时不连接，只提示一次', { timeout: 10_000 }, async () => {
  const server = await startServer();
  const { ctx, warns, emit, dispose } = makeContext();
  apply(ctx, {
    enabled: true,
    servers: [
      { id: 'home', label: '家里', wsUrl: server.url, token: '', enabled: false },
    ],
  });
  try {
    emit('session/event', session, turnEnd);
    await delay(200);
    assert.equal(server.state.connections, 0);
    const noActive = warns.filter((message) => /没有可用的服务/.test(message));
    assert.equal(noActive.length, 1, `warn 了 ${noActive.length} 次：${warns.join(' | ')}`);
  } finally {
    await dispose();
    await server.close();
  }
});
