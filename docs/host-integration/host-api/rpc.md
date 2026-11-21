# DSH 会话与工作区 RPC 事实清单

事实来源：deepseek-harness 仓库（`packages/*/*`）源码只读探索。路径均相对
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 仓库根，行号以探索时的工作树为准。

## 0. 命名与面归属（先读）

- **wire 方法名是 `<namespace>/<method>`（斜杠），不是 `session.create`（点号）。**
  HTTP 载体为 `POST /api/<endpoint>`；客户端生成面把 endpoint 拼成
  `` `${descriptor.namespace}/${descriptor.method}` ``（`packages/api/gateway/src/client/index.ts:769-771`），
  经 `/api` 通道调用（同文件 `:458`：`connection.rpc.call('/api', endpoint, { args: prepared.args }, prepared.signal)`）。
  测试实证：`packages/api/gateway/tests/operator-connect.host.spec.ts:335`（`POST ${origin}/api/${endpoint}`）。
  TypeScript 客户端侧写作 `remote.session.create(...)`（对象方法访问），对应 endpoint `session/create`。
- `session` 命名空间由 `SessionController`（`TypertRemoteService`，`namespace: 'session'`）拥有：
  `packages/api/session-controller/src/index.ts:148-150`。每个方法用 `@Remote('名')` 装饰器暴露。
- `workspace` 命名空间由 `WorkspaceController`（`namespace: 'workspace'`）拥有：
  `packages/api/workspace-controller/src/index.ts:57`。
- 起点线索中的 webhook 插件（`packages/experimental/webhook/src/session.ts`）**不走 RPC**：它在 Host 进程内直接
  调 `ctx.workspaceRegistry.create`（`:107`）/ `ctx.agents.create`（`:110`）/ `ctx.sessionTitle.rename`（`:127`）。
  它是"外部渠道驱动 DSH 会话"的同构参照，但 RPC 事实以 `packages/api/` 两个 controller 为准。
- `packages/sdk/`（TS/Python SDK）是另一条独立通道：spawn 子进程上的换行分隔 JSON-RPC 2.0
  （`packages/sdk/protocol/src/transport.ts:1-5`），方法面是 `initialize` / `session/prompt` / `session/query`
  等（`packages/sdk/protocol/src/types.ts:209-213`），**不含** `session/create`、列表、workspace 归档 API。

---

## 1. `session/create`

**源码位置**
- Host 方法：`packages/api/session-controller/src/index.ts:306-310`（`@Remote('create')`，委托 commands）
- 业务实现：`packages/api/session-controller/src/commands.ts:120-158`
- Agent 创建/复用：`packages/api/session-controller/src/agent.ts:229-235`（`createSession`）、`:336-373`（`claim`）、`:375-399`（`reuseLive`）
- 请求/返回类型：`packages/api/session-controller/src/types.ts:268-284`
- 错误码声明：`packages/api/session-controller/src/types.ts:181-231`（`RemoteErrorDetailsMap` 合并声明）

**payload**（wire：`payload.args.request`，即 `POST /api/session/create`，body
`{ type:'client-request', rpcId, method:'session/create', payload:{ args:{ request:{...} } } }`；参数名来自 Host
方法形参 `request`，见 liveshare 测试 envelope `packages/experimental/liveshare/tests/viewer-target-admission.spec.ts:36-38`）

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `workspaceId` | `WorkspaceId`（branded string），可选 | Session 要加入的 Workspace；与 `cwd` 互斥（同时给两者 → `gateway/bad-request`，commands.ts:121-122） |
| `cwd` | `string`，可选 | 无 Workspace 时 Session 拥有的目录；会被 `mkdir -p` 递归创建（agent.ts:436-441）。两者都缺省时用 Host 的 `process.cwd()`（index.ts:194 注入 `defaultCwd`） |
| `sessionId` | `SessionId`（branded string），可选 | 见下方复用/唯一性规则 |
| `agentPreset` | `string`，可选 | Session 运行的 preset；复用时会替换其已记录 preset；缺省用部署配置的默认 preset；无 preset roster 的部署复用时点名 preset → `agent-preset/conflict`（agent.ts:410-415） |

就这 4 个字段，`SessionCreateRequest` 无其他成员（types.ts:268-277）。

**`sessionId` 调用方自带的规则（agent.ts `claim`/`createSession`）**
- 完全省略：Host 铸新 id，格式 `session-${randomUUID()}`（agent.ts:426-429）；webhook 插件同理自带
  `webhook-${randomUUID()}`（`packages/experimental/webhook/src/session.ts:109`）。
- 给了 id 且持久层/内存均无此 Session：**以该 id 原样新建**（agent.ts:347-355：捕获
  `SESSION_QUERY_SESSION_NOT_FOUND` 后 `createAgent(sessionId, ...)`）。
- 给了 id 且存在：按"空白 Session 复用"处理，须同时满足全部条件，否则**不报错而是另铸新 id**：
  - 尚无任何 `turn/start`（空白，agent.ts:361；`isBlank` :405-409）；
  - 未被归档且（若带 workspaceId）仍在该 Workspace 成员表中（commands.ts:140-141 的 `reusable` 谓词）；
  - cwd 一致：不一致 → `session/conflict`（ApiSessionCwdConflict，agent.ts:28-40）；
  - 非 subagent 会话（`header.origin === 'subagent'`）→ `session/agent-busy`（agent.ts:20-26、commands.ts:563-565）。
- 同名 id 的并发 create 按**到达顺序串行**（含 preset 解析，agent.ts:320-332 `inOrder`/`claims`）。
- 复用期间会话被他人开始回合（`ApiSessionStartedSinceObserved` / `SessionAlreadyOwnedError`）→ 退化为另铸新
  id，不失败（agent.ts:365-373）。
- **返回的 `sessionId` 可能不同于请求的 `sessionId`**（types.ts:280-284 注释明示 "may differ"）。

**返回** `{ sessionId: SessionId; agentPreset?: string }`；`agentPreset` 仅当部署组合了 preset roster 时出现。

**带 `workspaceId` 时的附加行为**：创建成功后 `workspace.attachSession(sessionId)`；attach 校验 Session 头部
cwd 的 `realpath` 必须等于 Workspace 存储路径且为目录（`packages/workspace/workspace/src/entity.ts:110-148`），
失败 → `session/workspace-attach-failed`，此时 **Session 已发布、Workspace 未挂上**（commands.ts:147-157，
details 里带两个 id；客户端 manager 会把这种"已发布未挂上"的 Session 以错误分支里的 id 立即上列表，
`packages/api/session-controller/src/client/sessions/manager.ts:509-521`）。

**错误码全集**（code → details）

| code | 触发 | details |
| --- | --- | --- |
| `gateway/bad-request` | workspaceId 与 cwd 同给（commands.ts:121-122） | `{ issues? }` |
| `workspace/not-found` | workspaceId 查无此 Workspace（commands.ts:126-131） | `{ workspaceId }` |
| `session/conflict` | 显式 id 的既有 Session 属于另一 cwd（commands.ts:556-562） | `{ sessionId, requestedCwd, existingCwd? }` |
| `session/agent-busy` | 该 id 是 subagent 会话（commands.ts:563-565） | `{ reason }` |
| `agent-preset/conflict` | 无 roster 部署复用时点名 preset（commands.ts:550-555） | `{ sessionId, requestedPreset }` |
| `agent-preset/not-found` / `agent-preset/invalid` | preset 解析失败（`packages/preset/agent-preset-registry/src/index.ts:223,259`，RemoteError 原样上抛，commands.ts:549） | registry 各自定义 |
| `session/workspace-attach-failed` | attach 失败（commands.ts:150-156） | `{ sessionId, workspaceId }` |
| `gateway/internal` | 其余失败兜底，含 mkdir 失败（commands.ts:566） | `{}` |

Host 方法签名 `create(request)` **无 signal 参数** → 该方法不消费 wire 取消信号（对比下文 list/search）。

---

## 2. 会话列表查询

### 2.1 `session/list`

**源码位置**：`packages/api/session-controller/src/index.ts:281-290`；实现
`packages/api/session-controller/src/list.ts:141-176`；类型 `types.ts:247-255`、`:154-170`。

**入参** `{ cursor?: string }` —— **保留字段，当前实现完全忽略**（index.ts:283 形参命名 `_request`，JSDoc
"reserved empty list request"；`listState.list(signal)` 不读 cursor）。当前一次返回全部可见行，无分页。

**返回** `{ items: SessionSummary[] }`，每行字段（types.ts:154-168，list.ts:113-137/170-186）：

| 字段 | 类型/值 | 语义 |
| --- | --- | --- |
| `sessionId` | SessionId | |
| `updatedAt` | number | `max(header.createdAt, lastPromptAt)`（list.ts:368-370）；epoch 毫秒 |
| `agentAvailable` | boolean | 是否有活 Agent |
| `running` | boolean | Agent 是否在跑 turn |
| `blank` | boolean | 折叠前缀中无 `turn/start`（projection `sessionListMetadata`） |
| `formatStatus?` | `'current' \| 'migration-required'` | 持久化格式状态 |
| `parentSessionId?` / `origin?` | SessionId / `'subagent'` | 头部血缘 |
| `cwd?` | string | 头部记录的 cwd |
| `projections?` | `SessionProjectionHints` | 摘要投影提示（`cached`/`sequenced` 两空间，types.ts:60-77） |

排序：`updatedAt` 降序（list.ts:176）。读取为冷安全：活 Session 用内存 summary，冷 Session 用持久化头 +
投影缓存，**不激活任何 Agent**。列表是冷读 + 事件流补充：Host 侧 `api-session/added|removed|status` 事件
（index.ts:224-246）。

**workspace 会话过滤：`session/list` 没有按 workspace 过滤的入参。** Workspace 归属通过 workspace 面获取：
`workspace/follow` 流的 baseline 携带每个 Workspace 的 `sessionIds`（见 §3.3），客户端在本地做交集。

**非 owner Peer 过滤**：list 返回前用 `remoteAccess.allows({ kind:'session', id })` 过滤（index.ts:284）。

支持 AbortSignal（Host 方法第二参数 `signal`，index.ts:282）。

### 2.2 `session/search`（顺带）

`index.ts:295-304`、`list.ts:199-315`。入参 `{ query }`（trim 后非空、≤500 UTF-16 码元、无 NUL，否则
`gateway/bad-request`）；返回 `{ items: [{sessionId, snippet}], hasMore }`，上限 `SESSION_SEARCH_RESULT_LIMIT =
20` 条、snippet ≤240 Unicode 码点（types.ts:176-179）。冷读不激活 Agent。

---

## 3. workspaceRegistry 与归档

### 3.1 `archivedSessionIds` 的来源与语义

- `ctx.workspaceRegistry`（`packages/workspace/workspace/src/index.ts:186`，`WorkspaceRegistry extends Service`）
  拥有持久 domain：`workspace` domain v2 的 **global state** 里存
  `archivedSessionIds: SessionId[]`（`packages/workspace/workspace/src/spec.ts:50-63`，zod schema 即持久形状；
  `pinnedSessionIds` 同级）。
- 语义（index.ts:352-366 getter JSDoc）："registry 全局归档集：从一切分组界面隐藏的 Session。归档不动
  Workspace 记账——被归档 Session 保留其 `sessionIds` 槽位，解除归档即恢复原位置。" 数组顺序为归档顺序。
- **归档不删除任何东西**：Session 日志、cwd、Workspace 记账全保留。

### 3.2 归档/判定 API（RPC）

**`workspace/archiveSession`**（`packages/api/workspace-controller/src/index.ts:159-163`；实现
`commands.ts:162-190`）
- 入参 `{ sessionId: SessionId; stopActivity?: boolean }`（`packages/api/workspace-controller/src/types.ts:115-131`）。
- 前置：Session 必须存在（活或持久化），否则 `session/not-found`；不带 `stopActivity` 时若
  `workspace/session-activity` waterfall 上报任何活动（在跑 turn / subagent / job / schedule）→
  `workspace/session-active`（details 含 `activity` 列表）且**不写任何东西**（registry
  `packages/workspace/workspace/src/index.ts:381-418`）。
- 带 `stopActivity`：先写归档（持久），再发 `workspace/session-stop` 让各 owner 取消运行工作，不等待收敛。
- 归档同一次持久写里**去掉 pin**（pin 与归档互斥，index.ts:389-394）。
- 幂等：已归档 id 直接返回。
- 返回 `{ archivedSessionIds: SessionId[] }`（变更后的完整集合，types.ts:133-135）。

**`workspace/unarchiveSession`**（index.ts:169-173；commands.ts:192-199；registry index.ts:420-439）
- 入参 `{ sessionId }`；从集合移除即恢复原 Workspace 槽位；不做存在性检查；幂等。返回同上。

**归档判定的读路径**
- 无独立 "isArchived" RPC。判定途径：(a) `workspace/follow` baseline / `archived` 增量帧携带完整
  `archivedSessionIds`；(b) `session/create` 的复用谓词内部使用它（commands.ts:140）。
- **归档的运行时效果**：ArchivedSessionGate 在 `agent/pre-step` 上拒绝被归档 Session（及其 subagent 血缘）
  的每一步模型调用（`packages/api/session-controller/src/archived-session-gate.ts:23-28、46-72`）；解除归档对整条
  血缘解锁。

### 3.3 `workspace/follow`（workspace 会话归属 + 归档集的唯一查询面）

`packages/api/workspace-controller/src/index.ts:205-262`（`@Remote({ mode: 'stream' })`）；帧类型
`types.ts:160-176`。每代先发一帧 baseline：
`{ items: WorkspaceView[], archivedSessionIds, pinnedSessionIds }`（feed 组装
`packages/api/workspace-controller/src/feed.ts:75-81`）。`WorkspaceView`（types.ts:19-31）= `workspaceId` /
`path`（realpath 规范）/ `title` / `sessionIds`（手工序成员表）/ `createdAt` / `updatedAt`（ISO-8601）。
后续增量：`upsert` / `remove` / `order` / `archived` / `pinned` / `replace`。

其他 workspace 命令（同文件）：`workspace/create`（幂等按 realpath 归一目录，返回 `{workspace, created}`）、
`workspace/initializeDefault`、`workspace/rename`（非空唯一标题；冲突 `workspace/name-conflict`）、
`workspace/insertBefore`、`workspace/insertSessionBefore`、`workspace/pinSession` / `unpinSession`、
`workspace/delete`。

### 3.4 归档 vs 删除

| | archive（Session 级） | workspace/delete（Workspace 级） |
| --- | --- | --- |
| 对象 | 单个 Session 从分组界面隐藏 | 删除 Workspace **注册** |
| 日志/文件 | 全保留 | 目录与每个 Session 日志全保留（registry index.ts:319-326 JSDoc "retaining files and Sessions"） |
| 记账 | 保留 `sessionIds` 槽位 | 注册消失，Session 仍在（变未分组） |
| 可逆 | `unarchiveSession` 恢复原位 | 不可逆（删除 default Workspace 还会永久关闭自动创建，index.ts:274-280） |
| **Session 级删除 API** | —— | **整个 session 命名空间没有任何 delete/remove/dispose RPC**（`packages/api/session-controller/src/index.ts` 的 `@Remote` 清单已核对，无删除方法） |

---

## 4. `session/rename`

**源码位置**：`packages/api/session-controller/src/index.ts:436-439`；实现 `commands.ts:202-227`；类型
`types.ts:298-307`。

**payload**（wire：`args.request`）：`{ sessionId: SessionId; title: string }`。

**返回** `{ title: string; seq: number }` —— 归一化后的标题 + 提交它的持久事件 seq（`session/title` 事件）。

**行为与校验**
- 先**显式恢复（resume）Session** 再改名（`resolveAgent`，commands.ts:542-546；冷 Session 会被激活）。
- 归一化：`normalizeSessionTitle(title, config.maxTitleBytes)`；归一后为空 → `session/title-invalid`
  （session-title 服务 `packages/session/session-title/src/index.ts:411-419`，`SessionTitleInvalidError`
  `:78-82`）。`maxTitleBytes` 是部署必配项（无默认，`:55-63`、`:303-307`）。
- 用户改名会**钉住**标题：终止在途自动命名，后续用户消息不再自动命名（`:400-409` JSDoc）。
- 部署未挂 session-title 服务 → `gateway/internal` "renaming is unavailable..."（commands.ts:207-210）。

**错误码**：`session/title-invalid`（details `{ sessionId }`，types.ts:207）、`session/not-found`、
`session/agent-busy`（subagent 会话）、`session/writer-held`（他人持有 writer）、`gateway/internal`。
Host 方法签名无 signal 参数（不支持 per-call 取消）。

---

## 5. 传输约定

**通道与帧**
- 逻辑通道 `/api`（`packages/client/connection/src/api-path.ts:6-7`）。HTTP 载体：`POST /api/<endpoint>`，
  请求 envelope `{ type:'client-request', rpcId, method, payload:{ args } }`，响应 envelope
  `{ type:'server-response', rpcId, result }`（`packages/client/connection/src/rpc.ts:90-97`）。
- `rpcId` 由调用方铸造、响应原样回带（rpc.ts:9-11）。二进制附件走 envelope 外的传输帧（rpc.ts:31-40）。
- 也有进程内直连 carrier（`connection.rpc.open`，用于流方法）与 WebSocket mux（Gateway
  `RemoteStreamMuxClient`，`packages/api/gateway/src/client/index.ts:159-162`）；一元 RPC 走 `rpc.call`。

**错误对象形态**
- 客户端拿到的是 `RemoteResult<T> = { ok:true, value } | { ok:false, error: RemoteFailure }`
  （`packages/typert/protocol/src/types.ts:130-132`）；**不会 reject**——载波失败/离线/中止都折进 error 分支
  （`packages/api/gateway/src/client/index.ts:466-473`）。
- `RemoteError extends Error`：`code`（稳定码）+ `message`（人类诊断，跨线保留）+ `details`（按码类型化的
  结构化载荷）；判定**永远按 `code`，禁止 instanceof**（`packages/typert/protocol/src/remote-error.ts:12-36`）。
  wire 上即 `{ code, message, details }`（`ConnectionRpcFailure`，rpc.ts:21-24）。
- 通用码（typert-protocol types.ts:103-110）：`gateway/bad-request`、`gateway/cancelled`、`gateway/internal`；
  Gateway 基础设施码清单（`gateway/arguments-invalid`、`gateway/service-unavailable` 等 20 项）在
  `packages/api/gateway/src/remote-error-codes.ts:15-41`。领域码按包各自向 `RemoteErrorDetailsMap` 合并声明。

**AbortSignal**
- 生成客户端方法最后一个可选参数是 `signal`（仅当 Host 方法声明了 `signal` 形参；
  `packages/typert/protocol/src/types.ts:430-434` cancellation 描述符）。调用侧与 mount token 信号
  `AbortSignal.any` 合并（gateway client index.ts:541-545）。
- abort → error 分支 `gateway/cancelled`（gateway client index.ts:471、`:842-847`）。
- 服务端 invocation 自带载波取消信号（"Client cancel, socket close, or an uplink failure"，
  typert-protocol types.ts:508-509；Host 侧合成 `AbortSignal.any([signal, registration.lifetime, peer])`
  gateway index.ts:573-580）。HTTP 客户端断开会 abort 该请求（`packages/client/connection/src/http-bridge.ts:44-52`），
  但业务方法只在声明了 `signal` 参数时才消费它。本文 API 中：`list`/`search`/`prompt`/`events` 等支持；
  `create`/`rename` 不声明 signal。

**超时**
- **没有任何 per-RPC-call 超时**：`packages/client/connection` 与 `packages/api/gateway` 全文无单次调用
  deadline；调用方要限时需自带 `AbortSignal.timeout(...)`。
- 连接层仅有"generation 就绪"超时与重连退避（`packages/client/connection/src/recovery-config.ts:26-30`）：
  `backoffBaseMs=500`、`backoffFactor=2`、`backoffMaxMs=10_000`、`generationReadyTimeoutMs=15_000`。
- workspace-controller 的 `documentsLookupTimeoutMs`（默认 10s）只作用于 `workspace/initializeDefault` 的
  目录探测（index.ts:75、`:103-111`）。

**鉴权**：`/api` 前的 admission 返回 HTTP 401/403（rpc.ts:118-126 `PeerAdmission`）；业务结果永远走 200 + result envelope。

---

## 6. 未确认事项（源码中找不到确切答案）

1. **`session.create`（点号）写法在仓库任何 wire/代码中都不存在**；canonical 名是 `session/create`。若
   dsh-imessage 的既有设想文档以 `session.create` 为 wire 名，需确认其出处（可能是把 TS 客户端
   `remote.session.create` 误记为方法名）。
2. **per-call 超时**：carrier 层确认无单次调用超时，但上层应用（desktop/web app 自身的调用包装）是否另行
   加超时未逐一排查；结论仅对 `dsh-client-connection` + `dsh-api-gateway` 载体成立。
3. `RemoteError` 的 `options.cause` 明示 "survives in-process only"（remote-error.ts:24-25 注释），即跨线不保
   留 cause；wire 侧无对应字段可实证，按注释采信。
4. `session/create` 成功但 attach 失败的 Session（`session/workspace-attach-failed`）处于"已发布未挂靠"状
   态：客户端 manager 会把它上列表，但**服务端没有公开的"补挂靠"RPC**（`attachSession` 仅进程内服务方法）；
   dsh-imessage 若遇此错误如何恢复（重试 create？换 cwd？）无源码级答案。
5. `session/list` 的 `cursor` 字段当前被忽略（"reserved"），未来可能启用分页；不可依赖"永远全量返回"。
6. 默认 `agentPreset` 的具体取值取决于部署 cordis.yml 的 preset roster 组合，源码中无固定字符串；各 profile
   的实际组合未在本次范围内逐一核对。
7. `packages/sdk/`（stdio JSON-RPC）面是否可作为 dsh-imessage 的替代接入通道，未做适配性评估（其面不含
   create/list/workspace）。
