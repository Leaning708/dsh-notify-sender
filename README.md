# dsh-notify-sender

DeepSeek Harness（DSH）插件：把 DSH 的任务进展**发送**给 Coopanion 的通知发送端。每一轮任务结束时，把**完成/失败、设备、会话标题、耗时和最后回复摘要**通过 WebSocket 发给 Coopanion 的 `cortico-world-notify-receiver` World（**姐妹仓库**，原与本插件同属 `coopanion-bridge` monorepo，现已分家），由桌宠 Coo 提醒用户；也接收 Coopanion 按策略转回的回复，作为用户消息注入原来的 DSH 会话。

0.3.0 起改成 **WebSocket 客户端**：只有 Coopanion 侧开端口，DSH 主动连出去，不再需要回传地址、不再有入站端口（0.2 的 `3211` / `/reply` 已删除）。

0.3.1 起支持**多条 Coopanion 服务**（只启用一条），配置卡片分成「连接 / 通知 / 高级」三个页签；旧的 `wsUrl`/`token` 字段不再显示，可一键导入成一条服务。

0.3.2 只动配置界面：服务列表压成「表头 + 每行一条」的紧凑网格，本机（设备名 / 设备 ID）移到连接页签最上面，总开关常驻页签条上方，页签改成主色下划线选中态（鼠标点击不再出现黑框）；同时删除 `includeSubagents`——**子代理会话固定不通知**。

0.3.3 继续收敛配置界面：卡片顶部只留一两句简介，字段解释改成标题后的一个小「!」图标（悬停或键盘聚焦才显示）；不再注册「内置插件」页签入口，配置只保留 Settings 左栏与侧栏 Plugins 两处。

## 怎么工作

- 监听会话日志里的 `turn/end` 事件（不轮询、不改系统提示词、不登记模型工具）。
- `turn/end` 的原因为 `completed` 时发完成通知，为 `error` 时发失败通知；中断、fork、blocked 等不发。
- 标题取本轮 `turn/start` 之前最近一条用户消息，摘要取本轮最后一段有文本的 assistant 回复。
- 打开 `enabled` 后连**活动服务**（`servers` 里第一条 `enabled: true` 的 `wsUrl`），握手头带 `Authorization: Bearer <token>`，首帧 `hello`，收到 `hello-ok` 才算就绪。切换启用的服务会静默重连。
- 断线后按 1s → 2s → 4s… 退避重连（上限 30s，±20% 抖动）；未 ack 的通知在内存队列里（上限 50 条 / 10 分钟），连上后按序重发，**同一 `msgId`** 由服务端去重。
- 子代理（subagent）会话**固定不通知**（`session.header.parentSession` 直接跳过）；0.3.2 起不再有 `includeSubagents` 开关。

协议是 `dsh-notify.ws.v1`（一帧一条 JSON）。协议权威与完整帧说明在姐妹仓库 `cortico-world-notify-receiver` 的 `docs/PROTOCOL.md`（第 3 节选型记录见其 `docs/WS-DESIGN.md`）；两侧必须同代升级。任务通知帧：

```json
{
  "v": 1,
  "type": "task",
  "id": "帧 uuid",
  "at": "2026-11-02T07:40:00.000Z",
  "msgId": "通知 uuid（重发不变）",
  "status": "completed",
  "title": "修复登录页",
  "text": "测试全部通过",
  "sessionId": "session-...",
  "turn": 3,
  "durationMs": 65000,
  "cwd": "C:\\work\\app"
}
```

握手与确认：

```json
{ "v": 1, "type": "hello", "id": "...", "at": "...",
  "deviceId": "a1b2c3d4e5f6", "deviceName": "dev-box",
  "client": "dsh", "clientVersion": "0.3.3", "features": ["reply", "ack"] }
{ "v": 1, "type": "ack", "id": "...", "at": "...", "ref": "<msgId>", "cursor": 12, "duplicate": false }
{ "v": 1, "type": "reply", "id": "...", "at": "...", "replyId": "...", "taskId": "...", "sessionId": "...", "text": "..." }
{ "v": 1, "type": "reply-result", "id": "...", "at": "...", "replyId": "...", "ok": true }
{ "v": 1, "type": "bye", "id": "...", "at": "...", "reason": "shutdown" }
```

## 配置卡片

插件带浏览器端（`lib/client.js`）：装好并**重启一次 DSH** 后，会在这些地方出现配置界面：

- **Settings 左栏 → 「Coopanion Bridge」**：独立设置页，最容易找到，完整配置表单。
- **侧栏 Plugins → `dsh-notify-sender` bundle 页**：bundle 描述与行之间的配置区。
- **侧栏 Plugins → 该 bundle 的插件行 → 配置**：行配置页。

0.3.3 起不再注册 Settings → Plugins 的「内置插件」页签，同一个表单不会在两处重复出现。

卡片顶部只有一两句简介；字段解释收进标题后面的小「!」（`InfoDot`）：鼠标悬停或键盘聚焦才弹出 tooltip，表单里不再常驻大段说明。

卡片按页签组织：

- **页签条上方**：`enabled` 总开关（影响连接与所有页签，常驻，切页签不消失）。
- **连接**：本机（`device` / `deviceId`，全局项，不随服务切换）→ `acceptReplies` 开关 → 服务列表 → 「新增服务」。服务列表是一行表头（启用 / 名称 / WebSocket 地址 / 令牌 / 操作）+ 每条服务一行控件，行间只有细分割线，顶部只保留一句说明。
- **通知**：`notifyMode`、完成/失败开关与数字项（`notifyMode=goal` 时隐藏 `minTurnMs` 并显示说明）。
- **高级**：握手与重连超时。

页签只是本地视图，保存会写入三个页签的全部字段。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关；打开后才连接活动服务并发送，关闭时发 `bye` 断开 |
| `servers` | `[]` | 服务列表，每项 `{ id, label, wsUrl, token, enabled }`；只连接第一条 `enabled: true` 的服务。见下面「多服务」 |
| `device` | 空 | 显示给桌宠的设备名（`hello.deviceName`）；留空用系统主机名。所有服务共用 |
| `deviceId` | 空 | 稳定设备标识；留空 = 主机名的 12 位 sha256 前缀，同机重装不变。所有服务共用 |
| `acceptReplies` | `true` | 是否接受 Coo 转回的用户消息 |
| `notifyOnCompleted` | `true` | 完成时通知 |
| `notifyOnFailed` | `true` | 失败时通知 |
| `notifyMode` | `auto` | 通知时机：`auto` 自动 / `turn` 每轮完成 / `goal` 目标完成（含 blocked） |
| `minTurnMs` | `0` | 短于这个耗时的回合不通知（只作用于每轮通知；`goal` 模式不使用，界面会隐藏） |
| `maxSummaryChars` | `600` | 摘要最多多少字 |
| `connectTimeoutMs` | `8000` | 连上后等 `hello-ok` 的握手超时 |
| `reconnectMinMs` | `1000` | 首次重连等待；之后按 2 倍递增 |
| `reconnectMaxMs` | `30000` | 重连退避上限 |
| `wsUrl` / `token` | 空 | **已隐藏，仅迁移用**。`servers` 为空且 `wsUrl` 非空时，自动当作一条启用的「默认」服务；界面上请用「从旧配置导入」 |

### 多服务

`servers` 可以存多条地址/令牌，但同一时间只连一条：

- **活动服务** = 列表里第一条 `enabled: true` 且地址是 `ws(s)://` 的条目；多个 `enabled` 时取第一条并 warn 一次。
- 没有 `enabled` 的条目 → 不连接（`enabled` 总开关打开时日志提示一次）。
- 地址不是 `ws(s)` 的条目会保留在列表里，但不能启用。
- 切换启用项后，`ws-client` 用地址+令牌+设备信息做签名比较，静默发 `bye` 并用新地址重连。
- 令牌在界面里是密码框：已保存的令牌不回显，留空表示保持原值；新增的服务必须填令牌。
- 「从旧配置导入」只在 `servers` 为空时出现，会把旧 `wsUrl`/`token` 填成一条未启用的服务；旧的顶层字段保存后仍留在 config 里但不再使用。

DSH 不会为插件自动生成配置页；卡片由本包的 Client 半注册。Client 半只在 Host 启动时扫描 `dsh.client`，所以**第一次装上（或新增 Client 半）后必须完全退出 DSH 再打开**；只刷新页面不够。之后改 `lib/client.js` 也建议重启。

## 三种通知时机

| `notifyMode` | 名称 | 行为 |
|---|---|---|
| `auto` | 自动（默认，推荐） | 有活跃 goal 时，中间轮次静默，等 goal complete/block 发一次；没有活跃 goal 时，每次 `turn/end` 都发。 |
| `turn` | 每轮完成 | 每次 `turn/end`（completed / error）都通知；goal 中间轮次也通知。旧行为。 |
| `goal` | 目标完成 | 只在 goal complete / block 时通知；普通对话、没有 goal 时完全静默。 |

- **活跃 goal** = `phase: active` 且 `activation: armed`；paused、disarmed、complete、blocked 都按“没有活跃 goal”处理。
- `goal` 模式不通知普通对话；没有建 goal 的长任务请用 `auto` 或 `turn`。
- goal `blocked` 会以 `status: failed` 发给 Coopanion，正文是 blocked 原因；`notifyOnFailed` 控制它。
- `minTurnMs` 只作用于每轮通知，不影响 goal 通知。
- `auto` 在 goal complete/block 之后有 10 秒去重窗口，避免最终 `turn/end` 再发一条。
- 旧配置没有 `notifyMode` 时升级后默认 `auto`；想保持旧行为请选「每轮完成」。

## 回复回传

Coopanion 在回复窗口里匹配到消息后，会在这条连接上发 `reply` 帧：

```json
{ "v": 1, "type": "reply", "replyId": "...", "taskId": "...", "sessionId": "...", "text": "把测试也跑一下", "at": "..." }
```

本插件收到后调用 `ctx.sessionController.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text }] })`，把内容作为一条**用户消息**写进原来的会话；必要时会自动 resume 冷会话，然后回 `reply-result`。之后 DSH 正常跑一轮，`turn/end` 又会通知 Coopanion，形成闭环。

- `acceptReplies: false` 时直接回 `reply-result{ok:false,error:'replies disabled'}`。
- `replyId` 是去重键：同一个 `replyId` 只注入一次；注入失败**不**缓存去重键，并把错误放回 `reply-result`，让 Coopanion 重发重试。
- 回复窗口/关键字/次数/冷却等策略都在 Coopanion 侧，本插件不判断。

## 从 0.2 迁移

0.2 的两条 HTTP 入口（DSH 出站 `POST /notify` + DSH 入站 `POST /reply`）已经删除：

| 0.2 | 0.3 |
|---|---|
| `endpoint`（HTTP 地址） | `wsUrl`（ws/wss 地址） |
| `timeoutMs` | 删除（由 `connectTimeoutMs` 管握手；发送走长连接） |
| `replyEnabled` / `replyHost` / `replyPort` | 删除；不再监听任何端口，回复走同一条连接，用 `acceptReplies` 开关 |
| — | 新增 `deviceId` / `acceptReplies` / `connectTimeoutMs` / `reconnectMinMs` / `reconnectMaxMs` |

升级时如果只把旧配置里的 `endpoint` 留着没删，`wsUrl` 为空会**自动推导**：`http://host:port/notify` → `ws://host:port/ws`（`https` → `wss`），并在日志里提示迁移。推导只在 `wsUrl` 为空时生效；迁移完成后可以在配置卡片里用「从旧配置导入」把地址和令牌收进 `servers`。`deviceId` 留空即可，会按主机名稳定生成。

### 从 0.3.0 升级

- `wsUrl`/`token` 字段保留在 config 里（用于迁移），但配置卡片不再显示。
- `servers` 为空、旧 `wsUrl` 非空时，仍会像以前一样连接，并在日志提示迁移；`servers` 一旦有内容，旧字段就不再参与连接。
- 建议在「连接」页签点「从旧配置导入」，确认地址/令牌后保存，再把这条服务设为启用并关掉旧字段依赖。
- 升级后如果开了 `enabled` 但没有任何启用的服务，插件**不会**再偷偷连默认地址，只会在日志里提示一次。

### 从 0.3.1 升级

只涉及配置界面，协议、连接状态机与通知判定都没变：

- **删除 `includeSubagents`**：行为固定为不通知子代理会话。旧配置里的这个键会被 schema 丢掉，不需要迁移；通知页签上的「子代理也通知」开关也一并删除。
- **服务列表改版**：原来每条服务一张卡片、每行重复一大段说明；现在顶部只有一句说明 + 一行表头（启用 / 名称 / WebSocket 地址 / 令牌 / 操作），每条服务一行控件，底下是「新增服务」。
- **连接页签顺序**：本机（设备名 / 设备 ID）→ 接受回传 → 服务列表。`enabled` 总开关移到页签条上方常驻。
- **页签样式**：选中页签是主色下划线 + 加粗，非选中页签没有边框；鼠标点击不再出现焦点黑框，键盘聚焦（`:focus-visible`）才显示柔和焦点环。
- `CLIENT_VERSION` 升到 `0.3.2`（只影响 `hello.clientVersion`，帧形状不变）。

Coopanion 侧需要 0.3.2（ws 服务端 + 令牌表），并在它的「设备」页确认本机在线；旧版的 `dshReplyEndpoint` 不再需要。

### 从 0.3.2 升级

只动配置界面，协议、连接状态机、通知判定逻辑都不变：

- **简介精简**：卡片顶部只剩一两句说明，`statusHint`、`advancedHint` 这类常驻长文案删除。
- **字段解释改悬浮提示**：每个字段标题后面多了一个圆形小「!」图标（`InfoDot`），鼠标悬停或键盘聚焦才弹出解释；表单因此恢复紧凑。解释文字本身没丢，只是不再常驻。
- **去掉「内置插件」页签入口**：不再注册 `settings.plugins.tab`，配置只保留 Settings 左栏、侧栏 Plugins 的 bundle 区与行配置三处。
- `CLIENT_VERSION` 升到 `0.3.3`（只影响 `hello.clientVersion`，帧形状不变）。

## 安装

当前 `desktop` profile 已经用 `install_bundle` 把它装好（以 link 方式指向本目录）。换一台 DSH 时，在插件管理器里从本机目录安装这个包，或在本目录执行 `dsh plugin --profile <name> add <本目录>`。

装好后完全退出 DSH 再打开（让 Host 扫描 Client 半），然后在 Settings 左栏的「Coopanion Bridge」里打开 `enabled`，在「连接」页签新增一条服务并填好 `wsUrl` 与令牌（旧配置可用「从旧配置导入」）。

本地开发：

```bash
corepack pnpm install   # 运行时依赖：@deepseek-ai/schemastery、ws
pnpm test               # node --test（含用假 ws 服务端的集成用例）
```

## 端到端试用

1. Coopanion：扩展页从本机目录安装 `cortico-world-notify-receiver` 0.3.3，重启进程，在 World 总览里启用它；在「服务」页确认监听地址，在「令牌」页新建一个令牌并复制明文。
2. DSH：装好本插件，在设置里启用，在「连接」页签新增一条服务：`wsUrl` 指向 Coopanion 的 `/ws`，令牌填上一步的明文，并用单选把它设为启用；`device` 可留空。
3. 在 DSH 里随便让助手完成一轮任务；Coopanion 应收到通知（「设备」页在线、状态灯正常），并以桌宠的方式说一句完成或失败，同时转述摘要。
4. 想让 Coopanion 的回复回到 DSH：保持 `acceptReplies` 打开。按 Coopanion 的关键字规则匹配到的消息会作为用户消息进入原会话；DSH 处理完会再通知一次。

同机时用 `127.0.0.1`；两台设备时 Coopanion 侧要监听 `0.0.0.0`（或本机局域网地址），并在系统防火墙放行该端口。跨公网请自己准备隧道/反向代理并改用 `wss://`，本插件不内置中继。

## 排障

- 连不上：先看 DSH 日志里 `dsh-notify-sender` 的 warn（`401`/`4401` 多为 `token` 不一致；`ECONNREFUSED` 多为 Coopanion 没启动或端口/防火墙不对）。
- 令牌被吊销：Coopanion 会 `close(4403)`，本插件按退避重连；换新令牌后连接会自动恢复。
- 睡眠唤醒后通知延迟：客户端会在连续 2 个心跳周期收不到 `ping` 时主动重连（并用 ws 原生 ping 兜底）。
- 通知没到但连接正常：检查 `notifyMode`/`notifyOnCompleted`/`notifyOnFailed`/`minTurnMs`，以及是否被 `replyId`/turn 去重命中。

## 更多文档

本仓库 [docs/](docs/) 里有：

- [开发](docs/DEVELOPMENT.md)（含 DSH 插件开发经验）
- [排障](docs/TROUBLESHOOTING.md)

架构、协议与 WebSocket 设计稿在姐妹仓库 `cortico-world-notify-receiver` 的 `docs/` 里（协议权威在那边）。

## 从改名前的版本升级（dsh-cortico-world-bridge → dsh-notify-sender）

本插件由 `dsh-cortico-world-bridge` 更名而来，内部标识一并改名：

- 插件名 / bundle id / 配置 NS 改为 `dsh-notify-sender`；**DSH 里的旧配置 key 不会延续**，需要重新填一遍服务列表（地址、令牌）。
- 日志前缀 `[dsh-cortico-world-bridge]` → `[dsh-notify-sender]`。
- 协议 `dsh-bridge.ws.v1` → `dsh-notify.ws.v1`，与旧版 World（`dsh-bridge.ws.v1`）互不兼容；Coopanion 侧必须同步装改名后的 `cortico-world-notify-receiver`。

## 隐私

只发送上面列出的任务元数据与摘要，不读取或上传 DSH 的会话全文、附件、记忆或 API Key。服务地址与令牌只存在你自己的 DSH 配置里；令牌只出现在握手请求头，不写日志、不进 URL。
