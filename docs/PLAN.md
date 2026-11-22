# dsh-imessage · 实施计划

> 只写 plan：宏观里程碑路线图、范围与验收边界。
> 已确认决策（D1–D9）与风险对策见 `ARCHITECTURE.md`；各里程碑具体设计见
> 对应需求目录的 `plan.md`（索引 `docs/README.md`）。

## 里程碑（MVP = M1 → M4）

每个里程碑收口 = 测试绿 + 验收项过 + 无 TODO 悬挂；每步收口 =
源文件 + 镜像测试 + `pnpm check` 全绿。

### M1 · 底座 → **完成 [x]**
数据根与路径（`~/.dsh-imessage/`，`DSH_IMESSAGE_HOME` 可覆盖）、纯类型契约、
iMessage 回复文案 i18n（zh/en）、JSONL 结构化日志、原子写 state store。
具体设计见 `docs/foundation/plan.md`。

### M2 · iMessage 收发内核 → **完成 [x]**
权限探测、chatdb 只读 JOIN、typedstream 解码、normalize 防循环、
sender/humanize 双路径发送（AI 拟人化 vs system 路径）。
具体设计见 `docs/imessage-kernel/plan.md`。

### M3 · 内核接线 → **完成 [x] 2026-11**（224 测试全绿）
session-router 预绑定事务、绑定模型与懒验证三态、gate 白名单+幂等、
pipeline 单向流与 ask 重试预算、崩溃语义 at-most-once。
具体设计见 `docs/session-pipeline/plan.md`。

### M4 · 插件宿主 → **MVP 完成 [x] 2026-11-13**
cordis 生命周期、DshPort apiProxy 适配、通道装配与热更、管理 RPC、
设置页客户端 UI、全链路日志、真机 e2e。验收 = 一问一答稳定 +
24h 连续运行 + 重启不丢不重 [x]。切换流程：上线前先停 dsh-im 的
iMessage bot（避免双端抢消息），白名单手动迁移。
具体设计见 `docs/host-integration/plan.md`（含 settings-ui / host-api 子目录）。

### M5 · 人设（agent preset）→ **完成 [x] 2026-11-13**
preset 子包（脱敏版 dafeiyu）、会话贯通（composition 创建时定格，
热更只影响新会话）、设置页下拉（remote roster）、逐会话优雅降级。
具体设计见 `docs/agent-preset/plan.md`。

### M6 · 媒体收发 → **完成 [x] 2026-11-22**（670 测试全绿，分支覆盖 95.66%）
收图（HEIC→JPEG 转 sips，以内容块进 ask）、发图/发文件（osascript 附件 +
tmpdir 暂存纪律 + imessage_send_file 交付工具）、引用回复携带媒体（引用块
+ 引用图进 ask）。验收（真机）：收发各一条、转码、附件不残留、引用四场景
（us/them 文字、纯图引用、caption+图）——记录见各设计文档验收段。
具体设计见 `docs/media-exchange/plan.md`。

### M7 · 身份与上下文
- 把"正在跟谁说话"（白名单号码 → 联系人名/自定义称呼）注入会话上下文
  （dsh-im 7fe9f4be）；联系人来源与隐私边界开工时定案
- 评估：贴纸集等轻量上下文（c90abcda）是否纳入

### M8 · 命令与交互打磨
- slash 命令回执合并为单条气泡（47def401）；/help 全量列命令（eb657c57）
- 产品定案项：system 路径的 `[dsh] ` 前缀去留（dsh-im 已移除机器人前缀
  642ad21b；我们当前定案是保留以区分系统消息——需重审）

### M9 · 主动关怀（独立产品方向，需单独设计再排期）
- spontaneous outreach：情绪/动机/安静时段（ac986877）；
  every 区间硬上限（a47098a5）、强制唤醒绕过安静窗且节奏中性
  （df8a26c3/0979ebeb）、slash 不重置安静钟（0e8b2969）
- 主动外发可携带文件（ef0d2af6）；后台轮次（日程提醒）中继到绑定会话
  （0facfec5/d2132d01）
- 复杂度高、与 DSH 后台任务机制耦合深：开题前先出设计文档拍板

### 已覆盖、无需规划（对照 dsh-im v5.10.0 后提交）
分段发送 + 拟人延迟（我们且已可配置）；显式白名单（bb96f094）；
策略拒绝留痕（4b264fc4，我们的 message-skipped 日志）；单文件链路日志
（269fa94e）；设置页保存免重启（b6f29b20）；workspace 重复建会话
（08aae795，我们的 session-router 预绑定事务设计已规避）
- P1：收图（HEIC→JPEG via sips）、引用回复注入 prompt、发文件（macOS 26 `send POSIX file`）、`/help` `/new` `/sessions` `/bind` 命令（`/sessions` 只列发起者 bindHistory 内的会话、`/bind` 只能切到台账内目标；切换手机号绑定的 DSH 会话，记忆跟会话走、工作区不变）、联系人备注上下文、会话标题
- P2：companion（scheduler / motives / mood / controller，状态持久化）、表情包上下文、设置页 UI（权限引导 / 白名单 / 参数表单热更新 / **会话绑定可视化切换**）、模型选择
