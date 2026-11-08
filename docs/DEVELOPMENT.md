# 开发指南

面向接手本仓库（DeepSeek Harness 插件 `dsh-notify-sender`）的人。

对端 Coopanion World 扩展 `cortico-world-notify-receiver` 是**姐妹仓库**（原同属 `coopanion-bridge` monorepo，已分家）：协议字段的精确说明、架构与 WebSocket 设计稿都在它的 `docs/` 里（协议权威在那边），两侧必须同代升级。

## 1. 环境

- Node.js **>= 22**
- pnpm **11.x**（`packageManager: pnpm@11.28.6`；用 `corepack pnpm` 最稳）
- DeepSeek Harness（DSH）当前 `desktop` profile，插件以 link 方式安装
- 联调用 Coopanion（Cortico）0.2.x + 姐妹仓库的 `cortico-world-notify-receiver` 扩展
- Windows 开发机为当前主要环境

## 2. 目录

```text
dsh-notify-sender/
├─ README.md
├─ docs/
│  ├─ DEVELOPMENT.md
│  └─ TROUBLESHOOTING.md
├─ index.js              # Host 半：事件监听、配置 schema、生命周期
├─ lib/
│  ├─ notify.js          # 通知判定、多服务归一化与 payload（纯逻辑）
│  ├─ ws-client.js       # 连接状态机、发送队列、ack、心跳、回传处理
│  └─ client.js          # Client 半：Settings/Plugins 配置卡片
├─ locale/               # zh/en 配置卡片文案
├─ cordis.patch.yml      # profile bundle patch
├─ icon.svg
└─ test/                 # node --test
```

## 3. 常用命令

```bash
corepack pnpm install   # 运行时依赖：@deepseek-ai/schemastery、ws
pnpm test               # 69 个 node:test
```

第一次 `corepack pnpm install` 在无 TTY 环境可能报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`，设置 `CI=true`（bash）或 `$env:CI='true'`（PowerShell）即可。

## 4. 本地安装

在插件管理器里从本机目录安装，或在 profile 里加 link：

```bash
dsh plugin --profile desktop add <本仓库路径>
```

装好后**完全退出 DSH 再打开**（Host 只在启动时扫 Client 半），然后在 Settings →「Coopanion Bridge」里配置。

> link 安装的包**不会**被 profile 安装它的 `dependencies`；`@deepseek-ai/schemastery`、`ws` 需要在包目录自己 `pnpm install`，否则插件激活时报 `ERR_MODULE_NOT_FOUND`。

端到端联调需要 Coopanion 里装姐妹仓库的 `cortico-world-notify-receiver`（其 README 有安装步骤），在「令牌」页建好令牌再连。

## 5. 开发任务手册

### 5.1 加一个通知时机

1. `index.js` 的 `Config` 加字段（通常是 `Schema.union([...]).default(...).volatile()`）。
2. `lib/notify.js` 的 `DEFAULTS` / `resolveSettings` 加白名单；纯逻辑判断放这里。
3. `index.js` 的事件处理按模式分支；注意 `global: true`、goal 种子、去重。
4. `lib/client.js` 表单加字段，`toDraft` 和保存（`{op:'set', path:[...], value}`）都要覆盖；放在哪个页签由 `Tab` 决定。
5. 补 `test/notify.test.mjs` / `apply.test.mjs` / `client.test.mjs`。

#### 多服务（`servers`）相关改动要点

- 配置形状：`servers: Schema.array(Schema.object({ id, label, wsUrl, token, enabled }))`。数组元素里的 `token` 只能是普通 `string`（`role('secret')` 在数组元素上不生效），所以 UI 用密码框、保存时按 `tokenTouched` 保留未改动行的原值。
- 活动服务永远由 `lib/notify.js` 的 `normalizeServers` + 选择规则决定（`enabled && usable` 的第一条）；`wsUrl`/`token` 这两个**旧字段名**在 `resolveSettings` 的返回值里指向活动服务，这样 `lib/ws-client.js` 只消费这两个名字、不用关心多服务。
- 切换服务 = `wsUrl`/`token` 签名变化 → `reconcile` 静默重连；不要自己在切换时调用 `stop()`/`start()`，否则会和退避逻辑打架。
- 旧配置迁移：`servers` 为空且旧 `wsUrl` 有值时当作一条 `legacy` 服务；`servers` 非空后旧字段完全不参与，也不要在 UI 里再暴露它们。

### 5.2 改协议（帧字段、关闭码、去重语义）

协议权威在姐妹仓库：**先改 `cortico-world-notify-receiver` 的 `docs/PROTOCOL.md`，再两侧同步**。

1. 本仓库 `lib/ws-client.js`（收发）+ `lib/notify.js` 的 `buildTaskFrame`。
2. 姐妹仓库的 `src/protocol.ts` + `src/ws-server.ts`。
3. 两侧测试同时补。
4. 新增**必填**字段是破坏性变更：升版本，两侧必须同代。

**教训**：确认语义（`ack`）和幂等键（`msgId`/`replyId`）是最容易写歪的地方，改协议时优先补端到端探针。

## 6. 调试

- DSH：Settings 配置卡片、插件日志（搜 `dsh-notify-sender`；连接/重连/ack/注入失败各有一行）。
- Coopanion：姐妹仓库 World 页的「服务/设备」页签、`/health`（`onlineDevices` ≥ 1 说明连上了）。
- 端到端：先看 `/health` 的 `onlineDevices`，再让助手完成一轮任务，确认通知与摘要；再用 Coopanion 控制台注入一条命中关键字的「回复 …」验证回传。
- 不要在生产 profile/真实会话上随便发测试通知；会真的让 Coo 说话。

## 7. 发布/归档检查

- [ ] `pnpm test` 通过（69 个 node:test）。
- [ ] `package.json` `name` 为 `dsh-notify-sender`，`version` 与姐妹仓库同代。
- [ ] 协议有改动时，姐妹仓库 `cortico-world-notify-receiver` 同步升版，其 `docs/PROTOCOL.md` 已更新。
- [ ] `CHANGELOG.md` 有当前版本段落。
- [ ] 没有把真实令牌、绝对本机路径、日志、profile 配置写进仓库。
- [ ] 归档：`git tag vX.Y.Z`，`git archive` 生成 zip。

## 8. 代码约定

- 纯逻辑放 `lib/notify.js`，连接/队列/心跳放 `lib/ws-client.js`，`index.js` 只做事件绑定和生命周期。
- 配置默认值只写一处：`DEFAULTS` / `resolveSettings`；`Config` 的 schema 只声明 UI。
- 令牌只进请求头与握手帧，不进日志、URL、Git。
- 回调/资源释放走 `ctx.effect`；连接、定时器都要能在 `stop()` 里收干净。
- Coopanion 侧（姐妹仓库）的约定：纯逻辑放 `protocol.ts` / `reply-policy.ts` / `note.ts`，`world.ts` 做状态与编排，`ws-server.ts` 只做 I/O。

## 9. DSH 插件开发经验（原 monorepo LESSONS 的 DSH 侧）

### 9.1 DSH 不会自动生成插件配置 UI

**现象**：插件 active，但 Settings 里没有配置卡片。

**原因**：DSH 的 Host 插件只声明 `Config`，不会自动渲染；必须提供 Client 半（`dsh.client` + `lib/client.js`），并注册 `settings.section` / `settings.plugins.tab` / `plugins.bundle.config` / `plugins.row.config`。

**教训**：第一次安装或新增 Client 半后，必须**完全退出 DSH 再打开**。只刷新页面不会扫描新的 Client 模块。

### 9.2 `ctx.on` 的作用域很容易写错

**现象**：插件收不到自己以为能收到的 `session/event` / goal 事件。

**原因**：事件可能按 agent 上下文过滤；根上下文需要 `{ global: true }` 才能收到所有会话。

**教训**：`session/event`、`goal/changed`、`agent/created` 都用 `global: true`；`goal/activation-changed` 是进程级，不需要。写完要实际制造一个 turn/goal 验证，不要只看类型。

### 9.3 goal 状态不能只靠内存

**现象**：插件重载后，`auto` 模式不认识当前活跃 goal，又开始按轮通知。

**修复**：`agent/created` 时从 `ctx.goals.get(agent)` 播种；`turn/end` 时如果状态缺失再懒查询一次。

**教训**：事件是增量的，内存状态在重载/重启后会丢；任何“当前是否活跃”的判断都要能从服务重新查。

### 9.4 `auto` 去重有竞态

**现象**：goal 完成时发了一条，最终 `turn/end` 又发一条。

**原因**：最初在 HTTP 成功后才记录“刚关闭”，但 goal 事件和最终 turn 几乎同时到达，turn 先检查，没看到标记。

**修复**：在发 goal 通知**之前**先记 `recentClose`，即使通知开关关着也记。这样最终 turn 一定被抑制。

**教训**：去重标记要在“决定发”时占位，不能在“发送成功”后补。失败时可以接受少一条通知，不能接受重复。
