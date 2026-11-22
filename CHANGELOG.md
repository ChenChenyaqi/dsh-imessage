# Changelog

本项目所有重要变更记录于此。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.2.0] - 2026-11-22

支持 AI 接收与发送图片、文件。

### Added

- **收图**：iMessage 收到的图片自动进入 AI 对话，直接发图即可提问；
  HEIC 由系统 sips 转 JPEG，不支持的格式安全跳过不影响文字
- **发图/发文件**：AI 声明交付后，文件通过 iMessage 原样发送（任意
  格式，50MB 上限）；暂存文件一小时保留、发送即清，发送失败时以
  系统消息告知
- **引用回复**：收到引用回复时，AI 能看到被引用的内容与图片，并
  区分引用来源是 AI 自己还是联系人；原消息已被清理时降级为提示，
  不再答非所问

### Changed

- katex 依赖固定到 ^0.18.2 修复安全告警，其余依赖例行升级

## [0.1.2] - 2026-11-16

兼容性与重构版本：修复 DSH 0.2.2-rc.3 宿主下设置页打不开的问题；
设置页 UI 代码整体换代，用户行为不变。

### Fixed

- **DSH 0.2.2-rc.3 下设置页打不开（点开整卡空白）**：宿主表单的方法
  是原型方法，作为引用传给 React 的订阅与保存链路时 this 丢失即崩。
  改为一律在对象上调用，已在 rc.3 真机验证通过

### Changed

- 设置页 UI 架构重构：状态机解体为按字段划分的独立模块，编辑语义
  （草稿优先、全量覆盖原子保存、关页丢草稿）由测试锁定
- 测试 fake 与真宿主同形状（原型方法），这类调用错误在单测层即可拦截
- CI 精简与发版文档更新的例行维护

## [0.1.1] - 2026-11-14

维护性版本：`src/` 与 `preset/` 无改动，除构建产物重新生成外，包功能与 0.1.0 一致。
这一版修掉一个会让全新 clone 构建失败的 bug，并把发版流程交给 CI。

### Fixed

- **全新 clone 后 `pnpm build` / `pnpm check` 失败**：`.gitignore` 的 `lib/`
  未锚定根目录，把 `scripts/lib/` 一并忽略，导致客户端构建脚本
  `client-bundle.mjs` 从未进过仓库。本地有文件所以一直没暴露，
  换台机器或 CI 一拉就挂。改为 `/lib/` 锚定并补交文件
- **依赖安全告警**：minimatch 10.2.6（medium，globparts 放大导致 DoS）
  经 eslint 链路引入。升级 eslint 至 10.15 带不动它——
  `@typescript-eslint/typescript-estree` 上游仍写死 `^10`，故对该包
  定向 override 到 minimatch 11，Dependabot 告警已转 `fixed`

### Changed

- **发版自动化**：在 GitHub 发布 Release 即触发 workflow，用 npm
  Trusted Publishing（OIDC）发布两个包，不存任何长期 token，并生成
  provenance 证明。版本一致性与 CHANGELOG 段落抽取由 33 个测试兜底
- **分支保护**：main 要求走 PR 且 `gate` 检查通过；新增固定名 `gate`
  汇总 job，避开矩阵展开的 `check (22)` / `check (24)` 随 Node 版本
  变动后永远等不到结果的问题
- **工程基线**：Dependabot（DSH 全家桶单独分组）、issue/PR 模板、
  SECURITY.md、`packageManager` 与 `.nvmrc` 固定工具链；发版流程
  收敛为 AI 执行的 skill，交互点只剩版本号与 CHANGELOG 确认

## [0.1.0] - 2026-11-14

首个公开版本：把 macOS 原生 iMessage 接入 DSH 的 cordis 插件 MVP——收发内核、白名单与会话路由、拟人分段回复、大肥鱼人格预设、设置页 UI、真机 e2e。

### Added

- **M4 · 插件宿主（MVP 完成 ✅ 2026-11-13）**：cordis apply 生命周期 +
  Config schema（volatile 热更）、DshPort 的 apiProxy 适配、status 只读
  RPC（无 connection 服务宿主优雅降级）、官方类型包编译期兼容守护；
  desktop profile 软链真机验收（一问一答、24h 稳定、重启不丢不重）
- **设置页**（客户端 UI 插件，`dsh.client` 双面包）：iMessage 卡片——
  系统提示语言、白名单（标签式增删 + 实时校验）、分段回复（开关 +
  最大分段数 + 延时系数）；UI 保存原子写 patch 并热生效；关闭设置页
  即丢弃未保存草稿
- **分段回复可配置**：默认关（整段直发零等待）；开启时按行分段、
  超上限并入末段、打字延迟 × 系数（乘后夹逼 ≤5s；0 = 分段不延时）；
  每段前均等待（含末段，真人连发节奏）
- **全链路日志**：生命周期（probe/started/stop）+ 单条消息链路
  （fetch→claim→ask→reply→done）；配置热更留痕；正文永不入日志
- **真机 e2e**：Playwright + 系统 Chrome，隔离 DSH_HOME 自动清理，
  ~4 秒跑完设置页全流程

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

[Unreleased]: https://github.com/ChenChenyaqi/dsh-imessage/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ChenChenyaqi/dsh-imessage/releases/tag/v0.1.0
