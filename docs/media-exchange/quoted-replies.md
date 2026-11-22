# M6.3 · 引用回复接收（quoted replies）

> 状态：✅ 完成（2026-11-22 代码落地 + 真机验收，四分叉全按推荐拍板）。
> 范围 = **纯接收侧**：对方用 iMessage「回复特定消息」发来的引用消息，
> 归一化进 prompt；引用块携带的图片一并给 AI。发送侧（我方以引用格式
> 回复）不在本期。

## 场景

对方长按我方（或自己）的某条历史消息选「回复」，引用 + 新文字发来：

- 引用**文字**：AI 必须看到被引用的原话才能答对——dsh-im 91501597
  的事故就是 quote 存在 `thread_originator_guid` 而查询从不读它，
  「答了一个她看不见的问题」
- 引用**图片**：原消息是图（如对方引用自己发过的截图问「这个怎么弄」），
  只给文字占位不够，图要进 ask
- 原消息**已被剪除**（保留期外/原机没有）：引用块如实降级，不误导

## 源码事实

### dsh-im 三次演进（本地仓提交，照抄级参考）

| 提交 | 内容 | 关键教训 |
| --- | --- | --- |
| 91501597 | 接收引用文本 | JOIN `message q ON q.guid = m.thread_originator_guid`；text 列空时用 `hex(q.attributedBody)` 兜底解码；`q.is_from_me` 判作者（自己早期消息 → 中性称呼，不让 AI 假设有名字）；原消息被剪 → `unavailableReason: 'not-found'`；纯图引用 content =「（图片或贴纸消息）」；tapback 在 `associated_message_*` 列，设计上就排除 |
| 33466aac | 引用图进 AI（第一版） | JOIN 原消息附件（is_sticker=0 / transfer_state=5 / filename 非空，同款 ON 准入）；**扇出警告：引用附件 JOIN 与本消息附件 JOIN 相乘，必须按 path 去重，不能信一行一文件** |
| 95a571f0 | 终态重构：引用图**不进图片块** | Messages 对聊天**双方**都在 `~/Library/Messages/Attachments` 永久存副本；AI 有全盘读权限 → content 里给绝对路径 hint（HEIC 附 sips 转码提示），AI 用工具按需自读；attachments 只留 name-only 展示条目，不再有 lazy file source |

### 本仓现状（2026-11-22 核对）

| 层 | 现状 | 缺口 |
| --- | --- | --- |
| chatdb 读侧 | M2 起 JOIN `q.text AS quotedText` + `quotedDateNs` | ① 无 attributedBody hex 兜底（原消息纯图/富文本时 quotedText=null）；② 无 `q.is_from_me` / 原 sender（分不清引用了谁）；③ 无原消息附件 JOIN（引用图）；④ 无 quotedRowId（判不出原消息被剪） |
| 准入 SQL | text 非空 OR attributedBody 非空 OR 图片附件 | 纯引用（无新文字）消息靠 attributedBody 非空进来，但剥 U+FFFC 后 text 空 + 本消息无图 → `resolveText` 落 `ATTACHMENT_PLACEHOLDER`（"[attachment: image, not yet supported]"）——**误导性占位**，把引用消息标成附件 |
| normalize | `quotedText` 透传进 `NormalizedMessage` | 无 author / 附件 / 不可用原因；quotedDateNs 读了没用 |
| pipeline | buildPrompt 只组装正文 + 图片块 | **quotedText 被丢弃，AI 实际看不到引用** |

### iMessage 数据面（M2/M6.0 探针已证）

- 引用回复：`m.thread_originator_guid` 非空（本机 4 条）；新文字在 m.text
- tapback（点赞等）：`associated_message_*` 列，与引用不同源，准入天然不进
- 纯图消息 text 内嵌 U+FFFC 占位（真机实测，M6.1 处理过）——纯引用同理

## 数据流

```
chatdb FETCH_SQL（扩 JOIN：q.attributedBody hex / q.ROWID / q.is_from_me /
  qh.id / 原消息附件 qmaj·qa——ON 准入同款，扇出按 path 去重）
  → normalize：replyTo 结构化 { author: 'them'|'us', text, unavailable?, image? }
    （quotedText ?? attributedBody 解码 ?? 占位；纯图引用降 ''
     同 M6.1 规；ATTACHMENT_PLACEHOLDER 不再命中引用消息）
  → media：引用图走 M6.1 同链路（Messages 副本 → HEIC→JPEG → bytes）
  → pipeline buildPrompt：正文前拼引用块 + 引用图作图片块（标注来源）
  → dsh-port：saveImages 进 ask（现有块序：引用图 → 正文图 → 文本）
```

## 设计要点

1. **引用块渲染格式**（buildPrompt，单聊语境）：

   ```
   > 引用了你发过的消息：帮我看看这个报错
   （新文字）
   ```

   - `author` 二值：`us`（我方 AI 早期回复——"你发过的"）/ `them`（对方
     自己的话——"对方之前发的"）。引用了谁语义差别大（追问自己 vs 追问
     AI），必须区分；但不用 handle id（单聊无意义）
   - 原消息被剪：`> 引用了一条已不可用的消息`，正文照常
   - 纯图引用（无字）：`> 引用了一张图片`（图走图片块，见分叉 2）
   - 引用块永不吞正文：正文空时引用块就是全部内容（对应 M6.1 纯图消息
     正文降 '' 的同款规则）

2. **扇出防御**（dsh-im 33466aac 教训，硬约束）：本消息附件 JOIN 与引用
   附件 JOIN 相乘——normalize 按 guid 聚合时，两组附件各按 path 去重，
   互不混入（本消息附件 ≠ 引用附件，字段前缀区分）

3. **quoted 附件 ON 准入**与本消息同款：is_sticker=0、transfer_state=5、
   filename 非全空——原消息附件未完成/贴纸时引用块降文字占位，不吞消息

4. **cursor/幂等不受影响**：引用信息随消息行一次 JOIN 取出，无二次查询、
   无异步 fetch（dsh-im 深链 walk 那套是群聊多级 reply 链的复杂度，
   iMessage 单级引用用不上）

## 待拍板分叉

| # | 分叉 | 推荐 | 理由 |
| --- | --- | --- | --- |
| 1 | 引用图给 AI 的方式：α 进图片块（M6.1 media 全链路）/ β 路径 hint 自读（dsh-im 终态）/ γ 只给「（一张图片）」占位 | **α** | 我们 M6.1 已有现成链路（HEIC 自动转码、DSH 配额、文本模型自动降级为占位文本+只读路径——β 的自读兜底 DSH 已内置）；dsh-im 弃 α 的痛点（lazy source 管线）我们不存在；α 零额外工具轮次，追问图的场景（「这个怎么弄」）开箱即答。β 的真实优势只剩省 token，交给 DSH 降级机制即可 |
| 2 | 引用块格式：α 上述 Markdown 引用行 / β 结构化标签（`<quoted from="us">…</quoted>`） | α | 单行引用 Markdown 语义模型零成本理解；β 是为群聊多引用设计的复杂度，单聊一条引用用不上 |
| 3 | 纯引用消息（无新文字）：α 照常投递（引用块为全部内容）/ β skip 等对方补字 | α | 用户发出去的消息就是意图；β 会静默丢消息违反本仓「不吞消息」基调 |
| 4 | 引用图与本消息图并存时的块序：α 引用图在前 / β 正文图在前 | α（引用先于正文，因果序） | 引用是上下文、正文是问题，先因后果；与 dsh-im "oldest-first so the prompt reads cause before effect" 同向 |

## 变更清单

| 文件 | 变更 |
| --- | --- |
| `chatdb.ts` | FETCH_SQL 扩 JOIN：`q.ROWID`、`hex(q.attributedBody)`、`q.is_from_me`、原消息附件（qmaj/qa，ON 准入同款）+ ChatDbRow 增列 |
| `normalize.ts` | replyTo 归一（text ?? body 解码 ?? 占位；author 二值；unavailable；引用图附件单独数组，path 去重）；纯引用消息不再落 ATTACHMENT_PLACEHOLDER |
| `types/messages.ts` | `NormalizedMessage.replyTo?: { author: 'us'\|'them'; text: string; unavailable?: boolean }`；`quotedImage?: MessageAttachment` |
| `pipeline.ts` | buildPrompt：引用块拼装 + 引用图进图片块（块序按分叉 4）；日志 media-loaded/ask 不变（引用图并入现有 loaded/skipped 计数） |
| `media.ts` | 无改动（按 MessageAttachment 复用）；dsh-port 无改动（AskPart 序已由 buildPrompt 决定） |
| 测试镜像 | chatdb JOIN 扇出/去重、normalize replyTo 各降级、pipeline 引用块与块序；fixture 沿用 chatdb-rows 合成数据 |
| `AGENTS.md` | 排查表增「引用消息答非所问 → 看 prompt 里有没有引用块」一行（事件面无新增，链路不变） |

## 分步交付

- **Step A（✅ ba81d1c）**：chatdb 扩 JOIN + normalize replyTo 归一
  （含扇出去重、纯引用占位修正）+ 镜像测试——纯 core，无 host 依赖。
  实现中发现并修正：SQLite `hex(NULL)` 返回 `''`，SQL 层包 `NULLIF`
  归一为 NULL
- **Step B（✅ 866a79e）**：pipeline 引用块渲染 + 引用图进块
  （分叉 1α/2α/4α）+ 镜像测试（三文案、纯引用、块序、降级矩阵）

## 真机验收记录（2026-11-22，→ +8619829734218，会话 imessage-7d1c3f95）

四条引用消息全部走完 `message-claimed → ask-start → reply-sent →
message-done`（其中两条 `media-loaded {loaded:1}` = 引用图进块）：

| # | 场景 | prompt 引用块（会话日志实录） | AI 回复验证点 |
| --- | --- | --- | --- |
| 1 | 引 AI 文字消息（us） | `> 引用了你之前发的消息：《大肥鱼的摸鱼报告》，纯属凑数` | 答对所指内容 |
| 2 | 引用户自己的话（them） | `> 引用了对方之前发的消息：不是图片，发文件，比如发个ppt` | 「这次引的是你自己的话」——**author 区分生效** |
| 3 | 引 AI 的图（us 纯图） | `> 引用了你之前发的消息：（一张图片）` + 图片块 | 「还把我在吃东西的样子挂出来」——**图真被看到** |
| 4 | 引用户图文消息（them） | `> 引用了对方之前发的消息：为什么跑到后面…全程有氧的` + 图片块 | 「你自己那张心率图」——caption 与图兼得 |

未覆盖低频边界（被剪消息降级文案、纯引用无文字），不影响主链路，
留日常观察。
