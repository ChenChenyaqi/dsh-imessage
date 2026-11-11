# Changelog

本项目所有重要变更记录于此。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **M3 · 内核接线**：DshPort 契约与可编程 fake、session-router（懒验证三态/
  预绑定事务/串行锁）、gate（白名单 + 幂等 claim/unmark）、pipeline
  （at-most-once 状态机、ask 重试预算、send 失败不重试、权限失效停机、
  拉取连续失败上限）；崩溃恢复测试矩阵
- **M2 · iMessage 收发内核**（macOS 实测定案后自研）：chat.db 只读访问、
  typedstream 正文解码、消息归一化（防循环/占位降级）、osascript 发送
  （AI/系统双路径）、拟人化分段与打字延迟、权限探测；dev CLI 真机验收
- **M1 · 底座**：数据根与配置、号码归一化（E.164）、状态类型与原子写
  store（损坏自愈）、i18n（zh/en）、JSONL 日志（按天滚动 + 惰性清理）；
  工程链路（TS 严格模式 + esbuild 打包、`pnpm check` 质量门、
  lefthook/commitlint、双语 README、MIT）

<!-- 首个 tag 发布后启用版本对比链接： -->
<!-- [Unreleased]: https://github.com/<user>/dsh-imessage/compare/v0.0.1...HEAD -->
