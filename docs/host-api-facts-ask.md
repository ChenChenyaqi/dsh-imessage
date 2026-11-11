# DSH 流式问答（ask/prompt）事件流事实清单

事实来源：deepseek-harness 仓库（`packages/*/*`）源码只读探索。路径均相对仓库根
`/Users/chenyaqi/Documents/github-projects/deepseek-harness`，行号以当前工作树为准。
配套文档：`host-api-facts-rpc.md`（会话/workspace RPC 事实）。本清单只覆盖"发 prompt → 收流式回复"链路。

---

## 0. 四条接入面（先读：dsh-imessage 的 DshPort.ask 落在哪条面）

| 面 | 入口 | 流式文本粒度 | 中止手段 |
| --- | --- | --- | --- |
| A. 进程内 Cordis 插件（webhook 插件即此形态） | `ctx.agents.create/get` + `agent.followup()` | **token 级**（`agent/assistant-stream` 事件） | `agent.cancel(cause, {keepInbox})` |
| B. API gateway Remote（HTTP/WS，namespace `session`） | `session/prompt` + `session/follow` 流 | **token 级**（follow 的 `assistant-stream` 帧，需 `assistantStream: true`） | `session/cancel` |
| C. SDK JSON-RPC（spawn 子进程 stdio） | `session/prompt` + `session.event` 通知 | **step 级**（每个 `assistant/message` 持久事件一条通知；无 token 流） | **无 wire cancel**，只能关掉子进程 |
| D. ACP（标准 Agent Client Protocol） | `session/prompt`（请求挂到静默）+ `session/update` 通知 | 更新粒度（assistant 内容经 ACP update 投影） | `session/cancel` 通知 / JSON-RPC 请求取消 |

- A 面事实：`packages/experimental/webhook/src/session.ts:93-136`（创建会话后 `handle.agent.followup(...)`，`:128`）。
- B 面事实：`packages/api/session-controller/src/index.ts:148-150`（`namespace: 'session'`）；prompt `:467-489`、cancel `:519-524`、follow 流 `:609-611`。
- C 面事实：`packages/sdk/protocol/src/types.ts:208-219`（请求面全集：`initialize` / `session/prompt` / `session/query` / `session/resume` / `session/wait` / `session/working-directory/*` / `shutdown`——**无 cancel**）。
- D 面事实：`packages/acp/acp/src/index.ts:389-390`（`methods.agent.session.prompt` 请求、`...cancel` 通知）。

---

## 1. 向会话发 prompt 的 API

### 1a. A 面（进程内）：`Agent.followup(message)`

**源码位置**
- 声明：`packages/core/agent/src/runtime-types.ts:246-252`
- 实现：`packages/core/agent-loop/src/agent.ts:180-182`（`followup(input) = send(input, 'next-turn', true)`）
- 消息构造：`packages/llm/llm/src/message.ts:246-257`（`createUserMessage`）
- 参照实现：webhook `packages/experimental/webhook/src/session.ts:117-136`；headless `packages/bundle/headless/src/index.ts:420-431`

| 事实 | 说明 | 源码位置 |
| --- | --- | --- |
| 方法名 | `followup(message: UserMessage): void`，同步、无返回值（fire-and-forget） | runtime-types.ts:252 |
| 入参 | `UserMessage = { id, content: ContentBlock[], source: MessageSource }`；`id` 由 `createUserMessage` 自铸 UUID | message.ts:130-166、246-257 |
| prompt 文本格式 | `content: [{ type: 'text', text }]`；可混排 `{type:'image', attachment}` / `{type:'file', attachment}` 块 | llm/src/types.ts:70-104；webhook session.ts:128-137 |
| source | 自报来源 kind（webhook 用 `{kind:'webhook', ...}`，普通用户输入 `{kind:'user'}`）；merge-extensible 联合 | message.ts:110-136 |
| 变体方法 | `steer(message)`（插入当前 turn 的下一个 step 边界）、`inject(message)`（不唤醒）、`send(message, target, wakeup)`（底层） | runtime-types.ts:253-270、235-245 |
| 与 session 生命周期 | 需要活的 Agent：`ctx.agents.create({sessionId, meta:{cwd,...}, agentOptions, setup})` 建，`ctx.agents.get(id)` 取，`ctx.agents.resume({resumeSessionId})` 恢复持久会话 | core/agent/src/index.ts:66-124、127-158、410、429、580 |
| 会话状态要求 | **无状态要求**：idle 时 followup 立即开新 turn；running 时排入 `next-turn` 收件箱等待自己的 turn；活动刚被取消时"waking input 排队，待取消的活动收敛后运行" | runtime-types.ts:235-241（`send` JSDoc）；agent.ts:171-179 |
| 语义保证 | "The item becomes the sole ordinary message of its own turn"（followup 消息独占一个 turn） | runtime-types.ts:247-251 |
| 完成/失败感知 | followup 本身不回执；用 `agent.whenIdle()`（静默等待）+ 监听 `agent/error` / `turn/end` | runtime-types.ts:215-225；headless index.ts:407-431 |

### 1b. B 面（API Remote）：`session/prompt`

**源码位置**
- Host 方法：`packages/api/session-controller/src/index.ts:467-489`（`@Remote('prompt')`）
- 业务实现：`packages/api/session-controller/src/commands.ts:321-386`
- 请求类型：`packages/api/session-controller/src/types.ts:324-332`

| 字段 | 类型/值 | 语义 |
| --- | --- | --- |
| `requestId` | `SessionRequestId`（branded string，调用方铸） | 幂等键：已受理的 id 重复提交直接 `{accepted:true}`，不重发消息 | commands.ts:323-324、390-422 |
| `sessionId` | `SessionId` | 目标会话；持久层存在则自动 resume 挂活（agent.ts:151-207） |
| `mode` | `'queue' \| 'steer'` | queue → `agent.followup`；steer → `agent.steer` | commands.ts:374-375 |
| `content` | `readonly PromptContentPart[]` | `{type:'text',text}` \| `{type:'image',mediaType,data(base64),name?}` \| `{type:'file',receiptId}` | types.ts:80-88 |
| `clientTimeZone` | string，可选 | 记录进消息 source，需 UTC/IANA 名否则 `session/invalid-time-zone` | index.ts:478-485 |

- 返回 `{ accepted: true }`：只表示"消息进了 Agent 收件箱"，**不等待模型回复**（types.ts:334-337）。
- 校验：非空 content 全是空白 → `gateway/bad-request`（index.ts:472-474）；空数组 content 语义是"继续上次失败/等待输入的会话"，不满足条件 → `session/agent-busy {reason:'NO_CONTINUABLE_FAILURE_OR_PENDING_INPUT'}`（commands.ts:324-338）。
- 收件箱回执事件：`agent/inbox/spliced`（durable，`inserted` 携带消息）——SDK 客户端即以此对账 prompt 受理（core/agent/src/types.ts:107-117；sdk/client/src/api.ts:361-369）。

### 1c. C 面（SDK JSON-RPC）：`session/prompt`

**源码位置**
- 类型：`packages/sdk/protocol/src/types.ts:71-96`；服务端实现 `packages/sdk/server/src/server.ts:262-282`

| 事实 | 源码位置 |
| --- | --- |
| 参数 `{sessionId, contentBlocks: (ContentBlock \| {type:'image', data, mimeType, name?})[]}`，内联 base64 图像会被送入附件存储 | types.ts:71-91；server.ts:42-58 |
| 返回 `{messageId}`（入队回执）；**不等待回复**——完成靠 `session/wait` 或监听 `session.status` idle | types.ts:93-96；server.ts:279-281 |
| 未知 sessionId **懒创建** agent+session 对 | types.ts:73；server.ts `getOrCreateSession` |
| 必须先 `initialize`（cwd/provider/model），否则抛 'SDK server is not initialized' | server.ts:212-253、263 |
| `session/query` 变体：`/` 开头文本路由到原生命令，否则当 prompt | server.ts:292-331 |

### 1d. D 面（ACP）

- `session/prompt` 请求挂起直到根 Agent、子树与更新全部完成，返回 `stopReason`（`end_turn`/`max_tokens`/`cancelled`）：`packages/acp/acp/src/session.ts:219-225、306-307`；`turnEndToStopReason` 映射 `packages/acp/acp/src/codec.ts:14-34`（hook/他人 abort → 仍 `end_turn`）。
- 每会话同时只允许一个在途 prompt：违反 → JSON-RPC invalidParams `'a prompt is already in flight for this session'`（session.ts:225）。

---

## 2. 流式回复的事件协议

### 2a. 事件名全集（按层）

**进程内 Cordis 事件**（`packages/core/agent/src/runtime-types.ts`，agent-scoped，`@mode` 标注）：

| 事件 | payload | 说明 | 行号 |
| --- | --- | --- | --- |
| `agent/status` | `{agent, status: 'idle'\|'running'}` | 整 Agent 生命周期翻转（不是 per-turn） | :294-312 |
| `agent/assistant-stream` | `{agent, frame: AssistantStreamFrame}` | **token 级流**（进程内瞬时，不持久） | :393-401 |
| `agent/inbox/inserted` / `claimed` / `discarded` | `{agent, message, ...}` | 收件箱变化 | :344-373 |
| `agent/error` | `{agent, turn, step, error}` | step/turn 失败的实时通知（error 原样对象） | :412-430 |
| `session/event` | `(session, event: SessionEvent)` | 每条持久事件提交后即发（fire-and-forget） | core/session/src/index.ts:73-85 |

**`AssistantStreamFrame` 三帧**（runtime-types.ts:155-168；生产者 `packages/core/agent-loop/src/assistant-stream.ts:53-111`）：

| 帧 | 字段 | 语义 |
| --- | --- | --- |
| `start` | `{type, attemptId, revision, turn, step}` | 尝试开始；`revision` 单调，attach 生命周期内从 1 起 |
| `chunk` | `{type, attemptId, revision, index, time, chunk: StreamChunk}` | `index` 为尝试内从 0 的稠密序号；丢一帧即失序 |
| `end` | `{type, attemptId, revision, index, outcome}` | `outcome: {kind:'committed', eventType:'assistant/message'\|'assistant/attempt', seq} \| {kind:'abandoned'}` |

**`StreamChunk` 全集**（`packages/llm/llm/src/types.ts:496-508`）：
`block-start {index, blockType}` / `text-delta {index, text}` / `reasoning-delta {index, text}` /
`tool-call-delta {index, id, name?, argumentsDelta}` / `block-end {index, block}` /
`usage {usage}` / `finish {reason, replayState?}`。

**持久会话日志事件**（`packages/core/session/src/types.ts:288-383`，信封 `{type, seq, time, data, ignorable?}` :506-528）：
`turn/start {turn}` :294、`turn/end {turn, reason: TurnEndReason}` :303、`step/start`/`step/end` :305-307、
`user/message` :315、`assistant/message {turn, step, message, stream, usage?, interrupted?}` :349-362、
`assistant/attempt {turn, step, stream}` :363、`tool/call` :369、`tool/result` :383-399、
`request/header` / `request/context` / `system/message` / `developer/message`、`agent/inbox/spliced`（core/agent/src/types.ts:107-117）。

**wire 通知（各面）**：

| 面 | 通知/帧 | 源码位置 |
| --- | --- | --- |
| C 面 | `session.event {sessionId, event}`（全量持久事件逐条转发）；`session.status {sessionId, status}` | protocol/types.ts:152-165、196-197；server.ts:166-180 |
| B 面 follow 流 | `{type:'snapshot', header, cursor, records, hasMore, projections, assistantStream?}` 开场，随后 `{type:'event', event}` 持久帧 + `{type:'assistant-stream', frame}` 流帧 | api/types.ts:567-577；web/controller.ts:37-75 |
| B 面 follow 的 `SessionAssistantStreamFrame` | start/chunk/end；start 比 A 面多 `startedAfterSeq`，chunk 的 `chunk` 为 JsonValue，end 带 `outcome` | api/types.ts:510-540 |
| B 面 observeEvent/observeState/wait | `{type:'ready'}` + 事件帧 / 状态替换 / `{reason:'idle'\|'input-required'\|'timeout', state, output}` | api/types.ts:660-672、629-653；index.ts:553-562、597-600 |
| D 面 | 标准 ACP `session/update`（assistant 内容、tool_call、tool_result、config 投影） | acp/src/session.ts:317-354 |

### 2b. 文本片段在哪个字段

| 场景 | 字段 | 源码位置 |
| --- | --- | --- |
| A 面可见文本（token 流） | `frame.chunk.type === 'text-delta'` → `frame.chunk.text`；思考文本在 `reasoning-delta`（同名字段） | llm/types.ts:499-500 |
| B 面 follow | `frame.frame.chunk`（同 StreamChunk JSON） | api/types.ts:524-530 |
| 持久事件（每 step 完整块） | `assistant/message` 的 `data.message.content[]`，取 `{type:'text', text}` | session/types.ts:349-362 |
| 持久事件（原始增量） | `data.stream[]` 压缩记录 `text-chunks {time0, index, dt[], texts[]}`，`texts` 仍是增量 | llm/assistant-stream.ts:20-29 |

### 2c. 结束与错误判别

| 判别 | 方式 | 源码位置 |
| --- | --- | --- |
| 单次模型尝试结束 | A/B 面：`end` 帧 `outcome.kind`（`committed` 带 seq / `abandoned`） | runtime-types.ts:166-168；agent-loop/assistant-stream.ts:78-111 |
| 整个 turn 结束 | 持久 `turn/end`（`reason.kind`）；C 面 `session.status` = idle；B 面 `wait` reason `'idle'` | session/types.ts:303；sdk/client/api.ts:293-296；api/types.ts:645-648 |
| 失败 | 持久 `turn/end` `reason: {kind:'error', error: LlmFailure}`；A 面 `agent/error` 事件；C 面 `session/wait` 直接 reject 该错误 | session/types.ts:222-230；runtime-types.ts:412-430；sdk/server.ts:375-385 |
| 失败但未提交消息的尝试 | `assistant/attempt` 事件（保留原始流，不进模型可见历史） | session/types.ts:363-366 |
| 未知事件类型 | 无 `ignorable: true` 的未知 type **必须拒读**（不能静默丢弃） | session/types.ts:513-522 |

---

## 3. 文本片段语义（增量 vs 快照、编码）

| 事实 | 源码位置 |
| --- | --- |
| `text-delta`/`reasoning-delta` 是**增量 delta，需拼接**：assembler 执行 `partial.text += chunk.text` | llm/src/assembler.ts:61-68 |
| `index` 关联交错的多个块；`block-end` 携带权威的完整块，`block-end` 之后再来的同 index delta 被忽略 | llm/types.ts:498-502；assembler.ts:32-36、64-65、75-80 |
| 协议容忍"只有 delta、无 block-start/end"的适配器（head 注释"Tolerant of delta-only protocols"） | assembler.ts:29-32 |
| 快照语义只存在于**step 结束后的成品**：`assistant/message.message.content` 是本 step 组装完成的完整块（非全量替换流；跨 step 不重复推送旧文本） | agent-loop/agent.ts:570-588 |
| "最终回答"约定：取 turn 内**最后一个** `assistant/message`，拼接其全部 text 块 | sdk/client/src/api.ts:386-396（`finalResponse`） |
| chunk 顺序契约：适配器在终态 `finish` 前发 `usage`，之后不再有任何 chunk | llm/types.ts:487-495 |
| 编码/转义：无自定义转义；chunk 必须可无损 JSON 序列化（`snapshotJsonValue` 校验），文本为普通 JSON string | llm/assistant-stream.ts:84-88 |
| 持久压缩记录把连续同类 delta 打包成 `text-chunks {time0, index, dt[], texts[]}`（dt 为相对毫秒），`texts` 仍是待拼接增量；`expandAssistantStream` 是读取端校验展开路径 | llm/assistant-stream.ts:20-36、202 |

---

## 4. abort 机制

| 事实 | 源码位置 |
| --- | --- |
| A 面 API：`agent.cancel(cause, options?)`；`AgentCancelCause = {kind:'user'} \| {kind:'parent'} \| {kind:'hook', reason} \| {kind:'disposed'}` | runtime-types.ts:196-213；session/src/types.ts:194-199 |
| `CancelOptions.keepInbox`：true 保留排队/steering 输入（仍中止活动 turn，不记 canceled splice）；false（默认）先 `inbox.clear()` 清空（持久记录 `outcome:'canceled'` 的 splice）再中止 | runtime-types.ts:39-46；agent-loop/agent.ts:192-203；inbox.ts:97-101、214 |
| B 面：`session/cancel` → `agent.cancel({kind:'user'}, {keepInbox: true})`（保留队列）；未 attach 的会话 → `session/not-found` | api/commands.ts:526-541；api/index.ts:519-524 |
| C 面：**无 wire 级 cancel**——超时的请求在服务端继续跑，只能 `close()` 整个 runtime；`session/wait` 自身的 signal 只停止等待 | sdk/client/client.ts:186-188（类注释明说）；server.ts `wait` |
| D 面：`session/cancel` 通知或 JSON-RPC 请求取消（requestSignal abort → `cancelPrompt`）；无在途 prompt 时取消自治工作 | acp/src/index.ts:367-368、389-390；acp/src/session.ts:246-252、308-313 |
| 无活动时 cancel 是 no-op（不武装后续工作）；队列写失败仍会中止活动并把异常抛给调用方 | runtime-types.ts:207-212 |
| 中止后流的行为：中断发生在流中且已有可见前缀 → 该前缀固化为 `assistant/message` 且 `interrupted: true`（未派发的 tool-call 缺席）；无可见内容 → 固化为 `assistant/attempt` | session/types.ts:352-361；agent-loop/agent.ts:508-537 |
| 活动流帧以 `end` 帧收口：持久 settlement 成功 → `outcome:{kind:'committed',...}`；settlement 追加失败 → `abandon()` → `outcome:{kind:'abandoned'}` | agent-loop/assistant-stream.ts:78-111 |
| 适配器层 `finish` 为 `error`/`aborted` → `assistant/attempt` + `agent/request-error` waterfall（监听者可 `{kind:'retry'}` 接管重试），否则抛 `LlmError` 结束 step | agent-loop/agent.ts:547-566；runtime-types.ts:347-370 |
| turn 层：取消 → `turn/end` `reason:{kind:'aborted', reason: cause}`；`turn/end` 永远会追加（含 finally 兜底） | agent-loop/agent.ts:408-434 |
| 不会污染后续消息：活动被取消后提交的 waking 输入被重分类到 `next-turn`，等取消的活动收敛到 idle 后正常开新 turn；`whenIdle()` 在取消后正常 resolve | runtime-types.ts:235-241；agent-loop/agent.ts:171-179、228-256 |
| SDK `wait` 的失败判定：`agent/error` 记录"未被后续持久终态覆盖的活动失败"，之后有 `turn/end`（seq ≥ 失败点）即清零——即"一次失败不永久毒化会话" | sdk/server/src/server.ts:166-172、375-385；headless 同款 index.ts:412-417 |

---

## 5. 错误形态

### 5a. B 面（API Remote）：`RemoteError {code, message, details}`

- 类定义：`packages/typert/protocol/src/remote-error.ts:12-34`——`code` 稳定字符串、`message` 人类可读、`details` 按 code 定型；判别永远按 `code` 不按 instanceof；wire 侧 `RemoteResult = {ok:true,value} | {ok:false,error}`（`packages/typert/protocol/src/types.ts:130-139`）。
- prompt 相关错误码（声明 `packages/api/session-controller/src/types.ts:182-226`；`session/not-found` 在 `packages/core/session/src/types.ts:566-573`）：

| code | details | 触发 |
| --- | --- | --- |
| `gateway/bad-request` | `{issues?}` | 非空 content 无非空白文本/附件（index.ts:472-474） |
| `session/not-found` | `{sessionId}` | 会话不存在/未 attach；admission 期间 Agent 被外部 dispose（commands.ts:528-535、363-370） |
| `session/agent-busy` | `{reason}` | admission 失败兜底（`reason:String(error)`）、不可继续的空 prompt | commands.ts:324-338、376-382 |
| `session/attachment-invalid` | `{reason}` | 附件/图像无效；当前模型不支持图像输入 | commands.ts:346-360、379-381 |
| `session/model-unavailable` | `{provider, model}` | 选模型时（含 `requireModel`） | commands.ts:424-428 |
| `session/invalid-time-zone` | `{value}` | clientTimeZone 非法 | index.ts:478-485 |
| `session/wait-timeout` | `{}` | wait 截止前无任何状态 | state/controller.ts:117 |
| `gateway/cancelled` / `gateway/internal` | `{}` | 载体取消 / 未分类宿主失败 | typert/protocol/types.ts:105-110 |

- 注意：**"宿主忙"不报错**——`followup` 永远排队（running 时排 `next-turn`）；`session/agent-busy` 只出现在 admission 层失败。

### 5b. 模型/流错误：`LlmFailure`

- 结构：`{message, code, status?, providerRetryAfterMs?, requestId?, offloadImages?}`——`packages/llm/llm/src/types.ts:48-68`。
- `code` 为 provider 中性稳定码：`AUTH`/`RATE_LIMIT`/`QUOTA`/`TIMEOUT`/`TRANSPORT`/`SERVER`/`STREAM_CLOSED`/`EMPTY_RESPONSE`/`CONTEXT_WINDOW_EXCEEDED`/`NO_ADAPTER`/`INVALID_CREDENTIAL`/… 或 `HTTP_<status>`——`packages/llm/llm/src/error.ts:21-72`。
- 持久化位置：`turn/end.reason.error`（LlmError 保留原 facts；其余错误平铺为 `{message: errorChain(err), code}`，tool 激活失败 code 为 `TOOL_ACTIVATION_FAILED`，否则 `UNKNOWN`）——session/types.ts:222-230；agent-loop/agent.ts:414-423。
- 进程内同时有 `agent/error` 事件（payload `{agent, turn, step, error}`，error 原样对象，非序列化形态）——runtime-types.ts:412-430。

### 5c. C 面（SDK JSON-RPC）错误

| 事实 | 源码位置 |
| --- | --- |
| 方法抛错 → JSON-RPC error `{code:-32603, message: Error.message}`（无结构化 code/data）；未知方法 `-32601` | sdk/protocol/src/transport.ts:229-243 |
| 典型 message：`'SDK server is not initialized'`、`'unknown SDK session: <id>'`、`'session agent was disposed outside the server: <id>'`、`'SDK image prompt requires an attachment store'` | server.ts:263、368、272；server.ts:62 |
| `session/wait` 在"未被后续持久终态覆盖的活动失败"时以该原始错误 reject（LlmError 等活对象直接抛给客户端） | server.ts:173-177、375-385 |
| 客户端侧失败类：`TransportClosedError`（子进程死/stdio 断）、`RequestTimeoutError`、`SdkProtocolError`（协议违约） | sdk/client/client.ts:43-70 |

### 5d. D 面（ACP）错误

- admission 阶段：内容非法 → invalidParams；其他 → internalError（`'prompt was not queued: ...'`）：`packages/acp/acp/src/session.ts:287-304`。
- 运行阶段失败不 reject prompt 请求，而是收口为 `stopReason`（`end_turn`）+ 语义 update 流；关联失败见 `inflight.agentError`（session.ts:376-390）。

---

## 6. 未确认事项

1. **B 面 gateway 的流载体帧格式**：`session/follow` 在 HTTP/WS 上的具体分帧编码（`RemoteStreamHandle`/carrier 帧类型）未逐字段核实；`host-api-facts-rpc.md` 只记录了请求侧 envelope。若 dsh-imessage 走 B 面收 token 流，需补一次 gateway transport 探索。
2. **`session/follow` 的 `activate`/passive observation 语义细节**：确认了入口与"activation 在快照前启动"（web/controller.ts:63-70），但冷会话后台挂活的具体策略（何时会把持久会话 resume 成活 Agent）未展开。
3. **DSH 反向问人的通道**（对 iMessage 双向交互可能相关）：`user-question/ask`、`approval/request` 服务端→客户端请求存在（sdk/protocol/types.ts:60-67、289-296），但其等待、超时与取消行为未在本清单展开。
4. **Python SDK**：确认与 TS SDK 同协议（`python/sdk/src/deepseek_harness/api.py` 同样消费 `session.event`/`session.status`、`turn/end`），未逐行核对差异。
5. **`maxTokensAsSuccess` 部署映射**：确认是 SDK server 选项（server.ts:74-77），哪个实际部署启用它未查。
6. **多 `assistant/message` 事件与 reasoning 块的展示取舍**：事实已给（turn 内每 step 一条、reasoning 在独立块），但 iMessage 端要过滤哪些块（reasoning/tool-call）属适配决策，不在事实清单内。
