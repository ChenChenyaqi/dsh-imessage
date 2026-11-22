# M6.2 发图/发文件 · 设计与实施方案

> 状态：**待拍板**（6 分叉见文末；macOS 版本门已关）。事实依据见同目录
> `probes.md` ③（sendFile 语法、暂存纪律终态）与本文「源码事实」节
> （dsh-im outbound 链路 + DSH tools 服务，2026-11-22 本地源码核对）。
> 范围：**发送侧**——AI 产出的图片/文件经 osascript 附件发给 iMessage
> 对方。收图是 M6.1（已落地）；引用回复携带图是 M6.3（另立）。

## 场景

对方在 iMessage 里要东西（"把刚才那张图发回来""把报告发我"）→ AI 在
workspace 找到/生成文件 → 声明交付 → 插件把文件作为 iMessage 附件发出。

**发送基建是确定的**（探针③终态）：`send POSIX file` 语法 + tmpdir 暂存
+ 1h 保留 + 发送时清扫。**内容源是本设计的主分叉**（见分叉 1）。

## 源码事实（2026-11-22，本地仓库核对）

dsh-im（B 面网关）的 outbound 链路，`src/channels/shared/`：

- **自定义交付工具**（`semantic/artifact.mjs`）：`ctx.tools.register`
  装 `dsh_im_return_file({path})`——AI 声明"此文件要发给 IM 用户"；
  description 原文强调 *"Success means queued, not sent; do not claim
  the user has received the file"*（防 AI 谎称已送达）+ *"in Web,
  Desktop, or CLI conversations use the host present tool"*（防误用）
- **按 turn 收集**：工具执行时读文件入 `OutboundArtifactRegistry`
  （key = sessionId + turn，snapshot 到受管目录防 AI 后续改动文件）；
  ask 回答文本发出后 `take(sessionId, turn)` 保序取出逐个发送
- **发送与暂存**（`imessage/outbound-artifacts.mjs`）：暂存
  `os.tmpdir()/dsh-im-out-${pid}-${ts}-${name}`、mode 0600、**发送返回后
  不删**（Messages helper daemon 异步摄取，竞态删除 = transfer_state=0
  卡死无错误）；**下次发送时**按前缀 + mtime > 1h 清扫，无定时器；
  清扫失败仅日志（cosmetic，不阻塞发送）
- **失败路径**：单文件失败不中断后续；失败后发一条失败通知文本
  （含文件名的 i18n 词条）

DSH 宿主（A 面插件视角）：

- `tools` 是 cordis 服务（`packages/core/tools`，`super(ctx, 'tools')`），
  `register(definition)` 返回卸载函数；支持全局与 per-agent scope 两层
  （per-agent 需 agentCtx 钩子，复杂）
- tool-present（deliverables 家族）证明宿主内插件注册工具是官方用法
- **`@deepseek-ai/dsh-tools` npm 包不随宿主暴露给插件**（node_modules
  无传递依赖）——`defineTool`/`ToolDefinition` 需本地最小面声明 +
  鸭子注册（`HostAttachmentsService` 同款纪律，老宿主降级）
- 工具执行可拿 `exec.agent`（sessionId）→ 可反查我们的会话路由表

## 数据流（分叉 1 按 α 拍板后）

```
AI 调 imessage_send_file({path})          ← 工具执行：路径校验 + 读 bytes 入队
  （队列 key = sessionId + 本轮 ask；每轮 ask 开/收一次）
ask 流 ──▶ 文本回复（humanize 分段，现路径零改动）
  ──reply-sent──▶ 队列保序逐个：
      写暂存（tmpdir, 0600, dsh-imessage-out-<pid>-<ts>-<name>）
      ──清扫 >1h 同前缀旧文件（失败 cosmetic）
      ──▶ osascript: send POSIX file "<path>" to targetBuddy
  ──全部完成──▶ message-done（旁支：单文件失败 → 失败通知文本 + file-send-failed）
```

## 设计要点

- **DshPort 接缝不变**：ask 仍是 text delta 流；artifacts 不走 ask 返回值，
  走"工具回调 → collector 队列 → pipeline 收尾交付"旁路。core 用自有
  `OutboundArtifact {bytes, fileName}`（内存形态），真 IO 全在 host 组装层
- **工具语义 = 排队而非送达**：description 照抄 dsh-im 措辞（queued not
  sent / do not claim received），AI 侧不产生"已发送"错觉
- **全局注册 + 执行时路由校验**：工具注册到宿主全局（所有会话可见），
  执行时校验 `exec` 会话 ∈ 当前 imessage 路由表，否则报 ToolArgsError
  （Web/桌面会话误调 = 无害报错）。比 per-agent scope 简单得多（分叉 2）
- **暂存纪律照抄探针③终态**：前缀用 `dsh-imessage-out-`（与 dsh-im 的
  `dsh-im-out-` 区分，避免共存时互相误清扫）；发送返回后**不删**；
  下次发送时清扫 >1h 同前缀文件；清扫失败仅日志
- **at-most-once 沿用**：sendFile 失败不重试（与 sendText 同款定案）；
  失败发 i18n 通知文本（含文件名），后续文件继续
- **无转码无预检**：AI 产出图格式（png/jpeg/webp/gif）Messages 原生
  支持；大小不做本地预检（通道是权威——M6.1 分叉③同向）。内存保护
  例外见分叉 5
- **权限错误分类复用** sendText 的（`-1743` / not authorized /
  assistive——`SendError` code 面），排障同一条链路

## 变更清单

### core

| 文件 | 变更 |
| --- | --- |
| `imessage/sender.ts` | 增 `sendFile(key, path)`：osascript `send POSIX file` 模板（探针③语法）、路径转义、错误分类复用；deps 注入同现状 |
| `imessage/outbound.ts`（新） | `stageOutboundFile(bytes, name, deps)`（tmpdir + 0600 + 前缀命名）与 `sweepStaleOutbound(deps)`（前缀 + mtime > 1h，失败 cosmetic）；fs deps 全注入，CI 可测 |
| `router/artifacts.ts`（新） | `ArtifactCollector`：`open(sessionId)` / `push(sessionId, artifact)` / `take(sessionId)`——每轮 ask 开/收，防跨轮泄漏；core 纯内存 |
| `router/pipeline.ts` | deps 增 `collector`（可选，缺省 = 无发文件能力）；processAccepted：ask 前 `open`，reply-sent 后 `take` 逐个 `sendFile`；失败旁支 + 通知文本；`message-done` 前收尾 |
| `types/i18n.ts` | 失败通知词条（含 `{name}` 占位）；`[dsh] ` 前缀 system 路径（错误告知本就 system 语义） |

### host

| 文件 | 变更 |
| --- | --- |
| `dsh-api.ts` | 本地最小面：`HostToolsService {register(def): () => void}` + `HostToolDefinition`（name/description/parameters/execute——鸭子形状，实施时以真宿主探针校准） |
| `deliver-tool.ts`（新） | `installDeliverTool(services, collector, routeTable)`：动态 `get('tools')`，无服务 = 不注册降级；工具定义（description 措辞照抄 dsh-im）+ 执行校验路由 + push collector |
| `channel.ts` | 组装：nodeOutboundDeps（真 fs/osascript IO）+ collector 接线 pipeline 与工具闭包 |
| `index.ts` | `toolsService(ctx)` 动态获取（attachments 同款纪律） |

### 日志（新事件）

- `artifact.queued`（工具声明入队：`sessionId`、`name`、`bytes`——内容永不入日志）
- `outbound.staged`（暂存路径落成：`name`、`bytes`）
- `outbound.swept`（仅 deleted>0 打点；清扫跳过不刷屏）
- `file-sent`（对齐 `reply-sent` 命名：`key`、`name`、`bytes`）
- `file-send-failed`（`code`、`name`；at-most-once 不重试）
- 链路位次：`reply-sent` → `outbound.staged` → `file-sent` … → `message-done`

## 分步交付

- **Step A · 发送基建（✅ 2026-11-22 完成，含真机实证）**：
  `sender.sendFile` + `outbound.ts`（暂存/清扫）+ `pnpm dev` 扩
  `send-file` 子命令。真机（macOS 15.7.3）实证：`send POSIX file`
  语法可用（无需版本门）；home 路径直发 = attachment
  transfer_state=6 静默丢失（rowid 2742 对照），tmpdir 暂存后发 =
  transfer_state=5 投递成功且 daemon 拷贝入白有 Attachments 目录
  （rowid 2743）——暂存纪律本机复现确证
- **Step B · 交付工具与管线**：`ArtifactCollector` + `deliver-tool.ts`
  + pipeline 交付段（fake tools 服务：注册形状/路由校验/降级/
  保序/失败旁支测试）
- **Step C · 收尾**：失败通知 i18n + `AGENTS.md` 事件清单 + 真机 e2e
  （对方会话收到文件、暂存 1h 清扫验证、Web 会话误调工具无害）

## 待拍板分叉

| # | 分叉 | 推荐 | 理由 |
| --- | --- | --- | --- |
| 1 | **内容源**：α 自定义交付工具（dsh_im_return_file 同构）/ β 监听宿主 present 产物 / γ systemPrompt 协议标记 | **α** | dsh-im 已验证语义；present 是"给 DSH UI 用户"的交付卡片，语义错位；γ 需 systemPrompt 注入点且 AI 遵从协议不可靠。β 可作 M7+ 增补，与 α 不互斥 |
| 2 | 工具注册作用域：全局 + 执行时路由校验 / per-agent scope | 全局+校验 | per-agent 需 agentCtx 生命周期钩子，复杂度高一个量级；误调已收敛为无害报错 |
| 3 | bytes 入队时机：工具执行时读 / 发送时读路径 | 执行时读 | 前置校验（存在/可读）+ 免路径失效（AI 后续改动/删除文件）；代价 = 内存驻留一轮 ask，量级可控 |
| 4 | 发送失败通知：i18n 文本词条 / 静默 log | 文本词条 | 对方知道"有个文件没发出来"才能补救；dsh-im 同款（sendFailureNotice） |
| 5 | 单文件内存保护上限 | 入队时 50MB 上限（超限 = 工具报错） | 无上限时 AI 可把超大 workspace 产物塞进内存；50MB 量级覆盖 iMessage 实用附件（真机 Messages 上限实测后校准） |
| 6 | 多文件发送顺序与并发 | 保序串行 | 串行 = iMessage 顺序到达可预期 + osascript 单实例约束（并发 AppleScript 事件竞态风险，sendText 现状同款串行） |

~~另：macOS 26 门（send POSIX file 语法依赖）在 Step A 真机实测定。~~
已实测关闭：15.7.3 语法可用；真正的门不是版本而是暂存路径（home =
transfer_state 6 静默丢失，tmpdir = 5），outbound.ts 的暂存已覆盖。
