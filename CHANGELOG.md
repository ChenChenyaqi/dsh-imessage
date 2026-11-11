# Changelog

本项目所有重要变更记录于此。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **M2 · iMessage 收发内核**（macOS 面，全部实测定案后自研）：
  - 权限探测（FDA + Messages 自动化，错误分类，探测结果绑定当前宿主环境）
  - chat.db 只读访问层：readonly 直读 WAL 实时数据；schema 探测防 macOS 升级；
    纳秒时间戳 CAST TEXT 无损通道；群聊按成员数判定
  - typedstream 解码器：定位扫描式提取正文，降级永不丢消息；结构脱敏 fixture 驱动
  - 归一化管道：防循环（fromMe/[dsh] 前缀/群聊/非法 handle）、占位降级
    （纯附件/不可解码的英文协议标记）、conversationKey 派生
  - osascript 发送层：按 buddy 定位、AppleScript 实测转义、错误三分类、
    AI/系统双路径（[dsh] 前缀）
  - 拟人化编排：一行一气泡、代码块不切断、思考窗/打字节奏/抖动/夹逼延迟，
    rng/sleep/abort 可注入
  - dev-only CLI（probe/peek/send/listen）真机验收，见 docs/CHECKLIST-M2.md
- **M3 · 内核接线（大脑）**：
  - DshPort 端口契约（createSession/getSessionStatus/ask 流式，SessionId
    branded 防伪）+ 可编程 fake（故障注入、并发窗口）
  - session-router：懒验证三态（active/archived/missing）+ 不按名复活 +
    预绑定事务（孤儿会话无害化）+ per-key 串行锁 + bindHistory 台账
  - gate：seen 查重优先于白名单 + claim/unmark 纯函数（环形容量）
  - pipeline：claim 先落盘的 at-most-once 状态机；ask 重试预算（3 连败
    吞 + 系统告知，不堵塞通道）；send 失败不重试（不重复回复）；
    权限失效停机；轮询退避；崩溃恢复矩阵四场景测试
- **M1 · 底座**：数据根 `~/.dsh-imessage/`（env 可覆盖）、号码归一化（E.164 实测校准）、
  白名单策略、消息/通道状态/配置类型、i18n（zh/en）、JSONL 日志（按天滚动 +
  惰性清理）、原子写与损坏自愈 state store

### Added

- cordis 插件骨架：`apply()` 生命周期入口与插件标识常量，经 DSH 宿主（`dsh --patch`）真实加载验证
- 工程链路：TypeScript 5.9 严格模式 + ESM 单文件打包（esbuild → `lib/index.js`，含 sourcemap），`prepack` 钩子在发布前自动构建
- `@/*` 路径别名：tsconfig `paths` 映射，typecheck / lint / 打包 / 测试四层全通
- 质量门禁 `pnpm check`（typecheck + lint + build + test 一键全绿）
- Git hooks（lefthook + commitlint）：pre-commit 跑质量门，commit-msg 强制 Conventional Commits 格式
- 双语 README（中文默认 + [English](./README.en.md) 互跳）、MIT LICENSE
- 文档：`docs/PLAN.md`（里程碑计划 M1–M4 + P1/P2 池）、`docs/ARCHITECTURE.md`（dsh-im 解构蓝图与架构决策）

<!-- 首个 tag 发布后启用版本对比链接： -->
<!-- [Unreleased]: https://github.com/<user>/dsh-imessage/compare/v0.0.1...HEAD -->
