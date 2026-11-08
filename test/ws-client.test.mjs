import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { createWsClient } from '../lib/ws-client.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeout = 4000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(interval);
  }
  throw new Error('waitFor 超时');
}

function settingsOf(overrides = {}) {
  return {
    enabled: true,
    wsUrl: '',
    activeServerId: 'server-1',
    activeServerLabel: '默认',
    token: 'secret-token',
    device: 'dev-box',
    deviceId: 'device-abc123',
    acceptReplies: true,
    connectTimeoutMs: 300,
    reconnectMinMs: 30,
    reconnectMaxMs: 300,
    ...overrides,
  };
}

const taskPayload = (msgId) => ({
  msgId,
  status: 'completed',
  title: `标题 ${msgId}`,
  text: '测试全部通过',
  sessionId: 'session-1',
  turn: 1,
  at: new Date().toISOString(),
});

const ackFrame = (ref) => ({
  v: 1,
  type: 'ack',
  id: `ack-${ref}`,
  at: new Date().toISOString(),
  ref,
  cursor: 1,
  duplicate: false,
});

const helloOkFrame = (heartbeatSec = 30) => ({
  v: 1,
  type: 'hello-ok',
  id: 'hello-ok-1',
  at: new Date().toISOString(),
  serverVersion: '0.3.0',
  deviceId: 'coo-1',
  heartbeatSec,
  limits: { maxFrameBytes: 65_536, maxReplyChars: 8000 },
});

/** 假 Coopanion 服务端：默认收到 hello 就回 hello-ok，其余帧交给 onFrame。 */
function startServer(options = {}) {
  return new Promise((resolve) => {
    const state = { frames: [], sessions: [], closes: [], headers: [] };
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: options.port ?? 0,
      ...(options.verifyClient ? { verifyClient: options.verifyClient } : {}),
    });
    wss.once('listening', () => {
      const { port } = wss.address();
      resolve({
        wss,
        port,
        url: `ws://127.0.0.1:${port}/ws`,
        state,
        close: () => new Promise((done) => {
          for (const session of state.sessions) {
            try {
              session.socket.terminate();
            } catch {
              // 忽略
            }
          }
          wss.close(() => done());
        }),
      });
    });
    wss.on('connection', (socket, request) => {
      const session = {
        socket,
        request,
        frames: [],
        closeCode: undefined,
        closeReason: '',
        openedAt: Date.now(),
      };
      state.sessions.push(session);
      state.headers.push(request.headers);
      socket.on('error', () => {});
      socket.on('close', (code, reason) => {
        session.closeCode = code;
        session.closeReason = reason.toString('utf8');
        state.closes.push(code);
      });
      socket.on('message', (data) => {
        let frame;
        try {
          frame = JSON.parse(data.toString('utf8'));
        } catch {
          return;
        }
        session.frames.push(frame);
        state.frames.push(frame);
        if (frame.type === 'hello' && options.autoHello !== false) {
          socket.send(JSON.stringify(helloOkFrame(options.heartbeatSec ?? 30)));
        }
        options.onFrame?.(frame, socket, session, state);
      });
      options.onConnection?.(socket, request, session, state);
    });
  });
}

function makeClient(settings, options = {}) {
  const logs = [];
  const prompts = [];
  const client = createWsClient({
    getSettings: () => settings,
    clientVersion: '0.3.3',
    prompt: options.prompt ?? (async (request) => {
      prompts.push(request);
    }),
    log: (level, message) => logs.push({ level, message }),
    ...(options.clientOptions ?? {}),
  });
  return { client, logs, prompts };
}

const isTask = (frame) => frame.type === 'task';
const isReplyResult = (frame) => frame.type === 'reply-result';

test('握手成功：hello 带令牌头与设备信息，收到 hello-ok 才算 ready', { timeout: 10_000 }, async () => {
  const server = await startServer();
  const { client, logs } = makeClient(settingsOf({ wsUrl: server.url }));
  client.start();
  try {
    await waitFor(() => client.status().state === 'ready');
    const hello = server.state.frames.find((frame) => frame.type === 'hello');
    assert.ok(hello, '没有收到 hello 帧');
    assert.equal(hello.v, 1);
    assert.equal(hello.type, 'hello');
    assert.equal(hello.deviceId, 'device-abc123');
    assert.equal(hello.deviceName, 'dev-box');
    assert.equal(hello.client, 'dsh');
    assert.equal(hello.clientVersion, '0.3.3');
    assert.deepEqual(hello.features, ['reply', 'ack']);
    assert.equal(hello.token, undefined, '令牌不应该进 hello 帧');
    assert.equal(server.state.headers[0].authorization, 'Bearer secret-token');

    const status = client.status();
    assert.equal(status.connected, true);
    assert.equal(status.pending, 0);
    assert.equal(status.server.serverVersion, '0.3.0');
    assert.equal(status.heartbeatSec, 30);
    // 令牌绝不进日志
    assert.ok(!logs.some((entry) => entry.message.includes('secret-token')));
  } finally {
    await client.stop();
    await server.close();
  }
});

test('令牌被拒：401 后不 ready，按退避继续重试', { timeout: 10_000 }, async () => {
  const server = await startServer({
    verifyClient: (info, done) => {
      const ok = info.req.headers.authorization === 'Bearer secret-token';
      done(ok, ok ? undefined : 401, 'Unauthorized');
    },
  });
  const { client, logs } = makeClient(settingsOf({
    wsUrl: server.url,
    token: 'wrong-token',
    reconnectMinMs: 20,
    reconnectMaxMs: 60,
  }));
  client.start();
  try {
    await waitFor(() => logs.some((entry) => entry.level === 'warn' && /401/.test(entry.message)));
    assert.notEqual(client.status().state, 'ready');
    assert.equal(client.status().connected, false);
    assert.equal(server.state.sessions.length, 0);
    await waitFor(() => client.status().attempts >= 2);
    assert.ok(!logs.some((entry) => entry.message.includes('wrong-token')));
  } finally {
    await client.stop();
    await server.close();
  }
});

test('hello 超时：没收到 hello-ok 时主动 close(4408) 并重连', { timeout: 10_000 }, async () => {
  const server = await startServer({ autoHello: false });
  const { client } = makeClient(settingsOf({
    wsUrl: server.url,
    connectTimeoutMs: 100,
    reconnectMinMs: 50,
    reconnectMaxMs: 100,
  }));
  client.start();
  try {
    await waitFor(() => server.state.closes.includes(4408));
    assert.equal(server.state.sessions[0].closeCode, 4408);
    assert.match(String(client.status().lastError), /握手超时/);
    await waitFor(() => server.state.sessions.length >= 2);
  } finally {
    await client.stop();
    await server.close();
  }
});

test('退避重连：间隔按 2 倍递增', { timeout: 10_000 }, async () => {
  const server = await startServer({ onConnection: (socket) => socket.terminate() });
  const { client } = makeClient(settingsOf({
    wsUrl: server.url,
    reconnectMinMs: 30,
    reconnectMaxMs: 300,
  }));
  client.start();
  try {
    await waitFor(() => server.state.sessions.length >= 4, { timeout: 5000 });
    const times = server.state.sessions.map((session) => session.openedAt);
    const first = times[1] - times[0];
    const second = times[2] - times[1];
    const third = times[3] - times[2];
    assert.ok(second > first, `重连间隔没有递增：${first} → ${second}`);
    assert.ok(third > second, `重连间隔没有递增：${second} → ${third}`);
    assert.ok(client.status().attempts >= 3);
  } finally {
    await client.stop();
    await server.close();
  }
});

test('心跳：收到 ping 回 pong，并按 hello-ok 使用服务端心跳间隔', { timeout: 10_000 }, async () => {
  const server = await startServer({ heartbeatSec: 0.5 });
  const { client } = makeClient(settingsOf({ wsUrl: server.url }));
  client.start();
  try {
    await waitFor(() => client.status().state === 'ready');
    assert.equal(client.status().heartbeatSec, 0.5);
    server.state.sessions[0].socket.send(JSON.stringify({
      v: 1,
      type: 'ping',
      id: 'ping-1',
      at: new Date().toISOString(),
      ts: Date.now(),
    }));
    await waitFor(() => server.state.frames.some((frame) => frame.type === 'pong'));
    const pong = server.state.frames.find((frame) => frame.type === 'pong');
    assert.equal(pong.v, 1);
  } finally {
    await client.stop();
    await server.close();
  }
});

test('心跳超时：连续 2 个周期没有 ping 就主动断开重连', { timeout: 10_000 }, async () => {
  const server = await startServer({ heartbeatSec: 0.05 });
  const { client, logs } = makeClient(settingsOf({ wsUrl: server.url, reconnectMinMs: 20 }));
  client.start();
  try {
    await waitFor(() => server.state.sessions.length >= 2);
    assert.ok(server.state.closes.includes(1013), `关闭码为 ${server.state.closes.join(',')}`);
    assert.ok(logs.some((entry) => /心跳超时/.test(entry.message)));
  } finally {
    await client.stop();
    await server.close();
  }
});

test('队列：连接失败期间不丢，服务端起来后按序补发', { timeout: 15_000 }, async () => {
  const probe = await startServer();
  const port = probe.port;
  await probe.close();

  const { client } = makeClient(settingsOf({
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    connectTimeoutMs: 200,
    reconnectMinMs: 40,
    reconnectMaxMs: 80,
  }));
  client.start();
  let server;
  try {
    client.sendTask(taskPayload('msg-1'));
    client.sendTask(taskPayload('msg-2'));
    assert.equal(client.status().pending, 2);
    // 几次连接失败之后队列还在
    await delay(120);
    assert.equal(client.status().pending, 2);

    server = await startServer({
      port,
      onFrame: (frame, socket) => {
        if (isTask(frame)) socket.send(JSON.stringify(ackFrame(frame.msgId)));
      },
    });
    await waitFor(() => server.state.frames.filter(isTask).length === 2);
    assert.deepEqual(server.state.frames.filter(isTask).map((frame) => frame.msgId), ['msg-1', 'msg-2']);
    await waitFor(() => client.status().pending === 0);
  } finally {
    await client.stop();
    if (server) await server.close();
  }
});

test('ack 后出队并记录最近 ack', { timeout: 10_000 }, async () => {
  const server = await startServer({
    onFrame: (frame, socket) => {
      if (isTask(frame)) socket.send(JSON.stringify(ackFrame(frame.msgId)));
    },
  });
  const { client } = makeClient(settingsOf({ wsUrl: server.url }));
  client.start();
  try {
    await waitFor(() => client.status().state === 'ready');
    client.sendTask(taskPayload('msg-ack'));
    await waitFor(() => client.status().pending === 0);
    assert.equal(client.status().lastAck.ref, 'msg-ack');
    assert.equal(client.status().lastAck.cursor, 1);
    assert.equal(client.status().lastAck.duplicate, false);
  } finally {
    await client.stop();
    await server.close();
  }
});

test('重连后重发未 ack 的帧，msgId 与帧 id 都不变', { timeout: 10_000 }, async () => {
  let tasks = 0;
  const server = await startServer({
    onFrame: (frame, socket) => {
      if (!isTask(frame)) return;
      tasks += 1;
      if (tasks === 1) {
        // 第一次：收到了但不 ack，直接断线
        socket.terminate();
        return;
      }
      socket.send(JSON.stringify(ackFrame(frame.msgId)));
    },
  });
  const { client } = makeClient(settingsOf({
    wsUrl: server.url,
    reconnectMinMs: 30,
    reconnectMaxMs: 100,
  }));
  client.start();
  try {
    await waitFor(() => client.status().state === 'ready');
    client.sendTask(taskPayload('msg-resend'));
    await waitFor(() => server.state.frames.filter(isTask).length >= 2);
    const frames = server.state.frames.filter(isTask);
    assert.equal(frames[0].msgId, 'msg-resend');
    assert.equal(frames[1].msgId, 'msg-resend');
    assert.equal(frames[1].id, frames[0].id);
    await waitFor(() => client.status().pending === 0);
  } finally {
    await client.stop();
    await server.close();
  }
});

test('reply 注入 + reply-result，replyId 去重', { timeout: 10_000 }, async () => {
  const server = await startServer();
  const { client, prompts } = makeClient(settingsOf({ wsUrl: server.url }));
  client.start();
  try {
    await waitFor(() => client.status().state === 'ready');
    const socket = server.state.sessions[0].socket;
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
    await waitFor(() => server.state.frames.some(isReplyResult));
    const first = server.state.frames.find(isReplyResult);
    assert.equal(first.replyId, 'reply-1');
    assert.equal(first.ok, true);
    assert.deepEqual(prompts, [{
      requestId: 'reply-1',
      sessionId: 'session-42',
      text: '把测试也跑一下',
      taskId: 'msg-1',
    }]);

    // 同一个 replyId 重发：不再注入，但仍回 ok 让服务端停止重试
    socket.send(JSON.stringify(reply));
    await waitFor(() => server.state.frames.filter(isReplyResult).length >= 2);
    assert.equal(prompts.length, 1);
    assert.equal(server.state.frames.filter(isReplyResult)[1].ok, true);
  } finally {
    await client.stop();
    await server.close();
  }
});

test('注入失败：回 ok:false，且不缓存去重键（重发会再试）', { timeout: 10_000 }, async () => {
  const server = await startServer();
  let attempts = 0;
  const client = createWsClient({
    getSettings: () => settingsOf({ wsUrl: server.url }),
    prompt: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('session not found');
    },
    log: () => {},
  });
  client.start();
  try {
    await waitFor(() => client.status().state === 'ready');
    const socket = server.state.sessions[0].socket;
    const reply = {
      v: 1,
      type: 'reply',
      id: 'reply-frame-2',
      at: new Date().toISOString(),
      replyId: 'reply-retry',
      taskId: 'msg-1',
      sessionId: 'session-missing',
      text: '试试',
    };
    socket.send(JSON.stringify(reply));
    await waitFor(() => server.state.frames.some(isReplyResult));
    const failed = server.state.frames.find(isReplyResult);
    assert.equal(failed.ok, false);
    assert.match(failed.error, /session not found/);

    socket.send(JSON.stringify(reply));
    await waitFor(() => server.state.frames.filter(isReplyResult).length >= 2);
    const retried = server.state.frames.filter(isReplyResult)[1];
    assert.equal(retried.ok, true);
    assert.equal(attempts, 2);
  } finally {
    await client.stop();
    await server.close();
  }
});

test('acceptReplies:false 时直接回 reply-result 失败', { timeout: 10_000 }, async () => {
  const server = await startServer();
  const { client, prompts } = makeClient(settingsOf({ wsUrl: server.url, acceptReplies: false }));
  client.start();
  try {
    await waitFor(() => client.status().state === 'ready');
    server.state.sessions[0].socket.send(JSON.stringify({
      v: 1,
      type: 'reply',
      id: 'reply-frame-3',
      at: new Date().toISOString(),
      replyId: 'reply-disabled',
      taskId: 'msg-1',
      sessionId: 'session-42',
      text: '继续',
    }));
    await waitFor(() => server.state.frames.some(isReplyResult));
    const result = server.state.frames.find(isReplyResult);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'replies disabled');
    assert.equal(prompts.length, 0);
  } finally {
    await client.stop();
    await server.close();
  }
});

test('stop：先发 bye 再 close(1000)', { timeout: 10_000 }, async () => {
  const server = await startServer();
  const { client } = makeClient(settingsOf({ wsUrl: server.url }));
  client.start();
  try {
    await waitFor(() => client.status().state === 'ready');
  } finally {
    await client.stop();
  }
  try {
    await waitFor(() => server.state.closes.includes(1000), { timeout: 2000 });
    const bye = server.state.frames.find((frame) => frame.type === 'bye');
    assert.ok(bye, '没有收到 bye 帧');
    assert.equal(bye.reason, 'shutdown');
    await waitFor(() => client.status().state === 'idle');
  } finally {
    await server.close();
  }
});

test('队列上限 50 与 TTL 过期', { timeout: 10_000 }, async () => {
  const probe = await startServer();
  const port = probe.port;
  await probe.close();

  const { client } = makeClient(settingsOf({
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    reconnectMinMs: 5000,
    reconnectMaxMs: 5000,
  }), { clientOptions: { queueMax: 3, queueTtlMs: 60 } });
  client.start();
  try {
    client.sendTask(taskPayload('m1'));
    client.sendTask(taskPayload('m2'));
    client.sendTask(taskPayload('m3'));
    client.sendTask(taskPayload('m4'));
    // 上限 3：最早的 m1 被丢掉
    assert.equal(client.status().pending, 3);

    await delay(80);
    client.sendTask(taskPayload('m5'));
    // TTL 60ms：之前 3 条都过期，只剩刚入队的 m5
    assert.equal(client.status().pending, 1);
  } finally {
    await client.stop();
  }
});

test('切换活动服务：地址变化后静默重连到新服务', { timeout: 15_000 }, async () => {
  const first = await startServer();
  const second = await startServer();
  const settings = settingsOf({
    wsUrl: first.url,
    activeServerId: 'first',
    activeServerLabel: '第一台',
  });
  const { client, logs } = makeClient(settings);
  client.start();
  try {
    await waitFor(() => client.status().state === 'ready');
    assert.equal(client.status().activeServerId, 'first');
    assert.equal(client.status().activeServerLabel, '第一台');
    assert.ok(logs.some((entry) => entry.message.includes('第一台')), 'ready 日志应带上服务名');

    // 配置卡片保存后活动服务切到另一台：地址/令牌变了，signature 触发静默重连
    settings.wsUrl = second.url;
    settings.activeServerId = 'second';
    settings.activeServerLabel = '第二台';

    await waitFor(() => second.state.frames.some((frame) => frame.type === 'hello'), { timeout: 6000 });
    assert.ok(first.state.closes.includes(1000), `旧连接关闭码为 ${first.state.closes.join(',')}`);
    const bye = first.state.frames.find((frame) => frame.type === 'bye');
    assert.ok(bye, '旧连接没有收到 bye');
    assert.equal(bye.reason, 'config changed');
    assert.ok(logs.some((entry) => /连接配置已变化（服务「第二台」）/.test(entry.message)));
    assert.equal(client.status().activeServerLabel, '第二台');
  } finally {
    await client.stop();
    await first.close();
    await second.close();
  }
});

test('没有活动服务：保持空闲、不重连也不刷日志', { timeout: 10_000 }, async () => {
  const settings = settingsOf({
    wsUrl: '',
    activeServerId: '',
    activeServerLabel: '',
  });
  const { client, logs } = makeClient(settings);
  client.start();
  try {
    await delay(100);
    assert.equal(client.status().state, 'idle');
    assert.equal(client.status().connected, false);
    const idle = logs.filter((entry) => /没有启用的服务/.test(entry.message));
    assert.equal(idle.length, 1, `日志刷了 ${idle.length} 条：${idle.map((entry) => entry.message).join(' | ')}`);

    // 配置卡片里启用一条服务之后，巡检能自动连上
    const server = await startServer();
    try {
      settings.wsUrl = server.url;
      settings.activeServerId = 'server-1';
      settings.activeServerLabel = '默认';
      await waitFor(() => server.state.frames.some((frame) => frame.type === 'hello'), { timeout: 6000 });
    } finally {
      await server.close();
    }
  } finally {
    await client.stop();
  }
});
