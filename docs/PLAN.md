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
| D5  | 数据完全独立：新根目录（含 per-conversation 工作区），不碰 `~/.dsh/integrations/` | 与 dsh-im 共存、切换互不污染；暂定 `~/.dsh/imessage/`，M1 定案 |
| D6  | i18n 保留：zh/en 起步，轻量 `t()` 层放 core | 用户要求 |
| D7  | 借用 dsh-im 验证过的 **macOS 事实**（chat.db SQL、typedstream 解码、绑定事务踩坑、osascript 用法），代码全部自研 | 这些是事实知识，不是代码 |
| D8  | 安全边界：chat.db 只读；发送只走 Messages.app 自动化；白名单默认拒绝 | 沿用 dsh-im 原则 |

## 三、总体架构

```
src/
├─ core/                      # 纯 TS 内核，零 cordis 依赖
│  ├─ imessage/               #   macOS 面：permissions / chatdb / decode / normalize / sender / humanize
│  ├─ routing/                #   大脑：gate（白名单+幂等）/ session-router / pipeline（单向流）
│  ├─ stores/                 #   config / state（原子写）
│  ├─ i18n/  log/  types.ts
└─ host/                      # 薄 cordis 适配层
   ├─ index.ts                #   name / inject / apply：生命周期装配
   ├─ dsh-port.ts             #   apiProxy → core 的 DshPort 实现
   └─ rpc/ settings/          #   管理面（M4 最小化起步）
```

- **内核数据流（单向）**：
  `Poller → Normalizer → Gate(白名单/幂等) → SessionRouter → DshPort.ask → Humanizer → Sender`
- **端口抽象**：core 定义 `DshPort` 接口（createSession / rename / ask / history），
  host 用 apiProxy 实现它，测试用 fake 实现——这是内核与框架隔离的唯一接缝，DSH rc 版接口漂移只波及 host。
- **macOS 依赖点全部可注入**（sqlite / osascript / sips / fs），CI 无 mac 也能全量单测。

## 四、里程碑（MVP = M1 → M4）

### M1 · 底座
- 仓库骨架：pnpm + tsconfig + vitest + lint；package.json 按 DSH bundle 规范预留
- core 类型系统（NormalizedMessage / AccessPolicy / ChannelState / Config）
- stores：state 原子写、cursor + seenIds + sessions；config 读取与校验
- i18n（zh/en）、JSONL 结构化日志
- **验收**：单测与构建全绿；数据根目录定案

### M2 · iMessage 收发内核（macOS 面）
- 权限探测（FDA + 自动化，含权限错误分类）
- chatdb：`node:sqlite` 只读打开、单查询 JOIN（消息/附件/引用）、typedstream(attributedBody) 解码
- normalize：防循环（from-me / bot 前缀 / group / 空消息）、引用回复归一化
- sender：osascript sendText、AppleScript 转义；humanize：语义分段 + 打字延迟
- **验收**：解码/归一化/分段 fixture 单测绿；提供 dev-only CLI 手工工具，真机收、发各通一条文本

### M3 · 内核接线（大脑）
- session-router：conversationKey → 隔离目录 → **预绑定事务**（create 前预绑定、成功后无条件重申、per-key 串行锁；吸收 dsh-im 孤儿会话教训，砍掉其 fence/多 bot 复杂度）
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
- P1：收图（HEIC→JPEG via sips）、引用回复注入 prompt、发文件（macOS 26 `send POSIX file`）、`/help` `/new` 命令、联系人备注上下文、会话标题
- P2：companion（scheduler / motives / mood / controller，状态持久化）、表情包上下文、设置页 UI（权限引导 / 白名单 / 参数表单热更新）、模型选择

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
