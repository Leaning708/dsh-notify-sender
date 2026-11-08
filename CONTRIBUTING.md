# 贡献指南

本仓库是 DeepSeek Harness（DSH）插件 `dsh-notify-sender`：把任务结束通知发给 Coopanion，接收其转回的回复。对端 Coopanion World 扩展 `cortico-world-notify-receiver` 是姐妹仓库（协议权威在那边）。

## 开始之前

1. 读 [README.md](README.md)。
2. 读 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 的环境和本地安装。
3. 任何协议/行为变化，先改姐妹仓库的 `docs/PROTOCOL.md`，两侧同步再动代码。

## 提交前检查

```bash
corepack pnpm test   # 69 个 node:test
```

- 改了通知判定/多服务归一化 → 补 `test/notify.test.mjs`。
- 改了连接状态机/队列/心跳 → 补 `test/ws-client.test.mjs`。
- 改了配置卡片 → 补 `test/client.test.mjs`，并重启 DSH 目检一次。
- 不在仓库里放真实令牌、profile、日志、`node_modules`。

## 提交信息

建议用简短的祈使句，例如：

```text
fix: keep recentClose marker when notify is off
feat: import legacy wsUrl as a server entry
docs: archive dsh-side troubleshooting notes
```

## 发布/归档

见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 第 7 节。每次发布：

1. `version` 递增，并与姐妹仓库保持同代；
2. 写 `CHANGELOG.md`；
3. 跑 `pnpm test`；
4. `git tag vX.Y.Z`；
5. `git archive` 生成源码 zip。

## 问题反馈

排障先看 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。新问题请附：

- DSH / Coopanion 版本；
- DSH 日志里 `dsh-notify-sender` 的相关行（**令牌打码**）；
- Coopanion 侧 `/health` 结果；
- 是通知方向还是回传方向；
- 是否跨设备。
