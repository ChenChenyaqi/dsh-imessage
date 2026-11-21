# M4 宿主集成 · 实施计划（已完成）

> 需求：core 内核接入 DSH 宿主——cordis 插件生命周期、DSH 服务适配、
> 通道装配与热更新、最小管理 RPC、设置页客户端 UI、真机 e2e。
> 宏观边界见 `docs/PLAN.md` M4/M5；本文按代码反写，沉淀设计定案。

## 0. 范围与子目录归属

| 位置 | 内容 |
| --- | --- |
| `src/host/index.ts` | cordis 插件入口：name/inject、Config schema、apply 生命周期 |
| `src/host/dsh-port.ts` | apiProxy 适配：DSH 宿主服务 → core `DshPort` 契约（唯一接缝） |
| `src/host/dsh-api.ts` | 宿主服务类型子集 + branded 转换（事实面） |
| `src/host/rpc.ts` | 最小管理 RPC：`POST /api/dsh-imessage/status` |
| `src/host/channel.ts` | 通道装配：core 全组件 + 宿主适配层 → 可启停通道 |
| `src/client/` | 设置页客户端半身（单包双面） |
| `tests/e2e/` | Playwright 真机 e2e（宿主夹具 + 设置页验收） |

本目录两个子目录：

- **`settings-ui/`** — M4 超额的设置页设计（方案 A：客户端 UI 插件）。
  含 hooks→store 化架构定案与真机探针事实；其中 preset 下拉部分
  属于 M5 人设，设计归 `docs/agent-preset/plan.md`。
- **`host-api/`** — DSH 宿主 API 事实库（plugin/rpc/ask 三份，带源码
  行号），防接口漂移用；不是需求设计。

## 1. 插件入口（src/host/index.ts）

- [x] `inject = ['agents','workspaceRegistry','agentDefaultModel','sessionTitle']`
  ——探针事实：不声明则 ctx 访问直接抛错；`connection` 不在列，
  部分宿主无该服务，走 `ctx.inject(['connection'], ...)` 动态注入降级。
- [x] Config schema：六个 volatile 字段（locale/allowlist/chunkedReplies/
  maxChunks/delayFactor/agentPreset）+ 两个非 volatile（intervalMs/
  maxBackoffMs）。volatile 引用语义由 `readVolatile` 统一（活引用
  `.get()` 与普通值同形，测试/嵌入环境原样返回）。
- [x] apply 三件事：组装 `DshPortServices`（agentPresets 动态取，
  无该服务 = 预设降级宿主默认）→ `startImessageChannel` →
  `ctx.effect(() => () => channel.stop())`（Disposable 返回 Promise
  会被 await，卸载时等 pipeline 收尾，at-most-once 靠 stop 落盘）。
- [x] 监听 `loader/volatile-update` → `channel.updateConfig`（UI 热更入口，
  监听器抛错由宿主兜底不影响已提交配置）。
- [x] 与官方契约的兼容性由 `tests/host/type-compat.test.ts` 编译期守护。

## 2. DSH 服务适配（src/host/dsh-port.ts + dsh-api.ts）

- [x] **DshPort 是内核与 DSH 框架的唯一接缝（M3 定案）**：DSH rc 升级的
  接口漂移只波及 `dsh-port.ts` 与 `dsh-api.ts`，core 不感知。
- [x] `createSession` 预绑定事务：mkdir 先行（registry 有 realpath 校验）
  → `workspaceRegistry.create` → `agents.create`（必带 agentOptions =
  `agentDefaultModel.currentSelection()`；sessionId 生成权归 port，
  前缀 `imessage-` + UUID）→ `workspace.attachSession` →
  `sessionTitle.rename`（收 Session 对象，不是 id 字符串）；attach/rename
  失败回滚 `dispose`，不留孤儿活 agent。
- [x] preset 路径：`agentPresets.resolve` → `meta.agentPreset` 记账 +
  setup 挂载（人设生效唯一路径）；resolve 失败降级无人设创建 + warn
  （体验项不许炸通道）。
- [x] `getSessionStatus` 三态：归档集优先（archivedSessionIds）→ 活句柄
  `agents.get` → 冷会话 `resume` 试探（`SessionPersistenceNotFoundError`
  = missing；其余失败原样上抛当 route 失败）。
- [x] `ask` 流式：推送事件转拉取迭代（队列 + wake）；`text-delta` 增量
  透传；**turn 编号隔离迟到事件**——记录本轮首个 `turn/start` 的编号，
  编号不匹配的 `turn/end` 一律忽略（上一轮超时/取消的迟到收口不许
  污染本轮）；`turn/end` 五态收口：completed/blocked/max-tokens 正常返回，
  error → `DshAskError`（带中性稳定码），aborted → 上抛。
- [x] abort 语义：signal → `cancel({kind:'user'})` 只取消 + 唤醒，收口仍
  等 `turn/end`（源码事实：finally 兜底必追加）；兜底超时 180s——宿主
  走失 `turn/end` 时 cancel + 抛 TIMEOUT，防单条消息堵死通道。
- [x] 监听器随流结束/中断经 generator finally 卸载，不泄漏订阅。
- [x] `dsh-api.ts` 只放适配层消费的成员（接口按需裁剪）；branded 转换
  跨层显式 `as`（官方 brand 与 core brand 标签不同）。事故注记：
  `session/event` 首参是 Session 对象——按字符串比较曾导致流永不收口。

## 3. 通道装配与热更新（src/host/channel.ts）

- [x] apply 是薄壳，装配独立可测（`tests/host/channel.test.ts` 规格化）。
- [x] 启动门卫：权限探测失败 → 不启动轮询（半瘫防线：轮询能跑但发送
  必失败，宁可不动等人工修权限）；db 打不开 → `start-failed` 单独归因；
  probe-failed/start-failed 通道仍能答 `updateConfig`/`currentAllowlist`
  /`currentStyle`（live 容器始终存在）。
- [x] 热更新 `applyHotConfig`：改 live 容器 + 运行中 deps 的字段（pipeline
  用时读，立即生效）；白名单按元素比较；变更留痕 `channel.config-updated`；
  预设热更只影响之后新建的会话（composition 创建时定格）。
- [x] `stop` 幂等：`stop-requested` → abort → await 收尾 → 关库。

## 4. 管理 RPC（src/host/rpc.ts）

- [x] `connection.fetch.register` 挂 `POST /api/dsh-imessage/status`（只读
  快照：phase/reason/probe/error + allowlistCount + cursor + sessionCount）；
  手工 client-request/server-response envelope，不引入生成产物。
- [x] 安全：宿主外层已做浏览器鉴权，本层再加 loopback 校验纵深
  （非 localhost/127/::1 → 403；方法/Content-Type/JSON 守卫）。

## 5. 设置页客户端 UI（src/client/）

- [x] 单包双面：`package.json` 的 `dsh.client` + `exports['./client']`，
  closure-factory 产物；`settings.section` 槽位注册（必须
  `slots.inject(...)` 延迟注册，直接 register 会炸掉客户端 boot）。
- [x] volatile 热更写入链路（真机实测闭环）：
  `ConfigField → form.set() → settings.mutate RPC → configEditor.edit()
  → 原子写 cordis.patch.yml → loader _commitVolatile → emit
  loader/volatile-update → channel.updateConfig() → 日志
  channel.config-updated`。
- [x] 架构：草稿 override store + 字段级订阅 + 域目录
  （locale/allowlist/chunked/preset/save-bar）；DOM 契约冻结供 e2e 依赖
  （`[data-dsh-imessage-card]`、`select[data-field="preset"]` 等）。
  详见 `settings-ui/plan.md` 第 6 节（现行架构以此为准）。

## 6. 真机 e2e（tests/e2e/，pnpm e2e，不进 pnpm check）

- [x] `settings-ui.spec.ts`（单导航多 step，每次 goto ~5s）+
  `support/host.ts`（宿主夹具）。三条纪律：
  1. **隔离**：`DSH_HOME` 与 `DSH_IMESSAGE_HOME` 都指 `mkdtemp` 临时目录，
     真实 `~/.dsh`、`~/.dsh-imessage` 一字不动；白名单填假号码。
  2. **清理**：杀进程组（detached + `kill(-pid)`）→ 删临时目录 → 断言
     目录已消失；启动前 `sweepLeftovers()` 扫掉上次强杀残留。
  3. **不钉宿主内部版本**：首启弹窗用 UI 自己的关闭控件（Continue/
     Close/Escape 轮询），不硬编码 `welcomeNoticeVersion` 等内部常量。
- [x] 覆盖：boot 清单断言、白名单增删/非法号码校验、保存持久化
  （patch 文件 + `channel.config-updated` 日志）、不保存关闭丢弃草稿
  （真机 bug 回归）、locale、分段字段、preset 下拉显式选择持久性。

## 7. 沉淀（后续同类工作的依据）

- **接口漂移防线**：DSH 类型/服务面变化只改 `dsh-port.ts`/`dsh-api.ts`；
  事实基准在 `host-api/`（带行号），宿主升级按图复核。
- **volatile 热更链路**是设置页免重启的闭环：UI 只渲染 volatile 字段，
  loader 提交活引用并广播事件，通道消费 `.get()` 即最新值；重启后
  `channel.started` 的 allowlist 与热更后一致 = 持久化闭环验证法。
- **e2e 三纪律**（隔离/清理/不钉版本）适用于一切真机测试，新增 e2e
  沿用 `support/host.ts` 夹具。

## 8. 验收状态

- [x] MVP 收口 2026-11-13：desktop 内安装，白名单号码一问一答稳定。
- [x] 连续运行 24h：无 error 日志、cursor 一致（M4 验收，见
  `docs/PLAN.md` 里程碑记录）。
- [x] 重启不丢不重（at-most-once，M3 崩溃语义在真机复验）。
- [x] e2e 约 4.5s 稳定复跑；`pnpm check` 全绿（e2e 单独跑）。
