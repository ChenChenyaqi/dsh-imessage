# 会话路由与消息管线（M3）· 设计定案（代码反写）

> 需求：把 M1 底座与 M2 收发内核接线成单向消息管线——耳朵（fetch/normalize）
> → 门卫（gate）→ 管理员（session-router）→ 大脑（DshPort.ask 流式）→ 嘴巴
> （humanize/sender），在 state.json 台账上兑现「不重为硬保证、不丢让位于
> 防重复」。本文按代码与镜像测试反写沉淀定案（二者是唯一事实标准，修订本文
> 必须同步改码改测）。里程碑总纲见 `../PLAN.md` M3 节。

## 模块与职责

| 模块 | 职责 |
| --- | --- |
| `src/core/router/session-router.ts` | 绑定管理员：懒验证换绑 + 预绑定事务 + per-key 串行锁 |
| `src/core/router/gate.ts` | 准入门卫：白名单评估 + seenIds 幂等台账（全纯函数，永不抛错） |
| `src/core/router/pipeline.ts` | 总装：轮询调度、单条状态机、失败分层、崩溃语义 |
| `src/core/stores/atomic.ts` `state-store.ts` | state.json 原子读写与损坏恢复 |
| `src/core/types/state.ts` | ChannelState 契约（cursor/seenIds/sessions）+ recordBinding 等纯函数 |
| `src/core/types/dsh.ts` | DshPort 契约（createSession / getSessionStatus / ask 流），M3 用 fake 驱动、M4 接真货 |

## 1. 预绑定事务（防孤儿会话；吸收 dsh-im 重复建会话教训，砍掉 fence/多 bot 复杂度）

`createAndBind`（per-key 锁内）三步：

1. **create 前预绑定**：锁内读最新 state，工作区取 `existing.workspaceDir ??
   deriveWorkspaceDir(key)`——会话未建、工作区已定；
2. `port.createSession({ workspaceDir, name: 'imessage <key>', preset? })`
   （SessionId 为不透明 branded 令牌，id 生成权归 port）；
3. **create 成功后无条件重申**：`saveState(recordBinding(loadState(), ...))`——
   以最新 state 为底重写指针、幂等记账，落盘后才返回使用。

- **落盘失败 = 孤儿会话，无害**（定案）：DSH 侧多一个无人绑定的空会话，
  记 `router.orphan-session` 警告后继续用新会话答复（失败不吞消息），
  重启后懒验证自然重建绑定。
- **per-key 串行锁 `makeKeyedLock`**：同 key 排队——后到者看到先到者刚落的
  绑定，不重复建会话；异 key 并行；前序失败不卡锁（`prev.then(fn, fn)`）；
  空锁即清理防泄漏；create 失败照常抛出，锁为后续调用存活。

## 2. 绑定模型：单活跃会话 + 固定工作区

- 手机号（归一化 conversationKey）→ **单活跃 sessionId + 固定 workspaceDir**。
  工作区 = 相对数据根 `conversations/<safe-key>`（非法字符替换 `_`，搬数据根
  不失效），首次派生后随绑定永存——**工作区跟手机号走、永不换；会话只是
  可替换的把手**（DSH 会话记忆与工作区文件是两条独立记忆线）。
- **懒验证三态**（来消息时才 `getSessionStatus`，不主动同步）：
  - `active` → 直接复用（`reused`，不建）；
  - `archived` → 自动新建 + 系统路径告知手机端（`rebind-archived`，手机端
    用户无法去 DSH 恢复）；告知失败按 pre-ask 处理，重试不再补告知；
  - `missing`（删除/DSH 重装）→ 自动新建，静默（`rebind-missing`）；
  - 无绑定 → 首次新建（`fresh`）。
- **不按名复活**（定案）：只认 sessionId 台账，从不按会话名搜索；归档旧会话
  即便被 DSH 侧手动恢复，绑定保持新会话不回跳。
- **所有权台账**：DSH 会话全局无归属，插件自记账
  `SessionBinding = { sessionId, workspaceDir, bindHistory }`；bindHistory
  **append 前判重**（查重后 append，只增不删、保持首绑顺序），状态恢复重绑
  同一 id 不重复记账。
- 会话名 `imessage <key>` 仅可读辅助，非安全边界；preset 用时读（热更只对
  新建会话生效，空 = 宿主默认）。

## 3. gate：白名单 + 幂等（claim/unmark 语义）

- 两道检查**顺序即语义**：先查重（seenIds 含 guid → `already-seen`，绝对事实，
  不受白名单增删影响）；后白名单（复用 M1 `evaluateAccess`；`unparseable-key`
  仅防御）。
- `markSeen`（claim）：guid 置顶，超环形容量 `SEEN_IDS_MAX=500` 淘汰尾部，
  重复认领幂等——环形窗口只需覆盖「cursor 不推进期间可能重复出现」的场景。
- `unmarkSeen`（ask 失败恢复重试）：按 guid 移除，不在场幂等（原引用返回）。
- **白名单拒绝不 mark**：cursor 已推进不会再拉到，不占 seenIds 容量。
- 调用时序与落盘节奏全归 pipeline，gate 只出纯函数。

## 4. pipeline：单向流、失败分层、重试预算

- 单向流：fetch → normalize → gate → route → ask（流式收集，记 firstDeltaMs）
  → sendHumanized → cursor 推进落盘。**单条消息失败不中断轮询循环**（就地消化）。
- 失败分层（定案：**send 失败不重试、不重复回复**）：
  - **pre-ask 失败**（route/告知/ask 流，`asked=false`）：unmarkSeen 落盘 +
    cursor 不动 → 下轮重拉重试（零副作用失败才配重试）；同时**中断本批**——
    同批后继行不能把 cursor 带过去，否则这条永远拉不到；
  - **send 阶段失败**（`asked=true`）：保持 claim + cursor 推进 = 终态吞
    （`send-failed` 留痕，绝不重发）；
  - **权限停机**：`SendError(automation-permission)` → 状态收干净后返回
    `permission-stopped`（重试只会刷屏 -1743，停轮询等人工）。
- **ask 重试预算（定案 B+）**：`MAX_ASK_RETRIES=3`（首答 + 2 重试）；3 连败 →
  吞（保持 claim + cursor 推进，本批继续不堵塞）+ best-effort 系统告知
  （告知失败不翻案仅留痕；命中权限错误则停机）；成功即清计数。retryCounts
  **内存态、重启清零**（干预后重启 = 再给满额机会）。
- cursor 语义（沿 M2）：`cursor=null` 首启取当前 MAX(ROWID) 落盘，不回放历史；
  normalize skipped 行只推内存 cursor（搭车下一条/batch 尾落盘，崩溃重拉
  幂等再滤）；claim 时 cursor 停在当前位不动（保留重拉窗口）。
- 轮询与退避：`intervalMs` 起步（默认 2s），fetch 抛错逐次翻倍至 `maxBackoffMs`
  （默认 60s）；拉到（哪怕空批）即清零失败计数，非空批重置退避；连续
  `MAX_FETCH_FAILURES=10` → `fetch-exhausted`（读通道真死，交宿主层）；
  空批 sleep 且**不打点**（防 2s 心跳刷爆日志）。
- 热更：policy/文案/回复风格不解构定格、用时读 deps（通道热更换白名单/语言
  立即生效）；日志永不记正文，只记 `chars`。

## 5. 崩溃语义：at-most-once（防重复 > 防丢）

- **claim 先落盘**（markSeen + cursor 不动）：崩溃窗口内可能吞一条——重启重拉
  遇 `already-seen` → cursor 补推进即完成（**绝不重复回复**）；用户重发成本低
  即愈，重复回复伤信任。
- 崩溃恢复矩阵（测试固化）：reply 发出后崩溃不重答；分段发送中途崩溃不续发；
  claim 后 ask 前崩溃恰好吞一次且台账一致；batch 尾落盘前崩溃 skipped 行
  幂等再滤。

## stores 配合：state.json 的原子性与损坏恢复

- `atomic.ts`：同目录 tmp + rename（POSIX 原子）——崩溃时文件要么旧要么新，
  永无半截 JSON；损坏读抛 `JsonCorruptError`。
- `state-store.ts`：损坏/形状不符/版本不识 → 坏文件留档改名（`.corrupt-<ts>`，
  供人工排查）+ 返回初始状态（可用性优先）；代价受控——cursor 归 null 从当前
  水位起步（不回放历史、不重复回复），sessions 丢失仅触发绑定重建（DSH 会话
  与工作区文件都在磁盘上）。

## 实施路线（全部完成，代码即事实）

- [x] state 契约与纯函数（`types/state.ts`：ChannelState / recordBinding /
  deriveWorkspaceDir / 形状守卫 + STATE_VERSION）
- [x] gate 评估与台账（`tests/core/router/gate.test.ts`）
- [x] session-router 懒验证 + 预绑定事务 + per-key 锁
  （`tests/core/router/session-router.test.ts`）
- [x] pipeline 总装：轮询/状态机/重试预算/退避/热更 + 崩溃恢复矩阵
  （`tests/core/router/pipeline.test.ts`）
- [x] stores 原子写与留档重置（`tests/core/stores/`）

## 验收标准

- [x] fake DshPort 的内核集成测试全链路绿；崩溃/重启恢复测试（不重为硬保证，
  不丢在 at-most-once 窗口内让位于防重复）——2026-11 完成，**224 测试全绿**
  （DshPort 契约 + fake、session-router、gate、pipeline、崩溃恢复矩阵）；
  仓库测试规模已随 M4+ 增长，`pnpm test` 持续全绿。
