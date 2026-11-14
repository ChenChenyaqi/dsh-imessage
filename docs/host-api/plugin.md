# DSH 插件宿主机制事实清单

来源仓库：`/Users/chenyaqi/Documents/github-projects/deepseek-harness`（以下路径均相对该仓库根）。
方法：只读源码探索；所有事实附「文件:行号」，行号对应探索时的 HEAD。本文不贴大段源码。

阅读对象：dsh-imessage 的 host 适配层（`src/host/`）与后续 M4 实现。

## 0. 结论速览（先看这里）

- **DSH 源码中不存在 `apiProxy`**。全仓库 grep `apiProxy` 仅命中一条 2026-07-27 的设计笔记，且那条笔记记录的是「把注册表挂到 `ctx.apiProxy` 名下——不予采纳」（`.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md:161`）。dsh-imessage 计划文档中的 `apiProxy` 一词在 DSH 中没有对应实现。
- dsh-imessage 是**进程内 cordis 插件**（经 `--patch` 载入宿主），它调用宿主 API 的真实机制是 **cordis Context 上的服务属性**（`ctx.agents`、`ctx.workspaceRegistry` 等，见第 2 节），不是任何 RPC proxy 对象。
- `session.create` 这类「RPC 方法名」属于 **Gateway HTTP API / 客户端 `ctx.remote.<ns>`** 面（Host↔Client），进程内插件不经过它；进程内等价能力是直接调用同名 Host 服务（第 2.3 节）。

## 1. 插件如何被加载与实例化（`--patch`）

### 1.1 CLI 解析

- `--patch <path>` 是可重复的 launcher 选项（`--patch a.yml --patch b.yml`），刻意不做 variadic；空路径直接报错退出。定义在 `apps/cli/src/args.ts:170`，收集器 `apps/cli/src/args.ts:73-74`，空值校验 `apps/cli/src/args.ts:113`。
- `dsh <name>` 是 `dsh --profile <name>` 的简写；保留名 `desktop` 由 Electron 独占，CLI 直接启动被拒（`apps/cli/src/args.ts:83-88`、`:183`）。
- 另有 `--dump-config` / `--dump-default-config` / `--dump-config-schema` 三个只读诊断 flag，会拒绝与 `--patch` 的部分组合（`apps/cli/src/args.ts:133`、`:173`；行为说明 `apps/cli/reference/README.md:52-60`）。

### 1.2 配置树与 overlay 组合顺序

- profile 的根配置是**空 entry 列表**（`apps/cli/src/profile-boot.ts:81-88`），整个插件树全靠 patch 叠加。
- 叠加顺序（后者覆盖前者的整行 `config`，不深合并）：① profile manifest `dsh.profile.bundles` 中的各 bundle patch → ② profile 自身 `cordis.patch.yml` → ③ home 级 `$DSH_HOME/cordis.patch.yml` → ④ 按 argv 顺序的 `--patch` overlay → ⑤ 遥测开关。实现于 `apps/cli/src/profile-boot.ts:224-236`（`composeProfile`），层序文档 `apps/cli/README.md:40-46`。
- overlay 文件格式：**顶层数组**的 loader patch 列表，每项是 `@deepseek-ai/cordis-plugin-include` 的 `PatchOptions`——按 `id` 定位既有行做覆盖/禁用，或用 `insert` 插入新行；`config` 与 `disabled` 支持 `!!js` 表达式。解析在 `packages/boot/app-boot/src/index.ts:556`（`loadOverlayPatches`）与 `:586-606`（`parsePatchList`）。现成示例：`apps/web/tests/pin-browse-picker.overlay.yml`、`apps/cli/tests/fixtures/github-webhook/cordis.yml`。
- **insert 行的相对路径锚定**：`insert` 行的 `name` 若以 `./`、`../` 或绝对路径开头，会解析为相对该 patch 文件所在目录的 `file://` URL（`packages/boot/app-boot/src/index.ts:568-577` `anchorInsertedPluginNames`）。所以 `--patch ./my-overlay.yml` 可以直接引用 overlay 旁边的本地插件文件；bare 包名则走宿主/profile 的包解析。
- overlay 语法非法/读不到 → 启动直接失败（throw，`packages/boot/app-boot/src/index.ts:560-564`、`:592-598`）；patch 目标行不存在 → 仅每条 warning（设计如此，同一 overlay 可服务多个树）。

### 1.3 boot 与 Loader 实例化

- `runProfile`（`apps/cli/src/profile-boot.ts:282`）→ `boot()`（`packages/boot/app-boot/src/index.ts:1220`）：new 根 `Context` → `ctx.plugin(Loader)` → `prepare` 钩子里先 `provide('profileContext')`（`apps/cli/src/profile-boot.ts:338`）与 `cmdlineArgs`（`:347`）→ `mountRootInclude`（`packages/boot/app-boot/src/index.ts:758`）把根 `cordis.yml` 挂成 `cordis:include` 内建插件并把各层 patch 摊平成一次 `applyEntryPatches` 应用 → 等待整棵树 settle → `auditStartupEntries`（`:1173`）。
- Loader 是 vendored `@deepseek-ai/cordis-plugin-loader` 的 `Loader extends EntryTree`（`vendor/loader/src/index.ts:72-113`）；树中每个 entry 是 `EntryOptions { id, name, config, group, disabled, inject }`（`vendor/loader/src/config/entry.ts:9-23`）。
- 单个 entry 的实例化：`Entry.init/_init`（`vendor/loader/src/config/entry.ts:213-233`）→ `EntryTree.import(name)`（`vendor/loader/src/config/tree.ts:182-203`）→ `loader.unwrapExports`（解 `default` 导出，`vendor/loader/src/index.ts:209-217`）→ `ctx.registry.plugin(plugin, config)`。
- 模块 specifier 解析（`vendor/loader/src/config/tree.ts:184-201`）：`cordis:` 前缀走 Loader 内建表（include、group 由 boot 注入，`packages/boot/app-boot/src/index.ts:765-783`）；相对名按 `ctx.baseUrl`（= 根配置文件所在目录）拼 URL；bare 包名经 `createResolve`（`vendor/loader/src/resolve.ts:55-75`）——在最近的 `package.json` 作用域写 `.cordis/resolve.mjs` helper，用 `import.meta.resolve` 在**配置项目自己的依赖范围**内解析。dsh-imessage 的 `cordis.patch.yml` 用 bare 包名 `@chenyaqi/dsh-imessage`，因此要求该包出现在被启动 profile 项目的 node_modules（`dsh plugin --profile X add` 或手动 pnpm 安装），或改用 `./` 相对路径 + `--patch` 锚定。

### 1.4 加载失败的行为

- **import 失败**：`Entry._init` 捕获后 `ctx.logger.error(error)` 并直接 return——该 entry 没有 fiber，不阻断其它插件（`vendor/loader/src/config/entry.ts:226-231`）。
- **激活/配置校验失败**：fiber 进入 FAILED，错误由 `_reload` 记录（`vendor/cordis/src/fiber.ts:681-704`）。
- **启动审计**（`packages/boot/app-boot/src/index.ts:1173-1190`，明细 `:1062-1105`）：非必需 entry 失败/pending → stderr 一条 warning，宿主继续运行；必需 entry（全局 `requiredStartupEntryIds`：agent-loop、webserver、connection、sdk-jsonrpc-server 等，`:966-978`）失败 → `StartupError`，进程失败退出。pending（等待 `inject` 服务）会列出缺失服务名。
- **进程级兜底**：`installFailLoud` 把 unhandledRejection/uncaughtException 变成 stderr 诊断 + exit 1（`packages/boot/app-boot/src/index.ts:899-953`；挂接 `apps/cli/src/profile-boot.ts:322`）。

### 1.5 插件包约定

- Loader 对 package.json **无强制字段**：任何能被 import 且导出符合 cordis 插件形态的模块即可（形态见第 3.1 节）。DSH 生态约定：ESM（`"type": "module"`）、入口导出插件本体、`peerDependencies` 里声明 `@deepseek-ai/cordis`（`workspace:~`）及所用 dsh 服务包（样板：`packages/experimental/webhook/package.json`）。
- 版本兼容：插件 manifest 的 `engines.dsh`（优先）或 `@deepseek-ai/dsh*` peerDependencies 与运行时 dsh 版本比对，不满足的行在组合前被禁用并写 stderr（`packages/boot/app-boot/src/plugin-compatibility.ts:65-90`；入口 `prepareProfileEntries` `packages/boot/app-boot/src/compatibility-preflight.ts:74-85`）。
- 安装通道：`dsh plugin --profile <name> <pnpm args>` 子命令把参数原样转发给在 profile 目录里跑的 pnpm（`apps/cli/src/args.ts:188-200`；管理面 `packages/boot/plugin-manager/`）。

## 2. 插件拿宿主 API 的机制

### 2.1 没有 apiProxy：机制是「Context 服务属性 + 声明合并」

- 插件拿到的 `ctx` 是 cordis `Context` 代理；宿主各能力是注册在 registry 里的**命名服务**，通过 `declare module '@deepseek-ai/cordis' { interface Context { xxx: Xxx } }` 做类型合并（`vendor/cordis/src/context.ts:13-33` 描述该接口）。范例：webhook 运行时把自己注册为 `ctx.webhookRuntime`（`packages/experimental/webhook/src/index.ts:14-18`、`:58-73`）。
- 调用形态就是**普通方法调用**（`ctx.agents.create(...)`），没有 `rpc(name, payload, timeout)` 的代理层；参数/返回是同进程对象，无需序列化。类型安全边界靠 TS 静态类型（DSH 规约：typed same-process boundary 不做运行时校验）。
- 声明依赖：`export const inject = ['serviceA', ...]`（函数插件）或 `static inject`（Service 子类）；依赖不满足时 fiber 保持 pending，服务上线后自动激活，服务替换时依赖方自动卸载重载（`vendor/cordis/src/fiber.ts:603-646`）。

### 2.2 仓库里真正叫「RPC」的三个面（都不是进程内插件接口）

| 面 | 调用形态 | 位置 |
|---|---|---|
| Client（浏览器/Web 客户端） | `ctx.remote.<ns>.<method>(args, signal?)`——生成代码生成的**具体函数**，明确不用 JS Proxy | `packages/api/gateway/src/client/index.ts:1-6`、`:103-131`；Context 声明合并 `:127-131` |
| Connection RPC（承载层） | `connection.rpc.call('/api', 'ns/method', payload, signal?)`，HTTP 上映射为 `POST /api/<ns>/<method>` | `packages/client/connection/src/rpc.ts:304-318`；映射说明 `docs/api-gateway.md`「Runtime invocation」节 |
| 子进程 SDK | `client.request(method, params?, timeoutMs?)`，方法名形如 `session/prompt`（注意是斜杠不是点）；`requestTimeoutMs` 可选、未设则无超时 | `packages/sdk/client/src/client.ts:408-431`、`:356`；选项 `packages/sdk/client/src/types.ts:48` |

- 错误传递：Gateway 面统一 `RemoteError(code, message, details)`，基础设施码表 `gateway/*`（`packages/api/gateway/src/remote-error-codes.ts:18-45`），业务码如 `session/not-found`、`session/agent-busy`（`docs/api-gateway.md`）。取消用 `AbortSignal`，**没有每调用的 timeout 参数**（仅 SDK 子进程面有 `timeoutMs`）。
- `session.create` 的 Host 实现在 `packages/api/session-controller/src/commands.ts:121-160`（`SessionCommandController.create`），语义（空白会话复用、workspace 归属、preset）见 `packages/api/session-controller/README.md:50`。
- dsh-imessage 计划里的 `apiProxy.rpc('session.create', …, timeout)` 形态最接近上表第 3 行（SDK），但 SDK 是「拉起 `dsh --profile sdk` 子进程走 stdio JSON-RPC」的库（`packages/sdk/client/src/index.ts:1-9`），与「经 `--patch` 进程内加载」是两条互斥路线。

### 2.3 进程内插件做「开会话 + 提问 + 流式收回复」的等价能力（webhook 范式）

完整可抄的参照是 `packages/experimental/webhook/src/session.ts`（一个受信程序化入口如何创建并驱动会话）：

- 创建 Agent/Session：`ctx.agents.create({ sessionId, meta: { cwd, agentPreset }, agentOptions, setup, signal })`，返回含 `agent` 与 `dispose()` 的 handle（`packages/core/agent/src/index.ts:410`；选项类型 `:55-115`）。用法 `packages/experimental/webhook/src/session.ts:110-121`。
- Workspace：`ctx.workspaceRegistry.create(绝对路径)` + `workspace.attachSession(id)` / `detachSession(id)`（`packages/experimental/webhook/src/session.ts:107-123`）。
- Preset/权限/标题/模型：`ctx.agentPresets.resolve/acquireScope/mount`、`ctx.permissionPresets.resolve/set`、`ctx.sessionTitle.rename`、`ctx.agentDefaultModel.currentSelection()`（同文件 `:38-101`、`:102-127`）。
- 提问：`handle.agent.followup(createUserMessage({ content: [...], source: {...} }))`——fire-and-forget 入队（`packages/experimental/webhook/src/session.ts:128-143`）。
- 流式收回复：`ctx.on('session/event', (session, event) => …)`，逐事件 post-commit 推送，与落盘顺序一致（事件契约 `packages/core/session/src/index.ts:59-79`）；同文件还有 `session/created`、`session/disposed`、`session/flush`。
- 会话状态查询/持久化恢复另有 `ctx.sessions`（SessionStore，`packages/core/session/src/index.ts:36-38`）。

## 3. 插件生命周期

### 3.1 apply 的调用时机与插件形态

- 插件三种形态：函数 `apply(ctx, config)`、class 构造器、`{ apply }` 对象；公共元数据 `name`/`Config`/`inject`/`provide`/`intercept`（`vendor/cordis/src/registry.ts:92-122`）。
- 调用链：loader entry import 成功 → `ctx.registry.plugin(plugin, config)`（`vendor/cordis/src/registry.ts:316-336`）→ 新建 Fiber，等所有 `inject` 服务可用 → `_execute`：先 `resolveConfig`（用导出的 `Config` 做 Standard Schema 校验并填默认值），再调用插件（`vendor/cordis/src/fiber.ts:254-265`、校验 `:47-64`）。
- 校验失败/启动抛错：fiber FAILED，`await fiber()` 会 rethrow；entry 保留原始 config 供下次激活（`vendor/cordis/src/fiber.ts:681-704`；loader 侧 `vendor/loader/README.md`，V25 条目「Failed fibers require an explicit update after correcting its input or dependencies」，见 `vendor/README.md`）。

### 3.2 dispose / 卸载

- 一切注册都是 effect：`ctx.effect(() => disposer)`、`ctx.on(...)` 返回 disposer、Service 注册同理；卸载时**反序**执行 disposer，async disposer 会被等待（`vendor/cordis/src/fiber.ts:63-76`、`_unload` `:712-748`）。
- `ctx.fiber.dispose()` 自卸载：loader 监听 `internal/plugin` 把该 entry 持久化为 `disabled: true`（`vendor/loader/src/index.ts:128-173`，含 8 种情形甄别）。
- profile 关停：`runProfile` 的 `dispose()` 会 `app.current.fiber.dispose()` 整树（`apps/cli/src/profile-boot.ts:296-303`），SIGTERM 退 0、SIGINT 退 130。

### 3.3 config 变更：重新 apply，不是热更新回调

- loader entry 的 config 变化走 `Entry.update`（`vendor/loader/src/config/entry.ts:121-163`）：普通字段变化 → `fiber.update` → `internal/update` waterfall → 默认 **restart（dispose 后重新 apply）**（`vendor/cordis/src/fiber.ts:783-821`）。
- 唯一例外是 **volatile 字段**（`.volatile()`）：仅 volatile 值变化时在运行实例上原位提交引用并 emit 实例内 `loader/volatile-update` 事件，不重启（`vendor/loader/src/config/entry.ts:165-200` `_commitVolatile`；作者视角文档 `docs/cordis-tutorial/05-config.md`「Volatile fields」节）。
- 插件自定义更新钩子：可监听 `internal/update` waterfall（veto restart）或 `loader/patch-context`；普通做法就是接受 remount。

### 3.4 文件/HMR 行为

- `dsh-hmr` 插件默认监视 profile 的 `cordis.patch.yml`、home 级 patch 和 profile manifest；变化后重组合并替换受影响插件（`packages/boot/hmr/src/index.ts:385-407`、`:918-975`）。`--patch` argv overlay 是**本次调用冻结**的，不被 watch（overlays 语义 `apps/cli/src/profile-boot.ts:256`；watch 列表只含 profile/home patch `packages/boot/hmr/src/index.ts:385`）。
- 模块代码热替换需要显式配置 `root`（模块监视根）；base bundle 把 hmr 行设为 `root: []`（`packages/bundle/base/cordis.patch.yml` 的 hmr 行；配置 schema `packages/boot/hmr/src/index.ts:217`）。

### 3.5 重复加载同一插件

- registry 以**导出的插件回调**为 key；每个 loader entry / 每次 `ctx.plugin()` 都是独立 fiber（`runtime.fibers` 列表；`vendor/cordis/src/registry.ts:136-143`、`:316-336`），本版本 cordis 无 `reusable` 门控（grep 无果）。
- 树内以 entry `id` 唯一（`vendor/loader/src/config/tree.ts:96-125` 的 store/ensureId）；同名不同 id 的两行会各自实例化、并行运行。webhook 运行时层面则以业务 key（rule id）拒绝重复注册（`packages/experimental/webhook/src/index.ts:108`）。

## 4. Config schema

- **DSL 是 vendored Schemastery**（`@deepseek-ai/schemastery`，repo 版 3.19.0，上游 schemastery 3.18.0；`vendor/schemastery/package.json:4`、`vendor/README.md` manifest）。惯用写法：导出与接口同名的 `Config` 常量，`z.object({ source: z.string().required(), maxBodyBytes: z.number().step(1).min(1).required(), secretEnv: z.string().role('credential-ref').required() })`（完整样板 `packages/experimental/webhook-github/src/index.ts:16-33`；纯 JS 插件样板 `apps/cli/tests/fixtures/github-webhook/github-webhook-rule.mjs:7-14`）。
- cordis 只要求 `Config` 是 **Standard Schema v1** 验证器（`~standard.validate`；`vendor/cordis/src/fiber.ts:50-64`），Schemastery 是 DSH 的标准选择。
- 校验时机与失败行为：**apply 之前**校验；非法 config → `ValidationError`（带 `$.path` 级明细）→ fiber FAILED → 插件不启动；boot 审计把它按第 1.4 节规则告警/失败（`docs/cordis-tutorial/05-config.md`「Fail loud」节给出输出样例）。
- 默认值：`.default(...)`；缺字段由 schema 补全后交给 apply。`!!js` 表达式只允许出现在 `config` 值与 `disabled`（`docs/cordis-tutorial/05-config.md`「Computed config values」节；cordis.yml 约束另见根 `AGENTS.md` Secrets 节）。
- 设置页自动渲染：`@deepseek-ai/dsh-settings`（base bundle 装载）由 **schema 自动生成表单**，但只暴露 `.volatile()` 字段；普通字段仍走 cordis 配置文件（`packages/settings/settings/README.md` Summary 与「Use this package」节）。服务入口 `ctx.settings`（`packages/settings/settings/src/index.ts:39-44`、类 `:223`）；插件想自带管理页时用 `configure({ auto: false }, ctx.fiber)` 关掉自动页（`:266`）。写回经 `@deepseek-ai/dsh-config-editor` 落到 profile patch 并立即应用（`packages/boot/config-editor/src/index.ts:26`；README Summary）。
- 调试工具：`dsh --dump-config-schema` 从同一套 schema 投影出 JSON Schema 2020-12 文档（`packages/boot/app-boot/src/config-schema/`；说明 `apps/cli/reference/README.md:60`）。

## 5. 插件可用的其他宿主能力

- **日志**：`ctx.logger(name)`（callable LoggerService，`vendor/cordis/src/logger.ts:194-231`）；级别可经 intercept 配置；默认 exporter 只进 1000 条内存 ring buffer，真实输出依赖各 surface 挂的 exporter（effect 注册）。CLI surface 的最终日志 sink 位置未逐一定位（见「未确认事项」）。
- **定时器**：vendored `@deepseek-ai/cordis-plugin-timer` 提供 `ctx.timeout/interval/throttle/debounce`（及废弃别名 setTimeout/setInterval），全部 effect 化、随插件卸载自动清理（`vendor/timer/src/index.ts:1-20`；base bundle 默认装载 timer 行）。
- **事件**：`ctx.on/emit/waterfall/parallel…`，类型化事件用 `interface Events` 声明合并；会话相关事件见 2.3 节；waterfall 监听必须 `next()`（根 `AGENTS.md` Conventions）。
- **服务注册（插件暴露自己的 API）**：继承 `Service` 并 `super(ctx, 'myService')`（`vendor/cordis/src/service.ts:42-57`），或 `ctx.provide(name, value)`；消费方 `inject` 该名即获得类型化调用。
- **向客户端/设置页暴露管理 RPC**：业务 Service 继承 `TypertRemoteService`（或 `bindTypertRemote`）并在方法上标 `@Remote('name')` / `@RemoteScope(key)` 装饰器（`packages/typert/protocol/src/index.ts:236`、`:250`、`:282-380`）；由 Gateway 派发、客户端经 `ctx.remote.<ns>` 调用；包需导出 `./typert`（Host）与 `./remote`（Client）入口并跑 Typert 生成（全流程 `docs/api-gateway.md`「Programming model」「Strict generation pipeline」节）。源码启动（tsx）有装饰器 SRC 回退（同文「SRC development fallback」节）。
- **启动环境**：`ctx.get('profileContext')`（profile 名/目录/patch 路径/home/cwd，`apps/cli/src/profile-boot.ts:338`）、`ctx.cmdlineArgs`（本次调用内层参数快照，`packages/boot/cmdline/src/index.ts:84-86`）。
- **安装/管理面**：`packages/boot/plugin-manager` 提供 bundle 安装、诊断、版本管理（其 tools 入口在 base bundle 中默认 disabled，`packages/bundle/base/cordis.patch.yml`）。

## 6. `@deepseek-ai/cordis` 从哪来

- **workspace vendored 源码包**，不是外部 npm 依赖：`vendor/cordis`，包名 `@deepseek-ai/cordis`，repo 发布版 **4.1.0**（`vendor/cordis/package.json:4`），上游为 cordiverse/cordis **4.0.0-rc.11**（commit `0b96d9f…`）经 rescope+本地加固（manifest 与 V1–V27 改动清单：`vendor/README.md`）。
- 导出面（`vendor/cordis/package.json` exports）：`.`（lib/index.js）、`./src/*`（源码直出）、`./package.json`。运行时导出 Context/Fiber/FiberState/Service/Inject/Events/Logger/Registry 等（`vendor/cordis/src/index.ts:1-15`）。
- 依赖：`@deepseek-ai/cosmokit`（同为 vendored），可选 peer `cordis-plugin-loader/include`。
- 插件包声明方式（repo 内样板）：`peerDependencies` + `devDependencies` 均写 `@deepseek-ai/cordis: workspace:~`（`packages/experimental/webhook/package.json`）。外部项目（如 dsh-imessage）从 npm 安装同 scope 包即可获得与宿主相同的框架面。
- 全家 vendored 清单：cordis 4.1.0（上游 rc.11）、loader 1.1.0（上游 rc.8）、include、group、timer、hmr、schemastery 3.19.0（上游 3.18.0）、cosmokit、logger-console（`vendor/README.md` manifest 表）。

## 未确认事项

1. **`apiProxy` 的出处**：DSH 任何已发布面都不存在该名；唯一命中是一条被否决的设计笔记（`.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md:161`）。dsh-imessage 的 PLAN/README 若继续使用该词，应改为「cordis Context 服务（进程内）」或「Gateway HTTP API / SDK RPC（进程外）」之一；建议与该词的最初来源核对（是否混入了其它项目的命名）。
2. **宿主形态**：`--patch` 是 CLI（`dsh`）机制；Electron 的 desktop profile 由桌面应用独占启动且自身 `patchFiles: []`（`apps/desktop-host/src/index.ts:29-36`）。dsh-imessage 最终以哪个 profile/宿主运行（web/tui/headless 经 `dsh --patch`，还是 desktop 经 profile patch 或 `dsh plugin --profile desktop add`）未在本清单内验证。
3. **CLI 日志 exporter 的最终 sink**：`ctx.logger` 默认只进 ring buffer；CLI/Web 各 surface 挂接的输出 exporter 的具体位置未逐一查证（`packages/boot/app-boot/src/index.ts:1232` 只是启动诊断收集器）。若 imessage 依赖 `ctx.logger` 落终端，建议实测确认。
4. **`agents.create` 的完整契约细节**（resume/写锁、`sessionId` 自带规则、错误码表）本文只引了类型声明与 webhook 用法；实现细节在 `packages/core/agent/src/index.ts`（679 行）与 `packages/api/session-controller/src/agent.ts`，未逐行展开。
5. **同 id 双 insert** 在 include patch 组合中的覆盖语义按 `applyEntryPatches`「后写覆盖整行」推断，未单独跑实测。
6. **Python SDK**（`python/`）面未展开；如 imessage 需要非 TS 宿主集成再查。
