# 排障（DSH 侧）

0.3.0 只有一条链路：DSH（客户端，本插件）→ Coopanion 的 `/ws`（服务端，姐妹仓库 `cortico-world-notify-receiver`）。本文覆盖 DSH 侧的现象；服务端视角的整条链路排障见姐妹仓库的 `docs/TROUBLESHOOTING.md`。

**排障顺序**：DSH 插件日志 → Coopanion `/health` → 令牌 → 地址/防火墙 → 本插件的通知判定。不要一上来改代码。

## 1. 先做三个检查

```powershell
# 1) 服务端在不在监听（在装了 cortico-world-notify-receiver 的机器上）
curl.exe -sS http://127.0.0.1:3210/health
# 期望：{"ok":true,"world":"notify-receiver","protocol":"dsh-notify.ws.v1","listening":true,"onlineDevices":1}

# 2) DSH 插件日志：搜 dsh-notify-sender（连接、重连、ack、注入失败都会留一行）

# 3) 配置卡片还在吗：Settings 左栏「Coopanion Bridge」
```

## 2. 一直重连（连上又被断开）

按关闭码判断（DSH 日志里会写）：

| 关闭码 | 原因 | 处理 |
|---|---|---|
| `4401` | 令牌不对/为空 | 检查 Coopanion「令牌」页与本插件 `token` 是否是同一个（区分大小写、别带空格） |
| `4403` | 令牌被禁用/删除，或 `Origin` 不受信 | 重新建令牌；换新令牌后连接会自动恢复 |
| `4408` | 5 秒内没发 `hello` | 网络太慢或客户端版本不对 |
| `4409` | 同 `deviceId` 有更新的连接 | 两台机器 `deviceId` 撞了（默认取主机名哈希），给其中一台配 `deviceId` |
| `4429` | 在线设备超 `maxDevices` | 提高上限或断开不用的设备 |
| `1013` | 背压/限流/World 重启 | 等退避重连；频繁出现看姐妹仓库排障文档 |

连接正常时插件日志不会刷屏；每 30 秒一次心跳是正常的。

## 3. Coo 不说话（通知没到）

1. `/health` 里 `devices` 是否 ≥ 1；为 0 说明本插件根本没连上（见第 2 节）。
2. 本插件 `enabled` 是否为 true、`notifyOnCompleted`/`notifyOnFailed` 是否开着。
3. `notifyMode` 是不是 `goal`——`goal` 模式对普通对话完全静默，没有建 goal 的长任务请用 `auto`/`turn`。
4. 是不是子代理会话？子代理会话固定不通知（0.3.2 起没有开关）。
5. `minTurnMs` 是否把短回合滤掉了。
6. Coo 是不是在忙（一轮还没结束）？事件会排队，等它这轮结束才说。
7. 连接正常但没通知：检查是否被 `msgId`/turn 去重命中（换任务或等下一轮再试）。

## 4. 回复没有转回 DSH

1. `acceptReplies` 是否打开——关掉时本插件会回 `reply-result{ok:false}`，Coopanion 侧记一条 `dsh-notify.reply-failed` 事件。
2. **关键字在 Coopanion 侧配置**（`worlds.notify-receiver.replyKeywords` 等）；关键字留空 = 关闭回传。
3. 会话还在吗：DSH 重启后旧 session 可能被清理，注入会失败并在日志里写原因；`reply-result{ok:false}` 会让 Coopanion 重试。
4. `text` 超过 8000 字符会被 Coopanion 先截断，一般不会触发注入失败。

## 5. 睡眠唤醒后通知延迟

- 客户端在连续 2 个心跳周期收不到 `ping` 时主动重连（并用 ws 原生 ping 兜底）；Windows 从睡眠恢复时几秒内自动恢复，属预期行为。
- 切换网络（WiFi ↔ 有线）会换源 IP，按退避重连，`deviceId` 不变，不会产生“新设备”。

## 6. Settings 里看不到「Coopanion Bridge」

DSH **不会**为插件自动生成配置 UI，卡片来自 `lib/client.js` 的 Client 半。

1. 包里有 `dsh.client` 和 `lib/client.js`。
2. **完全退出 DSH 再打开**；只刷新页面不够，Host 只在启动时扫描 Client 半。
3. Settings → Plugins 里 bundle 是否 active。
4. 还是没有，就在 profile 的 `cordis.patch.yml` 里给这一行写 `config:`（见 README）。

## 7. 安装类问题

### 插件激活报 `ERR_MODULE_NOT_FOUND`

link 安装的包不会被宿主连带装 `dependencies`。在包目录自己跑一次：

```bash
corepack pnpm install
```

然后完全退出 DSH 再打开。

### `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`

```powershell
$env:CI = 'true'; corepack pnpm install
```

### `ERR_PNPM_OUTDATED_LOCKFILE`

```bash
corepack pnpm install --no-frozen-lockfile
```

### 测试失败

```bash
pnpm test   # 69 个 node:test
```

## 8. 怎么安全地重置

- 本插件：profile 的 `cordis.patch.yml` 里插件行配置，改前备份；删掉 `enabled` 或改成 false 即可停用。改名前（`dsh-cortico-world-bridge`）的旧配置 key 不再延续，重新填服务列表即可。
- 服务端（令牌、`worlds.notify-receiver` 配置、`tokens.json`）在姐妹仓库，重置方法见其 `docs/TROUBLESHOOTING.md`。
- 不要直接删 `node_modules` 当修复手段；先看是不是依赖没装。
- 真实令牌、日志、profile 配置不要提交到 Git。
