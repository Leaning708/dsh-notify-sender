/**
 * DeepSeek Harness 插件：把任务结束/目标结束通知给 Coopanion 的 cortico-world-notify-receiver，
 * 并接收 Coopanion 转回的回复，作为用户消息注入原会话。
 *
 * 0.3.0 起不再开 HTTP 入站端口：本插件作为 WebSocket 客户端主动连 Coopanion 的
 * `ws://<host>:<port>/ws`（协议 `dsh-notify.ws.v1`），连接、断线重连、发送队列与
 * 回传注入都在 lib/ws-client.js 里。
 *
 * 通知时机由 notifyMode 决定：
 * - turn：每个 turn/end 都通知（旧行为）
 * - goal：只在 goal complete/block 时通知
 * - auto：有活跃 goal 时等 goal 结束，没有 goal 时按轮通知（默认）
 *
 * 发送失败只记 warn，不影响 DSH 本身的运行。
 */
import Schema from '@deepseek-ai/schemastery';
import {
  buildGoalPayload,
  buildPayload,
  isSubagentSession,
  isWsUrl,
  resolveSettings,
  shouldNotify,
} from './lib/notify.js';
import { CLIENT_VERSION, createWsClient } from './lib/ws-client.js';

export const name = 'dsh-notify-sender';

/** 回传要把 Coopanion 的回复注入 Session；sessions 用来把 goal 事件映射回会话。 */
export const inject = ['sessionController', 'sessions'];

export const Config = Schema.object({
  enabled: Schema.boolean().default(false).volatile(),
  // 0.3.1：多个 Coopanion 服务，只有第一条 enabled 的会连接。
  // 数组里的 token 只能是普通 string（schemastery 不能给数组元素加 role），UI 用密码框渲染。
  servers: Schema.array(Schema.object({
    id: Schema.string(),
    label: Schema.string(),
    wsUrl: Schema.string(),
    token: Schema.string(),
    enabled: Schema.boolean(),
  })).default([]).volatile(),
  // 以下 wsUrl/token 是 0.3.0 的旧字段，仅用于迁移；界面上不再显示。
  wsUrl: Schema.string().default('').volatile(),
  token: Schema.string().role('secret').default('').volatile(),
  device: Schema.string().default('').volatile(),
  deviceId: Schema.string().default('').volatile(),
  notifyOnCompleted: Schema.boolean().default(true).volatile(),
  notifyOnFailed: Schema.boolean().default(true).volatile(),
  // 0.3.2 起不再有 includeSubagents：子代理会话固定不通知。
  notifyMode: Schema.union(['auto', 'turn', 'goal']).default('auto').volatile(),
  minTurnMs: Schema.number().default(0).min(0).step(1000).volatile(),
  maxSummaryChars: Schema.number().default(600).min(80).max(4000).step(10).volatile(),
  acceptReplies: Schema.boolean().default(true).volatile(),
  connectTimeoutMs: Schema.number().default(8000).min(100).max(120_000).step(100).volatile(),
  reconnectMinMs: Schema.number().default(1000).min(100).max(60_000).step(100).volatile(),
  reconnectMaxMs: Schema.number().default(30_000).min(1000).max(600_000).step(1000).volatile(),
  // 0.2 的 HTTP 接收地址，已废弃；只为把老配置的 wsUrl 推导出来，不在配置卡片里显示。
  endpoint: Schema.string().default('').volatile().hidden(),
});

function warn(ctx, message) {
  try {
    if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(message);
    else console.warn(message);
  } catch {
    // 日志本身失败不应影响会话
  }
}

function info(ctx, message) {
  try {
    if (typeof ctx?.logger?.info === 'function') ctx.logger.info(message);
  } catch {
    // 日志本身失败不应影响会话
  }
}

function debug(ctx, message) {
  try {
    if (typeof ctx?.logger?.debug === 'function') ctx.logger.debug(message);
  } catch {
    // 日志本身失败不应影响会话
  }
}

const RECENT_CLOSE_MS = 10_000;

/** goal 的自动续跑只在 active + armed 时发生；其余状态按“没有活跃 goal”处理。 */
function goalIsActive(state) {
  return state?.phase === 'active' && state?.activation === 'armed';
}

function goalStateOf(goal) {
  return {
    id: goal.id,
    revision: goal.revision,
    phase: goal.phase,
    activation: goal.activation,
    objective: goal.objective,
    roundsStarted: goal.roundsStarted,
    maxGoalRounds: goal.maxGoalRounds,
    createdAt: goal.createdAt,
    blockedReason: goal.blockedReason?.message,
  };
}

export function apply(ctx, config) {
  const seen = new Set();
  const goalState = new Map();
  const recentClose = new Map();
  const warnedSettings = new Set();
  let warnedTarget = false;
  let warnedNoServer = false;
  let warnedMigration = false;

  /** 服务选择/迁移类提示只 warn 一次：settingsNow 会被通知和巡检反复调用。 */
  const reportSettingsWarnings = (settings) => {
    for (const warning of settings.warnings ?? []) {
      const key = `${warning.code}:${warning.id ?? ''}`;
      if (warnedSettings.has(key)) continue;
      warnedSettings.add(key);
      warn(ctx, warning.message);
    }
  };

  const settingsNow = () => {
    const settings = resolveSettings(config);
    reportSettingsWarnings(settings);
    return settings;
  };

  const sessionOf = (sessionId) => {
    try {
      return ctx.sessions?.get?.(sessionId);
    } catch {
      return undefined;
    }
  };

  /** 可选读取当前 goal；插件重载后用它给 goalState 播种。 */
  const queryGoal = (sessionId) => {
    try {
      const get = typeof ctx.get === 'function' ? ctx.get.bind(ctx) : undefined;
      const agents = get?.('agents');
      const goals = get?.('goals');
      const agent = agents?.get?.(sessionId);
      if (!agent) return undefined;
      return goals?.get?.(agent);
    } catch {
      return undefined;
    }
  };

  const seedGoal = (sessionId) => {
    if (!sessionId || goalState.has(sessionId)) return;
    const goal = queryGoal(sessionId);
    if (goal) goalState.set(sessionId, goalStateOf(goal));
  };

  const rememberRecentClose = (sessionId) => {
    recentClose.set(sessionId, Date.now() + RECENT_CLOSE_MS);
  };

  const consumeRecentClose = (sessionId) => {
    const until = recentClose.get(sessionId);
    if (until === undefined) return false;
    recentClose.delete(sessionId);
    return Date.now() <= until;
  };

  /** 有活动服务且地址合法才发；没有启用的服务时只提示一次。 */
  const targetReady = (settings) => {
    if (!settings.activeServerId) {
      if (!warnedNoServer) {
        warnedNoServer = true;
        warn(ctx, '[dsh-notify-sender] 没有启用的服务，已跳过通知');
      }
      return false;
    }
    if (isWsUrl(settings.wsUrl)) return true;
    if (!warnedTarget) {
      warnedTarget = true;
      warn(ctx, `[dsh-notify-sender] wsUrl 不是 ws(s) 地址，已跳过通知：${settings.wsUrl || '(空)'}`);
    }
    return false;
  };

  // 旧配置迁移提示：只提示一次，实际连接地址已由 resolveSettings 推导。
  const initialSettings = settingsNow();
  if (initialSettings.wsUrlMigrated && !warnedMigration) {
    warnedMigration = true;
    warn(ctx, `[dsh-notify-sender] 已按旧配置 endpoint 推导连接地址 ${initialSettings.wsUrl}；`
      + '建议在配置卡片的「连接」页签用「从旧配置导入」把它收进服务列表。');
  }

  // WebSocket 客户端：只连出去，不开任何入站端口。
  const client = createWsClient({
    getSettings: settingsNow,
    clientVersion: CLIENT_VERSION,
    prompt: async (request) => {
      await ctx.sessionController.prompt({
        requestId: request.requestId,
        sessionId: request.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: request.text }],
      }, AbortSignal.timeout(15_000));
      info(ctx, `[dsh-notify-sender] 已把 Coopanion 回复注入 ${request.sessionId}`);
    },
    log: (level, message) => {
      if (level === 'warn') warn(ctx, message);
      else if (level === 'info') info(ctx, message);
      else debug(ctx, message);
    },
  });
  ctx.effect(() => () => { void client.stop(); }, 'dsh-notify-sender: ws client');
  client.start();

  const notifyGoal = (sessionId, change) => {
    const settings = settingsNow();
    if (!settings.enabled) return;
    if (settings.notifyMode !== 'goal' && settings.notifyMode !== 'auto') return;
    // auto 下先占住最终 turn，哪怕通知开关关着，也不该再补一条“每轮完成”。
    if (settings.notifyMode === 'auto') rememberRecentClose(sessionId);
    if (!targetReady(settings)) return;
    const session = sessionOf(sessionId);
    if (!session) {
      debug(ctx, `[dsh-notify-sender] goal ${change.goal?.id ?? '?'} 的会话 ${sessionId} 已不在，跳过通知`);
      return;
    }
    // 子代理会话固定不通知（0.3.2 起没有 includeSubagents）。
    if (isSubagentSession(session)) return;
    if (change.operation === 'complete' && !settings.notifyOnCompleted) return;
    if (change.operation === 'block' && !settings.notifyOnFailed) return;

    const key = `${sessionId}:goal:${change.goal.id}:${change.goal.revision}:${change.operation}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 1000) seen.clear();

    const payload = buildGoalPayload(session, change, settings);
    if (!payload) return;

    // 先占位再入队：goal 事件和最终 turn/end 可能几乎同时到，等 ack 再标记会重复。
    client.sendTask(payload);
  };

  // goal 状态：create/edit/pause/resume 更新；complete/block 触发通知；clear 删除。
  ctx.on('goal/changed', (payload) => {
    const sessionId = payload?.agent?.id;
    const change = payload?.change;
    if (!sessionId || !change) return;
    if (change.operation === 'clear' || !change.goal) {
      goalState.delete(sessionId);
      recentClose.delete(sessionId);
      return;
    }
    goalState.set(sessionId, goalStateOf(change.goal));
    if (change.operation === 'complete' || change.operation === 'block') {
      notifyGoal(sessionId, change);
    }
  }, { global: true });

  // activation 单独变化（armed/disarmed）时只更新状态，不通知。
  ctx.on('goal/activation-changed', (payload) => {
    const sessionId = payload?.sessionId;
    if (!sessionId) return;
    if (!payload.goal) {
      goalState.delete(sessionId);
      recentClose.delete(sessionId);
      return;
    }
    const state = goalState.get(sessionId);
    if (state) {
      state.activation = payload.goal.activation;
      state.revision = payload.goal.revision;
      return;
    }
    seedGoal(sessionId);
  });

  // 插件重载后 goalState 是空的；agent 创建时从 goal 服务播种。
  ctx.on('agent/created', (payload) => {
    if (payload?.agent?.id) seedGoal(payload.agent.id);
  }, { global: true });

  // global: true 让根上下文也收到所有会话的事件；否则只收到经该 agent 上下文进入的会话。
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return;
    const settings = settingsNow();
    if (!settings.enabled) return;
    if (settings.notifyMode === 'goal') return;

    if (settings.notifyMode === 'auto') {
      if (!goalState.has(session.id)) seedGoal(session.id);
      if (goalIsActive(goalState.get(session.id))) return;
      if (consumeRecentClose(session.id)) return;
    }

    if (!shouldNotify(session, event, settings)) return;
    if (!targetReady(settings)) return;

    const key = `${session.id}:${event.data?.turn}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 1000) seen.clear();

    const payload = buildPayload(session, event, settings);
    if (settings.minTurnMs > 0 && (payload.durationMs ?? 0) < settings.minTurnMs) return;

    client.sendTask(payload);
  }, { global: true });
}
