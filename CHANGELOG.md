# Changelog

## 改名归档（0.3.3 之后，未发布版本号）

项目由 `dsh-cortico-world-bridge` 更名为 `dsh-notify-sender`，与 Coopanion World 扩展 `cortico-world-notify-receiver`（原 `cortico-world-dsh-bridge`）分家为两个独立仓库。内部标识同步改名：插件名/bundle id/配置 NS `dsh-cortico-world-bridge` → `dsh-notify-sender`（DSH 旧配置 key 不延续，需重填服务列表）、日志前缀 `[dsh-cortico-world-bridge]` → `[dsh-notify-sender]`、协议 `dsh-bridge.ws.v1` → `dsh-notify.ws.v1`。与旧版 World 互不兼容，迁移说明见 README。monorepo 的根级文档按归属拆分：本仓库留 docs/DEVELOPMENT.md（含 DSH 插件经验）与 docs/TROUBLESHOOTING.md，协议/架构/设计稿在姐妹仓库。

## 0.3.3

只收敛配置界面，协议（`dsh-notify.ws.v1`）、连接状态机、通知判定逻辑与帧形状都不变。

- **简介精简**：卡片顶部只留一两句说明；删除 `statusHint`、`advancedHint` 这类常驻长文案。`summary` / `intro` 中英文案同步缩短。
- **字段解释改悬浮提示**：新增 `InfoDot`——字段标题后的圆形小「!」图标，`tabIndex=0`、`aria-label` 为解释文字；鼠标 `mouseenter`/`mouseleave` 与键盘 `focus`/`blur` 只切组件本地 state，弹出绝对定位的 tooltip（最大宽度 260px、`zIndex` 9999、靠近视口右侧时改 `right: 0` 对齐）。样式只用 `--dsw-alias-*` 主题 token，不注入全局 `<style>`。服务列表只在顶部保留一句说明，不逐行放图标。
- **去掉「内置插件」页签入口**：删除 `settings.plugins.tab` 注册，配置只保留 `settings.section`、`plugins.bundle.config`、`plugins.row.config` 三处。
- `CLIENT_VERSION` 升到 `0.3.3`（只影响 `hello.clientVersion`）。
- 测试：69 个 node:test。注册位断言改为三处并断言没有 `settings.plugins.tab`；新增 InfoDot 渲染（aria-label、图标、tabIndex）、悬停/聚焦 tooltip 出现与消失、右侧视口改右对齐、简介精简（不含旧长段落 / 无 `statusHint`）、中英文案 key 集合一致等用例。

## 0.3.2

只改配置界面，外加删掉一个配置项；协议（`dsh-notify.ws.v1`）、连接状态机、通知判定逻辑与帧形状都不变。

- **删除 `includeSubagents`**：行为固定为不通知子代理会话（`session.header.parentSession` 直接跳过）。`Config`、`DEFAULTS`、`resolveSettings`、`shouldNotify`、goal 通知、配置卡片与测试同步清理；旧配置里的这个键会被 schema 丢掉，不需要迁移。
- **服务列表精简**：从「每条服务一张卡片 + 每行重复 hint」改成紧凑网格——顶部一句说明、一行表头（启用 / 名称 / WebSocket 地址 / 令牌 / 操作）、每条服务一行（radio、名称 input、地址 input、令牌密码框、右对齐删除按钮），列表下方是「新增服务」。行间只有细分割线，没有卡片边框和阴影；地址列用 `minmax(0, …)` + `min-width: 0`，窄宽度不溢出。
- **连接页签重排**：本机（设备名 / 设备 ID）移到最上面 → 接受回传开关 → 服务列表 → 新增服务；设备名/设备 ID 仍是全局项。`enabled` 总开关移到页签条上方常驻。
- **页签样式修复**：选中页签改成「底部 2px 主色高亮条 + 加粗 + 主色文字」，页签本身不再有任何边框；鼠标点击不出现黑色焦点框，键盘聚焦（`:focus-visible`）时只显示一个柔和焦点环。`role="tab"` / `aria-selected` / `aria-controls` 与选中态一致，内容区补上 `role="tabpanel"`。
- `CLIENT_VERSION` 升到 `0.3.2`。
- 测试：65 个 node:test。更新 `includeSubagents` 相关断言为「子代理会话不通知」（含 goal 路径），新增页签选中态/焦点环、紧凑服务列表（表头 + 每行 5 个控件 + 单选同 name + 窄宽度 min-width）、设备名/ID 在服务列表之前的渲染顺序断言。

## 0.3.1

- **多服务**：`Config` 新增 `servers: Array<{ id, label, wsUrl, token, enabled }>`（默认 `[]`）；同一时间只连接第一条 `enabled: true` 且地址为 `ws(s)` 的服务，多个 `enabled` 取第一条并 warn 一次，没有启用的服务则不连接。切换服务由现有连接签名机制静默重连，日志带服务名。
- **旧配置迁移**：保留顶层 `wsUrl`/`token` 但配置卡片不再显示；`servers` 为空且旧 `wsUrl` 非空时回退成一条启用的「默认」服务并提示一次。`resolveSettings` 额外返回 `servers`、`activeServerId`、`activeServerLabel`，`wsUrl`/`token` 继续指向活动服务（`lib/ws-client.js` 只消费这两个字段）。
- **配置卡片分页签**：连接 / 通知 / 高级（React 本地 state，保存仍写全部字段）。连接页签是服务列表（启用单选、名称、ws(s) 地址、令牌密码框、删除、新增服务、从旧配置导入），设备名/设备 ID/接受回复放在底部共用；`notifyMode=goal` 时隐藏 `minTurnMs` 并显示说明。
- **令牌处理**：服务行令牌用密码框且不回显；未改动的行保存时沿用 snapshot 里的令牌，新增服务必须填令牌，启用的服务必须是 `ws(s)` 地址。
- `CLIENT_VERSION` 升到 `0.3.1`（hello 帧的 `clientVersion`，帧形状与关闭码不变）。
- 测试：62 个 node:test。新增服务归一化/选择/迁移、多服务连接与切换重连、无活动服务空闲、配置页签与服务列表渲染、整体保存与令牌保留用例。

## 0.3.0

- **改成 WebSocket 客户端**：主动连 Coopanion 的 `ws://<host>:<port>/ws`（协议 `dsh-notify.ws.v1`），只连出去、不开入站端口。
- 新增 `lib/ws-client.js`：状态机（idle → connecting → hello → ready → closing → backoff）、`hello`/`hello-ok` 握手（握手头 `Authorization: Bearer`）、指数退避重连（1s×2ⁿ 封顶 30s，±20% 抖动）、应用层心跳 + ws 原生 ping 双保险、发送队列（内存上限 50 条 / TTL 10 分钟）、`ack` 出队、重连后同一 `msgId` 重发、入站 `reply` 分发与 `reply-result`、`bye` + `close(1000)` 优雅下线。
- 新增 `acceptReplies`（默认 `true`）：关闭时直接回 `reply-result{ok:false,error:'replies disabled'}`。
- 新增 `deviceId`（留空 = 主机名 12 位 sha256 前缀）、`connectTimeoutMs`（8000）、`reconnectMinMs`（1000）、`reconnectMaxMs`（30000）。
- `notify.js`：`endpoint` 校验换成 `wsUrl`（`ws:`/`wss:`）；每条通知生成 `msgId`；新增 `buildTaskFrame` 产出第 3.1 节的 task 帧；删除 `sendNotification` 与 `timeoutMs` 语义。
- `index.js`：改为创建 ws 客户端并用 `ctx.effect` 清理；通知判定（`shouldNotify`/`seen`/`minTurnMs`/`notifyMode` 三档/goal 播种/`recentClose`）逻辑不变，只是发送改为 `client.sendTask(payload)`。
- **删除** `lib/reply-server.js` 的入站 `/reply` 服务与测试：不再监听 3211，不再需要防火墙放行；回复走同一条 ws 连接。
- Client 半配置卡片按新字段重排（连接 / 通知时机 / 高级），不再显示 `endpoint`、`timeoutMs`、`replyEnabled`、`replyHost`、`replyPort`。
- 测试：42 个 node:test。新增 `test/ws-client.test.mjs`（用 `ws` 起假服务端覆盖握手成功/令牌被拒/hello 超时/退避重连/心跳超时/断线队列/ack 出队/重发同 msgId/reply 注入与去重/`acceptReplies:false`/bye/队列上限与 TTL）；`test/apply.test.mjs`、`test/client.test.mjs`、`test/notify.test.mjs` 按新行为改写。

### 从 0.2 迁移

| 0.2 | 0.3 |
|---|---|
| `endpoint` | `wsUrl`；`wsUrl` 为空时从旧 `endpoint` 推导（`http→ws`、`https→wss`、路径 `/notify→/ws`），并在日志提示 |
| `timeoutMs` | 删除（握手超时用 `connectTimeoutMs`） |
| `replyEnabled` / `replyHost` / `replyPort` | 删除（不再有入站入口，用 `acceptReplies` 开关） |
| — | 新增 `deviceId` / `acceptReplies` / `connectTimeoutMs` / `reconnectMinMs` / `reconnectMaxMs` |

Coopanion 侧需要同步升级到 0.3.0（ws 服务端 + 令牌表）；旧版的 `worlds.notify-receiver.dshReplyEndpoint` 与 `POST /notify` 不再使用。

## 0.2.0

- 新增 `notifyMode`：`auto`（默认）/ `turn` / `goal`；goal complete/block 映射为完成/失败通知。
- 自动模式在 goal 结束前静默中间轮次，并用 10 秒 recent-close 窗口避免最终 turn 重复通知。
- 新增 goal 状态播种与激活状态跟踪，插件重载后能恢复活跃 goal 判断。
- 新增 `/reply` 反向入口：Bearer 令牌、64 KiB 限制、8000 字符文本限制、`replyId` 去重。
- 回传消息通过 `sessionController.prompt({ mode: 'queue' })` 注入原会话，冷会话自动 resume。
- Client 半配置卡片：Settings 独立页、Plugins 页签、bundle 页和行配置。
- 测试：28 个 node:test。

## 0.1.0

- 最小可用：监听 `turn/end`，把完成/失败、设备、会话标题、耗时和摘要 POST 给 Coopanion。
- 失败只记日志，无重试；本地 link 安装，未发布 npm。
