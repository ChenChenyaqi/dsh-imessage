---
name: Bug 报告
about: 机器人不回复 / 收发异常 / 崩溃
labels: bug
---

## 现象

<!-- 一句话说清：预期发生什么，实际发生了什么 -->

## 排查信息（先看日志再填）

日志在 `~/.dsh-imessage/logs/imessage-YYYYMMDD.jsonl`（一行一个 JSON 事件）。
对照 [AGENTS.md 的「日志与排查」速查表](https://github.com/ChenChenyaqi/dsh-imessage/blob/main/AGENTS.md#日志与排查)：

- 有没有 `channel.started`？没有 = 插件没启动（看 `channel.probe-failed`）
- 有没有 `pipeline.fetch`？没有 = 没拉到消息（chat.db / 权限）
- 有没有 `message-skipped`？reason 是什么（`not-allowlisted` / `already-seen`）？
- 有没有 `send-failed`？有 = 发送 / 权限问题

相关日志行（**号码与消息内容必须脱敏，聊天正文一律不粘贴**）：

```
粘贴相关日志行（脱敏后）
```

## 环境

- macOS 版本：
- DSH 版本（`dsh --version`）：
- 插件版本：
- 配置（白名单只写脱敏格式，如 +86138xxxxxxx）：
