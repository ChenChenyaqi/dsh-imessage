# 仓库底座（foundation）· 需求实施方案

> 需求：为插件内核打底——数据根与约定路径、纯类型契约、iMessage 回复
> 文案 i18n、结构化 JSONL 日志、原子写 state store。core 层零真 IO，
> CI/Linux 可全量单测。

## 模块地图

| 文件 | 职责 |
| --- | --- |
| `src/core/paths.ts` | 数据根解析与全部约定路径：`resolvePaths(env)` 一次解析成 `Paths` 快照（root / stateFile / logDir / conversationsDir），`DSH_IMESSAGE_HOME` 可覆盖 |
| `src/core/types/phone.ts` | handle 归一化 `normalizePhone`：带 `+` 的 E.164（7..15 位）或 Apple ID 邮箱小写 → conversationKey；裸号不猜区号返 null |
| `src/core/types/policy.ts` | 白名单准入（D8 默认拒绝）：`makePolicy` 构造（非法条目静默丢弃）、`evaluateAccess` 永不抛错、结论带 reason |
| `src/core/types/messages.ts` | `NormalizedMessage` 内核标准消息形态 + 形状守卫 `isNormalizedMessage` + fail-loudly 工厂 `makeNormalizedMessage` |
| `src/core/types/state.ts` | `ChannelState` 契约（version / cursor / seenIds / sessions）+ 纯函数更新（`recordBinding` / `deriveWorkspaceDir`）与形状守卫 |
| `src/core/types/config.ts` | `PluginConfig` 纯类型与 `DEFAULT_CONFIG`；校验走 host 层 Schemastery schema（D9），本文件不重复校验 |
| `src/core/types/dsh.ts` | `DshPort` 接口契约：`SessionId`（branded 不透明令牌）、createSession / getSessionStatus / ask 流式——接口在底座定义，真实现 M4 在 host 层 |
| `src/core/i18n/index.ts` | zh/en 词条表（扁平 key，D6）+ `makeT`：`{placeholder}` 插值、漏译回退另一语言、双缺返回 key 本身 |
| `src/core/log/jsonl.ts` | `makeLogger`（sink 注入、minLevel、写入永不抛错）+ `makeFileSink`（按天滚动 + 惰性清理的文件 sink） |
| `src/core/stores/atomic.ts` | JSON 原子读写机制：tmp + rename 落位；`readJson`（ENOENT → undefined，解析失败抛 `JsonCorruptError`） |
| `src/core/stores/state-store.ts` | state.json 业务策略：`loadState`（损坏 / 版本不符 → 留档重置）、`saveState`（原子写） |
| `tests/core/**` | 镜像单测：paths、types 五件、i18n、log/jsonl、stores/atomic、stores/state-store |

## 关键设计定案

- **数据根独立（D5）**：一切持久化挂 `~/.dsh-imessage/` 一个根下
  （state.json / logs/ / conversations/），绝不碰 dsh-im 的目录
  （`~/.dsh/im`、`~/.dsh/integrations`）——检查 / 备份 / 卸载只处理一个
  目录。业务配置不入数据根：走 DSH Config schema 存 profile（D9）。
- **数据根可覆盖**：`DSH_IMESSAGE_HOME` 供测试与自定义安装；值支持
  `~/` 前缀展开（拼真实 home）与相对路径（按 cwd resolve）。env 以
  `PathEnv` 切片注入，不直接依赖 `process.env`。
- **原子写**：同目录 tmp 文件（随机 UUID 后缀，保证与目标同文件系统，
  rename 原子的前提）→ `rename` 落位——崩溃时目标要么旧内容要么新内容，
  永无半截 JSON；rename 失败删 tmp 再抛。机制归 `atomic.ts`，「损坏后
  怎么办」的策略归 `state-store.ts`，分层不混。
- **state.json 损坏恢复（可用性优先）**：损坏 / 形状不符 / version 不符
  → 坏文件改名 `.corrupt-<时间戳>` 留档供人工排查，返回初始状态。代价：
  cursor 归 null 从当前水位重新起步（不回放历史、不重复回复）；sessions
  丢失靠 DSH 会话与磁盘上的工作区目录重建绑定。`STATE_VERSION` 是未来
  schema 迁移的挂点。
- **ChannelState 三职责**：cursor = 增量轮询水位（不丢；null = 首启取
  当前 MAX(ROWID)，不回放历史）；seenIds = 已处理 guid 环形去重（不重；
  `SEEN_IDS_MAX = 500`，旧消息反正被 cursor 挡住）；sessions = 每手机号
  会话绑定 + `bindHistory` 所有权台账（M3 路由消费）。
- **日志 sink 注入（D2）**：`makeLogger` 不碰文件系统，生产由组装层注入
  `makeFileSink(paths.logDir)`，测试注内存数组。日志写入**永不抛错**：
  序列化失败降级写一行 `log.serialize-failed`，sink 故障（如磁盘满）吞掉
  ——日志问题不能影响消息管道；仅事件名非法当场 TypeError（程序员错误
  尽早暴露）。`minLevel` 默认 info，`now` 可注入。
- **日志按天滚动、保留 7 天**：文件名 `imessage-YYYYMMDD.jsonl`，按本地
  时区切「一天」；`keepDays` 默认 7 可调。无定时器无后台任务——仅 sink
  创建与跨天切换时惰性清理；不匹配文件名模式的文件一律不动（保守）。
- **i18n 边界（D6）**：只覆盖发给用户的 **iMessage 回复文案**；Error 与
  日志一律英文、不走 i18n（架构边界，非语言偏好）。词条扁平 key，zh/en
  成对添加；漏译回退另一语言、两边都缺返回 key 本身（可见、可搜索、不炸）。
- **conversationKey 唯一键纪律**：归一化是白名单与会话路由的共同前提——
  E.164 总位数 7..15（ITU 上限 15、惯例下限 7，顺带拦 chat.db 实测的
  超长垃圾伪造号）；邮箱小写；裸号码不猜国家码一律 null（默认拒绝）。
  白名单空 = 全拒；非法条目静默丢弃（等价于不在名单）。
- **core 零真 IO**：数据库 / osascript / 文件系统依赖全部注入（env 切片、
  `LogSink`、路径解析后传入）；`makeFileSink` 是随 core 提供的生产 sink
  实现，由组装层选用，不破坏内核的可测性。

## 验收状态

- [x] M1 完成（2026-11 前）：上表模块全部落地；`tests/core/` 镜像单测
  （paths / types 六件 / i18n / log / atomic / state-store）与构建全绿；
  数据根 `~/.dsh-imessage` 定案。M2+ 各需求在此底座上叠加。
