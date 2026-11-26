# M7 · 身份与上下文（identity & context）

> 状态：**已实施完成，真机验收通过（2026-11-26）**，随 M7 PR 合入 main。
> 目标：告诉她"正在跟谁说话"——白名单号码 → 称呼注入会话上下文；
> 贴纸集等轻量上下文不纳入（管道预留，M9 评估）。

## 场景

白名单里现在只有裸号码。她收到 `+86138…` 的消息时：

- 不知道对面是谁，要么每轮问"你是谁"，要么瞎猜（dsh-im 7fe9f4be
  的动机原文："answered a bare prompt with no idea who was on the
  other end, so she either asked every session or guessed"）
- 多人白名单时无法区分记忆（会话按号码隔离了，但同一个人换说法、
  或者她想在对话里自然称呼对方，都需要一个名字锚点）

## 源码事实（2026-11-23 本地仓探针）

### DSH 宿主（deepseek-harness @ dsh-v0.2.2-rc.3）

| 事实 | 坐标 | 含义 |
| --- | --- | --- |
| `systemPrompt` 是 cordis 服务，`context({name, order, text})` 注册**动态 prompt 上下文**，返回 disposer | `packages/core/system-prompt/src/index.ts:520`（服务类 `:453`，`ContextOrd ers` 常量表） | 插件可注入该服务发布 per-session 上下文，文本进 system prompt 而非 user 消息 |
| `AssembleContext` 官方形状只有 `{scope?, signal?}` | `system-prompt/src/index.ts:42` | text 回调收到的对象基础面很窄 |
| **`agent?: Agent` 是 agent 包对 `AssembleContext` 的模块扩充**（declaration merging） | `packages/core/agent/src/runtime-types.ts:19-24`（"Agent for this assembly; absent on diagnostics"） | text 回调里 `context.agent?.session?.id` 可拿到当前 session——dsh-im 的 per-session 查表写法成立 |
| 先例：agent-loop 自己用 `context.agent?.options.provider` | `agent-loop/src/index.ts:336` | 模块扩充是一等用法，不是私有洞 |
| `text` 支持 `string \| (context) => string`，`order` 必须有限数（否则 TypeError） | `system-prompt/src/index.ts:66, 522-525` | 动态查表 + 固定 order |

### dsh-im 先例（imessage-peer.mjs，104 行，7fe9f4be）

- **数据源**：`~/.dsh/im/contacts.json`（handle → 昵称 map）；缺失/损坏/
  形状不对一律降级为裸 handle，不阻塞聊天（`loadPeerName`）
- **查表**：进程内 `PeerRegistry`（sessionId → note 文本），上限 1024
  条 LRU 淘汰；text 回调 `registry.get(assembly?.agent?.session?.id) ?? ''`
  ——**非 iMessage 会话与未发布会话拿到空串，天然不可见**
- **发布时机**：首条消息建立绑定时 / 已绑定会话来新消息时 / 启动时
  对已知会话全量发布
- **文案**（中文，zh 硬编码）：`[对话来源] 你正在通过 iMessage 私聊…`
  + handle（有昵称带昵称，无昵称提示"可以问"）+ 记名字指引（把条目
  写进 contacts.json，mid-chat 学的名字存活过 Session）+ "认不出就直说，
  别瞎猜"
- **注入**：`ctx.inject(['systemPrompt'], …)` 后 `installPeerContext`
  返回 disposer，与贴纸上下文（c90abcda，同管道 order 124 相邻）一起
  倒序销毁
- 贴纸上下文（c90abcda）：目录文件名清单 + 何时发/不发/一次最多一张 +
  引用路径格式；目录空则整段消失

### 本仓现状

| 层 | 现状 | 缺口 |
| --- | --- | --- |
| 会话路由 | conversationKey（号码）↔ HostSessionId 绑定持久化；`router.session-created` 事件已有 | 绑定表就是"哪些会话属于 iMessage"的完整事实，只是没人消费 |
| pipeline | 每 ask 携带 routed.sessionId | 发布上下文的天然挂点已存在 |
| host 服务注入 | 可选服务走 `ctx.get?.('name')` 动态探测（attachments/tools 先例）；静态 inject 缺服务会让插件静默等待永不激活（`host/index.ts:183` 探针注释） | `systemPrompt` 未接入；同款可选探测即可 |
| 配置面 | PluginConfig flat + Schemastery 自动表单（allowlist 是 `string[]`） | 无称呼字段；`object/dict` 类型的表单生成质量未探针 |
| 设置页 | iMessage 卡片（React 自有 UI，非纯自动表单） | 可自行承载称呼编辑（不必依赖 Schemastery 字段级表单） |

## 分叉（已定案）

### 分叉① 称呼数据源 → **定案：Config 存储（2026-11-23 实施中修正）**

> 原推荐（自有文件 `~/.dsh-imessage/contacts.json` + RPC 读写）在 Step C
> 真机 e2e 中被推翻：为写自有文件必须自建浏览器 RPC 通道，连坐三个
> 真机 bug（见下）；且 allowlist（手机号，比称呼敏感）本就存 profile，
> 称呼同存不增加隐私面。终态 = **plugin config 的 `contacts` 字段**
> （`Record<归一化号码, 称呼>`，volatile），与 allowlist 同机制：设置页
> 编辑 → `form.mutate` → loader 提交 → `loader/volatile-update` 热更重发。
>
> e2e 探针坐实的三 bug（修复保留在库，教训入事实库 plugin.md/rpc.md）：
> ① cordis `ctx.inject(deps, cb)` 的服务在回调参数上，M4 起 status 路由
> 从外层读 connection 恒 undefined，从未注册（fake 纵容）；
> ② 浏览器侧不能裸 `fetch('/api/...')`（Host/Origin 围栏 + 鉴权，必 404），
> 必须走 `ctx.connection.rpc.call`；
> ③ 客户端服务要在 `package.json` 的 `dsh.client.inject` 声明才注入。
>
> 实施回退删：contacts.json store/types、contacts RPC、client api.ts、
> connection 声明（≈ −520 行）；留：peer-note/registry/systemPrompt 注入。

原始分叉记录（定案过程存档）：

| 选项 | 内容 | 取舍 |
| --- | --- | --- |
| ~~α 自有文件 + 设置页编辑~~（被推翻） | ~~`~/.dsh-imessage/contacts.json` 原子写 + RPC 读写~~ | ❌ 自建 RPC 通道成本高（三 bug 见上）；❌ 与 profile 分离，备份/迁移两处 |
| **Config 存储（终态）** | `contacts` volatile 字段，设置页卡片编辑 | ✅ 零新通道（与五项既有字段同机制）；✅ 隐私面 = profile（allowlist 同域）；✅ 热更链路现成 |
| β dsh-im 同款 contacts.json（AI 可写） | 同一文件，AI 自己写条目 | ❌ AI 可写落盘文件 = 隐私审计面冲突；❌ 写坏 JSON 靠降级兜底 |
| γ 读 macOS Contacts.app | Contacts.framework 自动取全量联系人 | ❌ 权限重；❌ 数据面远超白名单，违背隐私承诺，不采纳 |

推荐 α：白名单是用户手动圈定的小集合，手填称呼成本可忽略；β 的
"AI 学名字"诱人但把文件写权给了模型——真想要，后续里程碑在 α 的
store 上加受控工具（白名单内 handle 才能写）即可演进，不必现在赌。

### 分叉② 注入路径

| 选项 | 内容 | 取舍 |
| --- | --- | --- |
| **α `systemPrompt.context` 服务（推荐）** | dsh-im 同款：注册一个 context（`ctx.get?.('systemPrompt')` 可选探测，无则降级不注入），text 回调按 `agent.session.id` 查内存表 | ✅ 官方接口（agent-loop 自己在用）；✅ system 级文本不污染 user 消息、不占每条消息的 token 重复；✅ 非 iMessage 会话天然不可见；❌ 宿主接口演进风险（老宿主无服务 → 降级，聊天不受影响——同 M6.1/M6.2 可选服务纪律） |
| β 拼 ask prompt 前缀 | buildPrompt 里加身份前缀 | ✅ 零宿主依赖；❌ 每条消息重复携带；❌ system 语义塞进 user 消息，与人设系统提示割裂 |

### 分叉③ 发布时机

| 选项 | 内容 | 取舍 |
| --- | --- | --- |
| **α 启动全量 + 热更 + 新绑定（推荐）** | channel 启动扫 router 绑定表全量发布；config/称呼热更时重发；`session-created` 时发新会话 | ✅ 覆盖 dsh-im 三个时机且更简（我们绑定表持久化，启动即知全集）；✅ 热更链路 M4 已验证 |
| β 每 ask 前刷新 | pipeline 每次 ask 前查表发布 | ❌ 无状态但每轮做重复工作；时机耦合 pipeline，回放/测试面变脏 |

### 分叉④ 贴纸集上下文（PLAN.md 评估项，c90abcda）

| 选项 | 内容 | 取舍 |
| --- | --- | --- |
| α M7 一起做 | 同管道（order 相邻）发贴纸目录清单 + 使用指引 | 管道落地后是纯内容工作；但需要运营素材（准备哪些贴纸） |
| **β 不做，管道预留（推荐）** | M7 只落身份上下文；贴纸等 M9 主动关怀一起评估（贴纸本质是"主动表达"素材，M9 才有主场景） | 专注主线；`systemPrompt.context` 管道是通用的，后续加贴纸零架构成本 |

## 架构落点（终态：分叉① Config 存储 + ②α③α④β）

```
src/
├─ core/
│  ├─ identity/            ← 新增纯内核
│  │  ├─ peer-note.ts        buildPeerNote（handle+称呼 → 文案，纯函数）
│  │  └─ peer-registry.ts    sessionId → note 内存表（LRU 上限，同 dsh-im）
│  ├─ types/config.ts       PluginConfig.contacts（键 = 归一化号码）
│  └─ router/session-router onSessionCreated 回调（发布挂点）
└─ host/
   ├─ dsh-api.ts            HostSystemPromptService 最小面（context() 签名）
   ├─ dsh-port.ts           可选服务同款：ctx.get?.('systemPrompt') 探测
   ├─ peer-context.ts       context 注册（name 'dsh-imessage:peer'，order 124）
   ├─ channel.ts            live.contacts 数据源 + applyHotConfig 比较热更 +
   │                        三时机发布（启动全量/热更/新绑定）
   └─ index.ts              Config.contacts: z.dict(z.string()).volatile +
                            volatile-update 监听透传
```

- 文案 zh 硬编码（prompt 是 AI 输入，i18n 层只覆盖出站用户文本——
  M6.3 引用块同款边界）；措辞与 dafeiyu 人设口吻对齐
- 降级矩阵：无 systemPrompt 服务（老宿主）→ 不注入，聊天不受影响；
  contacts 未填 → 裸 handle（"还不知道叫什么，可以问"）；
  键非法（归一化失败）→ 写入侧静默丢弃（allowlist 同惯例）
- 最小面纪律：`HostSystemPromptService` 照官方 `PromptContext` 形状造
  fake（坐标 `system-prompt/src/index.ts:52-90`），不照我们声明造——
  防再犯第④条

## 分步交付

- **Step A（core）**：peer-note 纯函数 + registry + 镜像测试
  （文案矩阵 / LRU；原 contacts store 随分叉①回退删除）
- **Step B（host 注入）**：服务最小面 + 可选探测 + context 注册 +
  fake 契约测试（照官方形状，标坐标）；真机验证：设置称呼 → 新消息 →
  会话日志 system prompt 段出现 `[对话来源]`
- **Step C（UI + 文档）**：设置页称呼编辑（卡片内白名单号码行内编辑，
  保存 = config contacts 字段全量覆盖写，热更与 allowlist 同链路）
  + 真机 e2e（settings-ui 三步 nickname）+ 验收记录

## 验收标准（真机）

1. 白名单号码 A 填称呼"小陈" → 手机发消息 → 她自然使用称呼（不问"你是谁"）
2. 未填称呼的号码 B → 她询问或用中性说法，不瞎编名字
3. 同一 DSH 宿主的**非 iMessage 会话**（桌面 UI 直接对话）看不到身份段
4. 改称呼保存 → 下一条消息即用新称呼（热更闭环）
5. 老宿主模拟（无 systemPrompt 服务）→ 通道照常，仅无身份段

### 验收记录（2026-11-26 真机，macOS 15.7.3）

| # | 标准 | 结果 |
| --- | --- | --- |
| 1 | 称呼生效 | ✅ 会话 `imessage-7d1c3f95`：DSH 会话日志 system-reminder 段实证出现注入行（见下），且 AI 推理自证消费——"对话来源说对方是主人……之前我一开始说不知道是谁，现在系统提示说明了"，回复策略随之改变 |
| 2 | 未填不瞎编 | 单测覆盖（`named:false` → "还不知道叫什么，可以问" + "认不出是谁就直说，别瞎猜"）；真机仅单号码未触发 |
| 3 | 非 iMessage 会话不可见 | text 回调空串机制 + 单测覆盖；真机未专门构造桌面会话 |
| 4 | 热更闭环 | ✅ 设置保存 → `peer.published` 二次打点（volatile-update → applyHotConfig 比较变化 → 重发）→ 下一条消息即带新称呼 |
| 5 | 老宿主降级 | `ctx.get?.('systemPrompt')` 探测 no-op 单测覆盖；当前宿主有服务，未走降级路径 |

注入段实证（system prompt 内原文，称呼 = 用户在设置页所填）：

```
[对话来源] 你正在通过 iMessage 私聊跟一个人说话，对方是主人（+8619829734218）。
认不出是谁就直说，别瞎猜。
```

配套链路日志（`imessage-20261126.jsonl`）：`peer.published`（`named:true`，启动全量 + 热更各打）→
`message-claimed` → `ask-done`（totalMs 1682）→ `reply-sent`（3 parts）→ `message-done`，无断点。
