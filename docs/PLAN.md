# dsh-imessage · 实施计划

> 宏观路线图。只定大步骤与验收边界；模块接口、schema、UI 细节在对应里程碑开工时再细化。
> 立项讨论的完整结论见本文件；dsh-im 解构蓝图见 `ARCHITECTURE.md`。

## 一、项目定位

把 macOS 原生 iMessage 接入 DSH 的**官方 cordis 插件**：
只读轮询 `chat.db` 收消息 → 白名单准入 → 每手机号独立 DSH 会话（隔离工作区）→
回复经拟人化分段/延迟后由 osascript 控制 Messages.app 发出。

## 二、已确认决策（定案，实施中不再摇摆）

| #   | 决策 | 依据 |
| --- | --- | --- |
| D1  | 形态：DSH 官方 cordis 插件（`deepseek-ai/deepseek-harness` 标准），不做独立 Node 服务 | desktop 用户工作流；进程内 apiProxy 免 HTTP/鉴权；继承 DeepSeek Harness.app 已有的 FDA + Messages 自动化授权 |
| D2  | 分层：`core/`（零框架依赖内核）+ `host/`（薄 cordis 适配层） | 内核可独立单测、架构自主；与 dsh-im 的无边界 shared 层形成代差 |
| D3  | TypeScript + ESM + Node ≥22 + vitest；运行时零外部依赖 | `node:sqlite`/`fetch`/`WebSocket` 全内置 |
| D4  | 单 bot：不做 dsh-im 的多机器人注册/token 层 | 单机 iMessage 天然单身份，配置直写 |
| D5  | 数据完全独立：数据根 `~/.dsh-imessage/`（含 per-conversation 工作区），不碰 dsh-im 的任何目录 | 与 dsh-im 共存、切换互不污染；M1 已定案，可用 `DSH_IMESSAGE_HOME` 覆盖（测试/自定义安装） |
| D6  | i18n 保留：zh/en 起步，轻量 `t()` 层放 core | 用户要求 |
| D7  | 借用 dsh-im 验证过的 **macOS 事实**（chat.db SQL、typedstream 解码、绑定事务踩坑、osascript 用法），代码全部自研 | 这些是事实知识，不是代码 |
| D8  | 安全边界：chat.db 只读；发送只走 Messages.app 自动化；白名单默认拒绝 | 沿用 dsh-im 原则 |
| D9  | 业务配置走 DSH 官方体系：插件导出 Config Schemastery schema → cordis 加载时校验 → 存 profile；DSH 设置页据 schema 自动生成表单，用户不碰任何 JSON 文件。`~/.dsh-imessage/` 只存运行时状态（state/日志/会话工作区）。插件启停用 DSH 插件列表开关，不设业务级 `enabled` | 查证 DSH 源码 `packages/settings`（autoGenerate 表单 + 乐观锁/脱敏/HMR）；避免自建配置体系与宿主双轨 |

## 三、总体架构

```
src/
├─ core/                      # 纯 TS 内核，零 cordis 依赖
│  ├─ imessage/               #   macOS 面：permissions / chatdb / decode / normalize / sender / humanize
│  ├─ routing/                #   大脑：gate（白名单+幂等）/ session-router / pipeline（单向流）
│  ├─ stores/                 #   state（原子写）
│  ├─ i18n/  log/  types.ts
└─ host/                      # 薄 cordis 适配层
   ├─ index.ts                #   name / inject / apply：生命周期装配 + Config schema 声明（D9）
   ├─ dsh-port.ts             #   apiProxy → core 的 DshPort 实现
   └─ rpc/ settings/          #   管理面（M4 最小化起步）
```

- **内核数据流（单向）**：
  `Poller → Normalizer → Gate(白名单/幂等) → SessionRouter → DshPort.ask → Humanizer → Sender`
- **端口抽象**：core 定义 `DshPort` 接口（createSession / rename / ask / history），
  host 用 apiProxy 实现它，测试用 fake 实现——这是内核与框架隔离的唯一接缝，DSH rc 版接口漂移只波及 host。
- **macOS 依赖点全部可注入**（sqlite / osascript / sips / fs），CI 无 mac 也能全量单测。

## 四、里程碑（MVP = M1 → M4）

### M1 · 底座（拆为 7 步，每步 = 源文件 + 同构测试文件 + check 全绿）
- ① 仓库骨架：pnpm + tsconfig + vitest + lint；package.json 按 DSH bundle 规范预留（已完成）
- ② paths：数据根定案 `~/.dsh-imessage/`，`DSH_IMESSAGE_HOME` 可覆盖（已完成）
- ③ 类型：NormalizedMessage / AccessPolicy（含号码归一化）
- ④ 类型：ChannelState 形态 + Config 纯类型与默认值（业务配置校验在 M4 走 host 层 Schemastery schema，D9）
- ⑤ i18n（zh/en）
- ⑥ JSONL 结构化日志（sink 可注入）
- ⑦ 原子写工具 + state store（cursor / seenIds / sessions）
- **验收**：单测与构建全绿；数据根目录定案

### M2 · iMessage 收发内核（macOS 面）
- 权限探测（FDA + 自动化，含权限错误分类）
- chatdb：`node:sqlite` 只读打开、单查询 JOIN（消息/附件/引用）、typedstream(attributedBody) 解码
- normalize：防循环（from-me / bot 前缀 / group / 空消息）、引用回复归一化
- sender：osascript sendText、AppleScript 转义；humanize：语义分段 + 打字延迟
- **验收**：解码/归一化/分段 fixture 单测绿；提供 dev-only CLI 手工工具，真机收、发各通一条文本

### M3 · 内核接线（大脑）
- session-router：conversationKey → 隔离目录 → **预绑定事务**（create 前预绑定、成功后无条件重申、per-key 串行锁；吸收 dsh-im 孤儿会话教训，砍掉其 fence/多 bot 复杂度）
- 绑定模型：手机号 → **单活跃会话 + 固定工作区**（工作区跟手机号走、永不换；会话只是可替换的把手）；会话失效（删除/归档/DSH 重装）采用**懒验证**：下次来消息时验证 sessionId，死了重建新会话并换绑，工作区不动，不主动同步删除；**不按名复活**：用户恢复归档旧会话后与重建的新会话并存，绑定保持新会话不回跳（定案）；DSH 会话记忆与工作区文件是两条独立的记忆线，切换绑定只动 sessionId
- **会话所有权隔离**：DSH 会话是全局列表、无归属概念，插件自记账：sessions 含 `bindHistory`（该手机号绑定过的全部会话，**append 前判重**——同 id 只记一次、保持首绑顺序；归档/删除记录保留在案）；`/sessions` 只列发起者台账内的**活跃会话**（显示前过滤：已归档、已删除不显示），`/bind` 只允许绑活跃会话，拒绝已归档/已删除目标（默认拒绝，与 D8 同源）；会话命名约定 `imessage <phone>` 仅作可读辅助，不作安全边界；DSH 侧手动建的会话不在任何台账、不可被 bind（SessionId 为不透明 branded string，DSH 允许调用方自带 id，唯一性由生成方保证——去重只需判存在，与格式无关）
- **懒验证三态**（归档≠删除，DSH 事实：archived-session-gate 冻结模型步骤但会话可查，unarchiveSession API 存在，官方复用逻辑也排除归档）：当前绑定会话为「活跃→正常路由；归档→自动新建+告知（手机端用户无法去 DSH 恢复）；删除→自动新建」；`DshPort` 需提供 `getSessionStatus(id): active|archived|missing`（M4 用 workspaceRegistry.archivedSessionIds 实现）
- gate：白名单评估 + 幂等（含"失败不吞消息"的 unmark 语义）
- pipeline：组装单向流；轮询调度、abort、单条消息失败不中断循环
- **验收**：fake DshPort 的内核集成测试全链路绿；崩溃/重启恢复测试（不丢、不重）

### M4 · 插件宿主 → **MVP 完成**
- host/cordis：apply() 生命周期；DshPort 的 apiProxy 适配（session.create/rename/history/ask 流式回复）
- 最小管理 RPC（连接/权限状态，供设置页用）
- pnpm link 进 desktop profile 真机联调
- **验收**：desktop 内安装后，白名单手机号一问一答稳定；连续运行 24h；重启不丢不重
- **切换流程**：上线前先停 dsh-im 的 iMessage bot（避免双端抢消息），白名单手动迁移

### M5+ · 迭代池（顺序到时排）
- P1：收图（HEIC→JPEG via sips）、引用回复注入 prompt、发文件（macOS 26 `send POSIX file`）、`/help` `/new` `/sessions` `/bind` 命令（`/sessions` 只列发起者 bindHistory 内的会话、`/bind` 只能切到台账内目标；切换手机号绑定的 DSH 会话，记忆跟会话走、工作区不变）、联系人备注上下文、会话标题
- P2：companion（scheduler / motives / mood / controller，状态持久化）、表情包上下文、设置页 UI（权限引导 / 白名单 / 参数表单热更新 / **会话绑定可视化切换**）、模型选择

## 五、测试与质量策略

- core 全层单测；macOS 依赖全部注入 fake，CI（linux）可跑
- 真机手工验收 checklist 随 M2/M4 维护在 `docs/`
- 每个里程碑收口 = 测试绿 + 验收项过 + 无 TODO 悬挂

## 六、风险与预置对策

| 风险 | 对策 |
| --- | --- |
| chat.db schema 随 macOS 升级变动 | 查询集中在 chatdb 一个模块；启动做 schema 探测，失败明确报错不静默 |
| 「插件继承 desktop 权限」假设不成立 | M4 联调第一时间验证；不成立则引导用户对 DeepSeek Harness.app 补授权 |
| DSH rc 版 apiProxy 接口漂移 | 已收口在 DshPort，只改 host |
| 与 dsh-im iMessage bot 并行抢消息 | 切换流程写入 M4 验收；数据根完全独立 |
| attributedBody 变体解码失败 | fixture 驱动；解码失败降级为占位文本，不丢消息 |

## 七、参考资料

- DSH 源码（本机）：`/Users/chenyaqi/Documents/github-projects/deepseek-harness-master`
  - 插件教程：`docs/user/develop/{basic,framework,practice}`
- dsh-im 参考实现（事实来源）：`/Users/chenyaqi/Documents/code/dsh-im`
  - 渠道层：`src/channels/imessage/`；绑定事务：`src/channels/shared/workspace-session.mjs`
- 本仓 `ARCHITECTURE.md`：dsh-im iMessage 渠道完整解构
