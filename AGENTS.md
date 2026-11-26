# AGENTS.md

面向 AI 开发者的项目规范。规划与设计定案在 `docs/` 目录：每个需求一个子目录（英文命名），目录内固定有 `plan.md`（实施方案），探针结论/宿主事实等支撑文件随目录放，索引见 `docs/README.md`；本文只写代码本身体现不出来的规矩。

## 不可违反

- **不自动 commit / push**，由维护者明确决定。
- **提交后必须 `git show --stat HEAD` 验证**内容与 message 一致——
  lefthook pre-commit 的 stash 恢复可能把未暂存文件混进提交。
- **隐私红线**：真实 `chat.db` 导出的任何数据落盘前必须脱敏——结构保真、
  内容替换为合成文本。测试 fixture 同样适用。
- **Error / 日志消息保持英文**（永不 i18n）；i18n 层只覆盖发给用户的
  iMessage 回复文本。这条是架构边界，不是语言偏好。

## 提交

- **不在 main 上直接提交**：新建分支（`type/slug` 命名，如 `docs/foo`、
  `feat/bar`）开发，以 PR 方式合入；分支保护不允许直接 push main。
- Conventional Commits（`type: subject`）；subject 不得以大写英文单词
  开头（commitlint `subject-case` 规则会拦截，`M2`、`JSONL` 均被拦过）。
- 提交门：`pnpm check` 全绿（typecheck + lint + build + test）。

## 依赖更新（dependabot）

- 每周自动检查 npm 依赖（github-actions 月度）：minor/patch 聚合组 PR、
  `@deepseek-ai/*` 单独组、**major 单独开 PR**——不是每个 PR 都该收。
- 合并前必须评估依赖间兼容性，不能全盘照收：
  - **宿主注入类依赖**（react 等 bundle externals 平台模块）跟随 DSH
    宿主版本，不单独升级（例：宿主 client/web 仍 react ^18，react 19
    PR 已关闭）
  - DSH 官方包升级注意 apiProxy/类型漂移（DshPort 是唯一接缝 +
    兼容测试守护）
  - 工具链 major（typescript/eslint）看下游生态支持范围（例：
    typescript-eslint 的 peer ts 范围）
- CI 全绿 ≠ 兼容性没问题（react 19 本地可绿、宿主仍 18——运行时
  用的是宿主注入的版本）
- **关闭的 PR 会重开**（weekly 重新检查）；永久忽略写
  `dependabot.yml` 的 `ignore` 并注明原因，不靠反复手动关闭
- 合并被分支保护 strict 检查拦住（BEHIND）时：update branch
  （merge main + push）；**pnpm-lock 冲突不手解**——删 lock 后
  `pnpm install` 重建

## 命令

| 命令 | 用途 |
|---|---|
| `pnpm check` | 提交门 = typecheck + lint + build + test |
| `pnpm test` | 只跑测试 |
| `pnpm test:report` | 控制台覆盖率报告（含未覆盖行号） |
| `pnpm test:report:ai` | AI 补测任务清单（未覆盖分支 + 源码行 + 留白标记） |
| `pnpm dev` | 真机手工 CLI（probe/peek/send/listen，不进 npm 包） |

## 本地参考源码

探索 DSH 宿主或 dsh-im 参考实现源码时，先读根目录 `LOCAL_REPOS.md`
（gitignore，不入库）登记的本地仓路径，直接读本地文件；
没有本地 clone 时才走线上。机器/路径变更时同步更新该文件。

## 测试

- 测试目录镜像 src 结构；fake / 测试工厂放 `tests/helpers/`。
- 分支覆盖率基线 ≥ 93%，只升不降。`scripts/coverage-report.mjs` 的
  `KNOWN_SKIP` 表登记已知留白（真 IO / 不可达分支），新增留白必须登记
  并注明原因，不许静默放过低覆盖。
- 断言含数学推导时在断言旁写明算式（延迟、覆盖率配额等期望值曾算错，
  先核数学再怀疑实现）。

## 文档同步

- 任何代码改动完成后，检查 `docs/README.md` 与 `docs/PLAN.md`，
  确认是否需要同步更新（新需求目录、里程碑状态、索引口径等）；
  改动涉及某个需求目录的，同步核对该目录 `plan.md`。
- 文档与代码不一致时，**以代码为事实标准，反向更新文档**，
  不迁就过时描述、不留双源。

## 真机探针纪律

- 真机探针（`scripts/probe/`）创建的 workspace / session 会写进 DSH
  **全局持久层**（`~/.dsh/storages/workspace.json`、`~/.dsh/sessions/`），
  跨 profile 可见、随宿主重启出现在侧栏——**探针结束必须注销**
  （`workspaceRegistry.delete`，成功与失败路径都要），不只清 /tmp 目录。
- 探针用临时 id 前缀（如 `imessage-probe-`）便于事后排查残留。
- **不要手改 DSH 宿主的持久化存储**（`~/.dsh/storages/*.json`）：
  内部结构是宿主私有契约（实测：workspace 在 `tables.workspaces` 与
  `global.workspaceIds` 双处关联，只删一处会导致宿主一致性异常、
  侧栏工作区/会话整体丢失）。残留清理走官方途径：运行中的 UI 手动
 删除，或 `workspaceRegistry.delete()`——探针自清理已覆盖后者。

## 日志与排查

日志位置：`~/.dsh-imessage/logs/imessage-YYYYMMDD.jsonl`（按天滚动，保留 7 天，
一行一个 JSON：`ts` / `level` / `event` + 字段）。**成功路径也打点**——每条消息
一条链路，用于定位"卡在哪一步"。正文类内容（消息文本、AI 回复）**永不入日志**，
只记 `chars` 字数。

排查从"链路断在哪"入手，而不是先猜代码：

| 现象 | 先看哪一行 |
|---|---|
| 发消息毫无反应 | 有没有 `pipeline.fetch`？没有 = 没拉到（chat.db / 探测） |
| 拉了但不回 | `pipeline.message-skipped` 的 `reason`（`not-allowlisted` / `already-seen`） |
| AI 慢 | `pipeline.ask-done` 的 `firstDeltaMs` / `totalMs` |
| 图片没送进 AI | `pipeline.media-loaded` 的 `loaded`/`skipped`（skipped>0 看 `reasons`）；进了但被剔 → `dsh-port.image-skipped` 的 `reason` |
| 回复发不出去 | 有 `reply-sent` 吗？没有但见 `send-failed` = AppleScript / 权限 |
| 文件没发出去 | 有 `artifact.queued`（AI 声明了交付）吗？没有 → 看 `artifact.tool-rejected` 的 `reason`（工具被拒）；有 → 看 `file-sent` 还是 `file-send-failed` / `outbound.stage-failed` 的 `code`；通知文本由系统路径补发 |
| AI 答非所问（对方明显在引用某条消息） | prompt 里该有引用块（`> 引用了…`）：没引用块 → 看 normalize 是否给了 replyTo（chatdb JOIN 是否命中）；有引用块但 AI 仍答偏 → 模型问题 |
| AI 不知道对方是谁 / 一直问「你是谁」 | 有没有 `peer.published`？没有 = patch 里 contacts 没写对（键要带 +86 归一化号码，设置页称呼区编辑保存即可）或绑定表为空；有 `named:false` = 称呼未填（AI 会主动问）；设置页改称呼保存 → loader/volatile-update 热更重发 |
| 插件没启动 | 有 `channel.started` 吗？没有看 `channel.probe-failed` 的 `disk`/`automation` |
| 启动配置没生效 | `channel.started` 的 `allowlistCount` / `intervalMs` / `cursor` |
| 退出时丢消息 | `channel.stop-requested` 紧跟某条 `send-failed … aborted`（定案：不重发） |

事件清单（`src/` 内 `log.*` 唯一来源）：

- 生命周期：`channel.probe-ok` → `channel.started` → `channel.stop-requested` →
  `channel.stopped`（含 `processed`）；异常为 `probe-failed` / `start-failed` /
  `stopped-unexpectedly` / `fatal`
- 配置热更：`channel.config-updated`（`locale` / `allowlist` / `changed`）——
  UI 改 volatile 配置后立刻可见；重启后与 `channel.started` 的 `allowlist`
  对得上即证明持久化闭环
- 单条消息链路：`pipeline.fetch`（仅非空批）→ `message-claimed` →
  `pipeline.media-loaded`（仅有附件的消息）→ `ask-start` →
  `ask-done` → `reply-sent` → `message-done`；旁支 `message-skipped`、
  `media-failed`、`image-skipped`、`send-failed`、`message-failed`、
  `retry-exhausted`、`permission-stopped`
- 外发附件（M6.2）：`artifact.queued`（交付工具声明，ask 流内）→
  `outbound.staged` → `file-sent`；旁支 `outbound.swept`（仅 deleted>0）、
  `outbound.stage-failed`、`file-send-failed`（失败后续发系统通知文本，
  通知自身失败见 `pipeline.notify-failed`；均 at-most-once 不重试）。
  工具被拒不入队：`artifact.tool-rejected`（`reason`——无 agent 语境 /
  非 iMessage 会话 / 参数与限额拒绝，AI 会收到同文案的报错）
- 会话：`router.session-created`、`router.orphan-session`
- 身份上下文（M7）：`peer.published`（启动全量 / 配置热更（contacts 变化）/
  新会话首绑时，每绑定一条；字段 conversationKey/sessionId/named，
  称呼文本永不入日志；称呼存 profile config 的 contacts 字段，
  热更与 allowlist 同链路）
- 空批不打点（否则 2 秒一条心跳刷爆日志）；新增事件请遵守此原则

## 真机 e2e 纪律

真机测试（`pnpm e2e`，Playwright + 系统 Chrome）必须满足三条：

- **隔离**：`DSH_HOME` 与 `DSH_IMESSAGE_HOME` 都指向 `mkdtemp` 临时目录，
  真实 `~/.dsh`、`~/.dsh-imessage` 一字不动；白名单填假号码，不产生真实消息。
- **清理**：杀进程组（`detached` + `kill(-pid)`）→ 删临时目录 → 断言目录已消失；
  启动前 `sweepLeftovers()` 扫掉上次被强杀留下的残留。
- **不钉宿主内部版本**：例如首启提示靠 `welcomeNoticeVersion` 常量判断，
  该常量随 DSH 升级会漂；e2e 用 UI 自己的关闭控件关弹窗，不硬编码版本号。

e2e 不纳入 `pnpm check`（需要真宿主 + Chrome），单独跑；`e2e/` 目录不单独建包，
测试放 `tests/e2e/`，配置在根 `playwright.config.ts`。

## 协作

- 设计遇到分叉：列出选项、各自取舍与倾向，由维护者拍板，不擅自定案。
- 发现实现 bug 与任务约束冲突（如测试要求与"禁止改 src"冲突）：停下
  上报，不越权修改约束外的文件。
- 一步一交付：功能 + 镜像测试 + check 绿即停，等维护者审视。
