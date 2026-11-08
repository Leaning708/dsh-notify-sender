import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildGoalPayload,
  buildPayload,
  buildTaskFrame,
  deriveDeviceId,
  deriveWsUrlFromEndpoint,
  isSubagentSession,
  isWsUrl,
  resolveSettings,
  shouldNotify,
  textOfMessage,
  truncate,
} from '../lib/notify.js';

const completedEvent = (turn = 1, time = 11_000) => ({
  type: 'turn/end',
  time,
  data: { turn, reason: { kind: 'completed' } },
});

const failedEvent = (turn = 1, message = '模型调用失败') => ({
  type: 'turn/end',
  time: 11_000,
  data: { turn, reason: { kind: 'error', error: { message } } },
});

function fakeSession({ id = 'session-1', parent, cwd = '/work', events = [] } = {}) {
  return {
    id,
    header: { ...(parent ? { parentSession: parent } : {}), ...(cwd ? { cwd } : {}) },
    snapshotEvents: () => events,
  };
}

const turnEvents = [
  {
    type: 'user/message',
    time: 1_000,
    data: { role: 'user', content: [{ type: 'text', text: '修复登录页\n并跑测试' }] },
  },
  { type: 'turn/start', time: 1_000, data: { turn: 1 } },
  {
    type: 'assistant/message',
    time: 10_000,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'reasoning', text: '内部推理' }, { type: 'text', text: '测试全部通过' }],
      },
    },
  },
  { type: 'turn/end', time: 11_000, data: { turn: 1, reason: { kind: 'completed' } } },
];

const settings = (overrides = {}) => resolveSettings({
  enabled: true,
  wsUrl: 'ws://127.0.0.1:3210/ws',
  token: 'secret',
  device: 'dev-box',
  ...overrides,
});

test('resolveSettings 的默认值与 volatile 活引用', () => {
  assert.deepEqual(resolveSettings(undefined), {
    enabled: false,
    wsUrl: '',
    wsUrlMigrated: false,
    legacyServer: false,
    token: '',
    servers: [],
    activeServerId: '',
    activeServerLabel: '',
    warnings: [],
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
    reconnectMaxMs: 30_000,
  });

  const live = resolveSettings({
    enabled: { get: () => true },
    wsUrl: { get: () => 'ws://10.0.0.2:3210/ws' },
    token: { get: () => 'abc' },
    device: { get: () => '笔记本' },
    deviceId: { get: () => 'abc123abc123' },
    maxSummaryChars: { get: () => 120 },
    notifyMode: { get: () => 'goal' },
    acceptReplies: { get: () => false },
    reconnectMinMs: { get: () => 500 },
    reconnectMaxMs: { get: () => 200_000 },
  });
  assert.equal(live.enabled, true);
  assert.equal(live.wsUrl, 'ws://10.0.0.2:3210/ws');
  assert.equal(live.token, 'abc');
  assert.equal(live.activeServerId, 'legacy');
  assert.equal(live.legacyServer, true);
  assert.equal(live.device, '笔记本');
  assert.equal(live.deviceId, 'abc123abc123');
  assert.equal(live.maxSummaryChars, 120);
  assert.equal(live.notifyMode, 'goal');
  assert.equal(live.acceptReplies, false);
  assert.equal(live.reconnectMinMs, 500);
  assert.equal(live.reconnectMaxMs, 200_000);

  // volatile 的 servers 活引用也能读
  const liveServers = resolveSettings({
    enabled: true,
    servers: {
      get: () => [{ id: 's1', label: 'S1', wsUrl: 'ws://127.0.0.1:1/ws', token: 't1', enabled: true }],
    },
  });
  assert.equal(liveServers.activeServerId, 's1');
  assert.equal(liveServers.wsUrl, 'ws://127.0.0.1:1/ws');

  assert.equal(resolveSettings({ notifyMode: 'unknown' }).notifyMode, 'auto');
  assert.equal(resolveSettings({ notifyMode: '' }).notifyMode, 'auto');
  assert.equal(resolveSettings({ notifyMode: 'turn' }).notifyMode, 'turn');
  // 0.3.2：includeSubagents 已删除，旧配置里的键不进 settings
  assert.equal('includeSubagents' in resolveSettings(undefined), false);
  assert.equal('includeSubagents' in resolveSettings({ includeSubagents: true }), false);
  // reconnectMaxMs 不允许小于 reconnectMinMs
  assert.equal(resolveSettings({ reconnectMinMs: 5000, reconnectMaxMs: 100 }).reconnectMaxMs, 5000);
});

test('旧配置迁移：wsUrl 为空时从 endpoint 推导，新值优先', () => {
  const migrated = resolveSettings({ endpoint: 'http://127.0.0.1:3210/notify' });
  assert.equal(migrated.wsUrl, 'ws://127.0.0.1:3210/ws');
  assert.equal(migrated.wsUrlMigrated, true);
  assert.equal(migrated.activeServerId, 'legacy');

  const secure = resolveSettings({ endpoint: 'https://coop.example.com:3210/notify' });
  assert.equal(secure.wsUrl, 'wss://coop.example.com:3210/ws');

  assert.equal(resolveSettings({ endpoint: 'http://10.0.0.2:3210/' }).wsUrl, 'ws://10.0.0.2:3210/ws');
  assert.equal(resolveSettings({ endpoint: 'http://10.0.0.2:3210/api/notify' }).wsUrl, 'ws://10.0.0.2:3210/api/ws');

  // 新配置的 wsUrl 一旦填了就不再被旧 endpoint 覆盖
  const explicit = resolveSettings({ wsUrl: 'ws://192.168.1.20:3210/ws', endpoint: 'http://127.0.0.1:3210/notify' });
  assert.equal(explicit.wsUrl, 'ws://192.168.1.20:3210/ws');
  assert.equal(explicit.wsUrlMigrated, false);

  // 无法推导时没有活动服务（不再偷偷连默认地址），也不声称迁移成功
  const broken = resolveSettings({ endpoint: 'not a url' });
  assert.equal(broken.wsUrl, '');
  assert.equal(broken.activeServerId, '');
  assert.equal(broken.wsUrlMigrated, false);
  assert.equal(deriveWsUrlFromEndpoint('ws://x/ws'), '');
  assert.equal(deriveWsUrlFromEndpoint(''), '');
});

test('多服务：取第一条启用的服务，多条时给出一次 warning', () => {
  const resolved = resolveSettings({
    enabled: true,
    servers: [
      { id: 'home', label: '家里', wsUrl: 'ws://10.0.0.2:3210/ws', token: 'token-home', enabled: false },
      { id: 'office', label: '公司', wsUrl: 'wss://coop.example.com/ws', token: 'token-office', enabled: true },
      { id: 'lab', label: '实验室', wsUrl: 'ws://10.0.0.3:3210/ws', token: 'token-lab', enabled: true },
    ],
  });
  assert.equal(resolved.activeServerId, 'office');
  assert.equal(resolved.activeServerLabel, '公司');
  assert.equal(resolved.wsUrl, 'wss://coop.example.com/ws');
  assert.equal(resolved.token, 'token-office');
  assert.deepEqual(resolved.servers.map((server) => server.id), ['home', 'office', 'lab']);
  assert.deepEqual(resolved.servers.map((server) => server.enabled), [false, true, true]);
  assert.ok(resolved.servers.every((server) => server.usable));
  const multiple = resolved.warnings.filter((warning) => warning.code === 'multiple-enabled');
  assert.equal(multiple.length, 1);
  assert.match(multiple[0].message, /只使用第一个「公司」/);
  // 令牌绝不进 warning 文本
  assert.ok(!resolved.warnings.some((warning) => /token-(home|office|lab)/.test(warning.message)));

  const single = resolveSettings({
    enabled: true,
    servers: [
      { id: 'a', label: 'A', wsUrl: 'ws://127.0.0.1:1/ws', token: '', enabled: false },
      { id: 'b', label: 'B', wsUrl: 'ws://127.0.0.1:2/ws', token: '', enabled: true },
    ],
  });
  assert.equal(single.activeServerId, 'b');
  assert.equal(single.warnings.some((warning) => warning.code === 'multiple-enabled'), false);
});

test('多服务：没有启用的服务时不连接，启用通知时提示一次', () => {
  const noneEnabled = resolveSettings({
    enabled: true,
    servers: [
      { id: 'a', label: 'A', wsUrl: 'ws://127.0.0.1:1/ws', token: '', enabled: false },
    ],
  });
  assert.equal(noneEnabled.activeServerId, '');
  assert.equal(noneEnabled.wsUrl, '');
  assert.equal(noneEnabled.token, '');
  const noActive = noneEnabled.warnings.filter((warning) => warning.code === 'no-active-server');
  assert.equal(noActive.length, 1);

  // 总开关关着时不提示“没有可用服务”
  const disabled = resolveSettings({ enabled: false, servers: [] });
  assert.equal(disabled.warnings.some((warning) => warning.code === 'no-active-server'), false);

  // 启用的条目地址非法：保留在列表里但不能成为活动服务
  const invalid = resolveSettings({
    enabled: true,
    servers: [
      { id: 'bad', label: '坏地址', wsUrl: 'http://127.0.0.1:3210/notify', token: '', enabled: true },
    ],
  });
  assert.equal(invalid.servers.length, 1);
  assert.equal(invalid.servers[0].usable, false);
  assert.equal(invalid.activeServerId, '');
  assert.ok(invalid.warnings.some((warning) => warning.code === 'invalid-server-url'));
  assert.ok(invalid.warnings.some((warning) => warning.code === 'no-active-server'));
});

test('servers 规范化：畸形条目丢弃、缺 id 派生、缺 label 补齐', () => {
  const resolved = resolveSettings({
    servers: [
      null,
      'not-an-object',
      42,
      { label: '坏地址', wsUrl: 'http://x/notify', enabled: true },
      { id: 'keep', label: '', wsUrl: 'ws://127.0.0.1:9/ws', enabled: false },
    ],
  });
  assert.equal(resolved.servers.length, 2);
  assert.deepEqual(resolved.servers.map((server) => server.id), ['server-4', 'keep']);
  assert.deepEqual(resolved.servers.map((server) => server.label), ['坏地址', '服务 5']);
  assert.equal(resolved.warnings.filter((warning) => warning.code === 'invalid-server-entry').length, 3);

  const notArray = resolveSettings({ servers: { id: 'x' } });
  assert.deepEqual(notArray.servers, []);
  assert.ok(notArray.warnings.some((warning) => warning.code === 'invalid-servers'));
});

test('旧 wsUrl/token 回退成一条启用的默认服务；有 servers 时旧字段不再参与', () => {
  const legacy = resolveSettings({
    enabled: true,
    wsUrl: 'ws://192.168.1.20:3210/ws',
    token: 'old-token',
  });
  assert.equal(legacy.legacyServer, true);
  assert.deepEqual(legacy.servers, [{
    id: 'legacy',
    label: '默认',
    wsUrl: 'ws://192.168.1.20:3210/ws',
    token: 'old-token',
    enabled: true,
    usable: true,
    legacy: true,
  }]);
  assert.equal(legacy.activeServerId, 'legacy');
  assert.equal(legacy.activeServerLabel, '默认');
  assert.equal(legacy.wsUrl, 'ws://192.168.1.20:3210/ws');
  assert.equal(legacy.token, 'old-token');
  assert.ok(legacy.warnings.some((warning) => warning.code === 'legacy-server'));
  assert.ok(!legacy.warnings.some((warning) => warning.message.includes('old-token')));

  // 有 servers 时旧 wsUrl/token 不覆盖，也不参与选择
  const explicit = resolveSettings({
    servers: [{ id: 's', label: 'S', wsUrl: 'ws://127.0.0.1:5/ws', token: 'token-s', enabled: true }],
    wsUrl: 'ws://old/ws',
    token: 'old-token',
  });
  assert.equal(explicit.legacyServer, false);
  assert.equal(explicit.servers.length, 1);
  assert.equal(explicit.activeServerId, 's');
  assert.equal(explicit.wsUrl, 'ws://127.0.0.1:5/ws');
  assert.equal(explicit.token, 'token-s');
});

test('只通知完成与失败，子代理会话一律不通知', () => {
  const base = settings();
  assert.equal(shouldNotify(fakeSession(), completedEvent(), base), true);
  assert.equal(shouldNotify(fakeSession(), failedEvent(), base), true);

  assert.equal(shouldNotify(fakeSession(), completedEvent(), { ...base, enabled: false }), false);
  assert.equal(shouldNotify(fakeSession(), completedEvent(), { ...base, notifyOnCompleted: false }), false);
  assert.equal(shouldNotify(fakeSession(), failedEvent(), { ...base, notifyOnFailed: false }), false);
  assert.equal(shouldNotify(fakeSession(), { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } }, base), false);

  // 0.3.2 起没有 includeSubagents：子代理会话固定不通知，旧配置里的 true 也不会生效
  assert.equal(isSubagentSession(fakeSession({ parent: 'session-parent' })), true);
  assert.equal(isSubagentSession(fakeSession()), false);
  const subagent = fakeSession({ parent: 'session-parent' });
  assert.equal(shouldNotify(subagent, completedEvent(), base), false);
  assert.equal(shouldNotify(subagent, completedEvent(), { ...base, includeSubagents: true }), false);
  assert.equal(shouldNotify(subagent, failedEvent(), base), false);
});

test('从会话事件里取标题、最后回复摘要与耗时', () => {
  const payload = buildPayload(fakeSession({ events: turnEvents }), completedEvent(), settings(), { msgId: 'msg-1' });
  assert.equal(payload.msgId, 'msg-1');
  assert.equal(payload.status, 'completed');
  assert.equal(payload.title, '修复登录页 并跑测试');
  assert.equal(payload.text, '测试全部通过');
  assert.equal(payload.durationMs, 10_000);
  assert.equal(payload.turn, 1);
  assert.equal(payload.sessionId, 'session-1');
  assert.equal(payload.cwd, '/work');
  assert.match(payload.at, /^\d{4}-\d{2}-\d{2}T/);
  // 设备信息只走 hello 帧，不再进 payload
  assert.equal(payload.device, undefined);
  assert.equal(payload.version, undefined);
});

test('每条通知都有唯一 msgId', () => {
  const first = buildPayload(fakeSession({ events: turnEvents }), completedEvent(), settings());
  const second = buildPayload(fakeSession({ events: turnEvents }), completedEvent(), settings());
  assert.match(first.msgId, /^[0-9a-f-]{36}$/);
  assert.notEqual(first.msgId, second.msgId);
});

test('goal complete / block 的通知内容', () => {
  const goal = {
    id: 'goal-1',
    revision: 2,
    objective: '把测试全部修到通过',
    phase: 'complete',
    maxGoalRounds: 10,
    roundsStarted: 3,
    createdAt: Date.now() - 5_000,
    updatedAt: Date.now(),
    activation: 'armed',
  };
  const complete = buildGoalPayload(
    fakeSession({ events: turnEvents }),
    { operation: 'complete', ref: { id: 'goal-1', revision: 2 }, goal },
    settings(),
    { msgId: 'goal-msg-1' },
  );
  assert.equal(complete.msgId, 'goal-msg-1');
  assert.equal(complete.status, 'completed');
  assert.equal(complete.title, '把测试全部修到通过');
  assert.equal(complete.text, '测试全部通过');
  assert.equal(complete.sessionId, 'session-1');
  assert.equal(complete.turn, 1);
  assert.equal(complete.cwd, '/work');
  assert.ok(complete.durationMs >= 5_000);

  const blocked = buildGoalPayload(
    fakeSession({ events: turnEvents }),
    {
      operation: 'block',
      ref: { id: 'goal-1', revision: 3 },
      goal: { ...goal, phase: 'blocked', revision: 3, blockedReason: { code: 'stalled', message: '连续三轮没有进展' } },
    },
    settings(),
  );
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.text, '连续三轮没有进展');
  assert.equal(blocked.title, '把测试全部修到通过');
  assert.match(blocked.msgId, /^[0-9a-f-]{36}$/);
});

test('goal 通知在没有最后回复或原因时回退', () => {
  const goal = {
    id: 'goal-2',
    revision: 1,
    objective: '整理文档',
    phase: 'complete',
    maxGoalRounds: 5,
    roundsStarted: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    activation: 'armed',
  };
  const complete = buildGoalPayload(
    fakeSession({ events: [{ type: 'turn/end', time: 1000, data: { turn: 1, reason: { kind: 'completed' } } }] }),
    { operation: 'complete', ref: { id: 'goal-2', revision: 1 }, goal },
    settings(),
  );
  assert.equal(complete.text, '');

  const blocked = buildGoalPayload(
    fakeSession(),
    { operation: 'block', ref: { id: 'goal-2', revision: 2 }, goal: { ...goal, phase: 'blocked' } },
    settings(),
  );
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.text, '');
});

test('失败通知带上错误信息,完成通知不误带', () => {
  const payload = buildPayload(fakeSession({ events: turnEvents }), failedEvent(1, '上游超时'), settings());
  assert.equal(payload.status, 'failed');
  assert.equal(payload.text, '上游超时');
});

test('没有 user/message 时标题为空,不抛错', () => {
  const events = [
    { type: 'turn/start', time: 5_000, data: { turn: 2 } },
    { type: 'assistant/message', time: 6_000, data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'done' }] } } },
    { type: 'turn/end', time: 7_000, data: { turn: 2, reason: { kind: 'completed' } } },
  ];
  const payload = buildPayload(fakeSession({ events }), completedEvent(2, 7_000), settings());
  assert.equal(payload.title, '');
  assert.equal(payload.text, 'done');
  assert.equal(payload.durationMs, 2_000);
});

test('文本块提取与截断', () => {
  assert.equal(textOfMessage({ content: [{ type: 'reasoning', text: 'r' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(textOfMessage({ content: '  hi  ' }), 'hi');
  assert.equal(textOfMessage({}), '');
  assert.equal(truncate('x'.repeat(10), 4), 'xxxx…');
  assert.equal(truncate('short', 10), 'short');
});

test('wsUrl 校验只接受 ws(s)', () => {
  assert.equal(isWsUrl('ws://127.0.0.1:3210/ws'), true);
  assert.equal(isWsUrl('wss://coop.example.com/ws'), true);
  assert.equal(isWsUrl('http://127.0.0.1:3210/notify'), false);
  assert.equal(isWsUrl('file:///tmp/x'), false);
  assert.equal(isWsUrl(''), false);
  assert.equal(isWsUrl('not a url'), false);
});

test('deviceId 默认用主机名的 12 位哈希', () => {
  const one = deriveDeviceId('dev-box');
  assert.match(one, /^[0-9a-f]{12}$/);
  assert.equal(one, deriveDeviceId('dev-box'));
  assert.notEqual(one, deriveDeviceId('other-box'));
  assert.equal(deriveDeviceId(''), deriveDeviceId('dsh'));
});

test('buildTaskFrame 只发第 3.1 节列出的字段', () => {
  const payload = buildPayload(fakeSession({ events: turnEvents }), completedEvent(), settings(), { msgId: 'msg-1' });
  const frame = buildTaskFrame(payload, { id: 'frame-1' });
  assert.deepEqual(Object.keys(frame).sort(), [
    'at', 'cwd', 'durationMs', 'id', 'msgId', 'sessionId', 'status', 'text', 'title', 'turn', 'type', 'v',
  ]);
  assert.equal(frame.v, 1);
  assert.equal(frame.type, 'task');
  assert.equal(frame.id, 'frame-1');
  assert.equal(frame.msgId, 'msg-1');
  assert.equal(frame.status, 'completed');
  assert.equal(frame.title, '修复登录页 并跑测试');
  assert.equal(frame.text, '测试全部通过');
  assert.equal(frame.sessionId, 'session-1');
  assert.equal(frame.turn, 1);
  assert.equal(frame.durationMs, 10_000);
  assert.equal(frame.cwd, '/work');
  assert.equal(frame.at, payload.at);

  // 可选字段缺失时不写 null，失败状态也要归一化
  const minimal = buildTaskFrame({ msgId: 'm-2', status: 'failed', title: 't', text: 'x', sessionId: 's' });
  assert.equal(minimal.status, 'failed');
  assert.equal('turn' in minimal, false);
  assert.equal('durationMs' in minimal, false);
  assert.equal('cwd' in minimal, false);
  assert.equal(buildTaskFrame({ status: 'weird' }).status, 'completed');
  assert.equal(buildTaskFrame({ msgId: 'm-3', status: 'completed' }).msgId, 'm-3');
});
