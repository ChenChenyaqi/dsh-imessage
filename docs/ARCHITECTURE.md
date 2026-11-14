# dsh-imessage · 架构蓝图

> 本文档是对 `dsh-im`（@xmanrui/dsh-im）中 iMessage 渠道的完整解构，作为本独立项目重写的蓝图。
> dsh-im 代码仓：https://github.com/xmanrui/dsh-im
> 范围：仅 iMessage 渠道。起点基线：commit `642ad21b`（移除消息机器人前缀）及之后的 34 个提交为本项目作者本人所加功能。

---

## 一、项目定位

把 macOS 原生 iMessage 接入 DSH（DeepSeek Harness）：

- **收**：只读轮询 `~/Library/Messages/chat.db`，支持文本、图片（HEIC 自动转 JPEG）、引用回复
- **发**：通过 `osascript` 控制 Messages.app，分段发送 + 拟人打字延迟，支持图片/文件
- **主动陪伴（companion）**：按昼夜节奏、动机、情绪主动发消息
- **多用户隔离**：每个手机号一个独立工作区 + 独立 DSH 会话，白名单控制准入

技术栈：**Electron（或 Node 服务）承担核心链路 + React/TS 管理面板**。
核心链路（读 chat.db、跑 osascript）只能跑在 Node/Electron 主进程，React 只做设置 UI。

---

## 二、总体架构（4 层）

```
┌─ 设置 UI（React + TS）──────────────────────────────────┐
│  权限检查卡片 / 机器人绑定 / companion 参数表单            │
├─ DSH Host 插件层（cordis 插件 / 独立进程对接）─────────────┤
│  管理 RPC（dsh-im 中为 /api/dsh-im/imessage）· 生命周期     │
├─ 渠道桥层（dsh-im 的 shared/，iMessage 实际用约 1/3）──────┤
│  会话绑定 · 工作区隔离 · 白名单 · 命令 · 上下文注入         │
├─ iMessage 渠道层（dsh-im 的 imessage/，共 2,080 行）──────┤
│  chat.db 轮询 · osascript 发送 · companion                │
└─ macOS 原生能力 ──────────────────────────────────────────┘
   ~/Library/Messages/chat.db（只读）+ Messages.app（AppleScript 自动化）
```

### macOS 权限（必须，无法静默授予）

1. **完全磁盘访问权限**：没有它读不了 `chat.db`
2. **自动化（控制 Messages.app）**：没有它发不了消息

设置页只能引导用户去系统设置开权限 + 轮询检查结果，不能代授权。

---

## 三、核心数据流

### 3.1 收消息（轮询）

```
每 2s:
  sqlite3 -json ~/Library/Messages/chat.db "
    SELECT m.ROWID, m.guid, m.text, …
    FROM message m
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    JOIN chat c ON c.ROWID = cmj.chat_id
    LEFT JOIN handle h ON h.ROWID = m.handle_id          -- 对方账号
    LEFT JOIN message q ON q.guid = m.thread_originator_guid  -- 引用的原消息
    LEFT JOIN handle qh / attachment qa …                -- 原消息的发送者/附件
    LEFT JOIN message_attachment_join maj / attachment a -- 本条附件
    WHERE m.ROWID > :cursor AND m.is_from_me = 0 …"
  → 更新游标（持久化）→ seenMessageIds 去重
  → 归一化 → 白名单校验 → 会话绑定 → 调 DSH
```

要点：

- **文本解码**：现代 iMessage 正文存 `attributedBody`（protobuf 流），需解出 `NSAttributedString` 字符串（`imessage-decode.mjs`，61 行）
- **附件**：`attachment` 表给路径，HEIC 用 `sips` 转 JPEG；引用消息的附件也要 JOIN 出来
- **防循环**：跳过 `is_from_me=1`（自聊场景下只处理投递回来的接收副本）+ 跳过带 `🤖 DSH` 前缀的机器人回复
- **游标 + seenMessageIds 双持久化**：重启不丢消息、不重复处理

### 3.2 发消息（拟人化）

```
模型回复文本
  → splitIMessageReplyParts()      # 语义分段（空行/句群切分，26 行）
  → 逐段 computeHumanTypingDelayMs()  # 按段长度的拟人打字延迟（41 行）
  → osascript -e 'tell application "Messages" to send …'
```

- 命令回执（/help 等的确认）走 `instant: true`：整段即发，不装人
- 图片/文件：macOS 26+ 的 AppleScript 支持附件发送；模型产出 artifact 文件后作为附件投递
- `lineSendIntervalMs = 0` 时关闭延迟（测试用）

### 3.3 主动消息（companion）

```
scheduler（何时）→ motives（为什么开口）→ mood（warmth 衰减）
  → DSH ask(sessionId, 动机 prompt) → deliver（复用分段+延迟发送）
```

状态（每对话的 warmth、计数器、pending 标记）持久化在渠道 state，重启后节奏不重置。

---

## 四、模块地图（重写时的搬运清单）

### 渠道层（dsh-im: src/channels/imessage/，2,080 行）

| 模块                 | 文件                       | 行数 | 归属          | 说明                                  |
| -------------------- | -------------------------- | ---- | ------------- | ------------------------------------- |
| 收发 API             | imessage-api.mjs           | 208  | 上游          | sqlite3 轮询 + osascript 发送         |
| AppleScript 工具     | osascript-helpers.mjs      | 32   | 上游          | 字符串转义/权限错误识别               |
| attributedBody 解码  | imessage-decode.mjs        | 61   | 上游          | protobuf 正文解码                     |
| 附件处理             | imessage-attachments.mjs   | 121  | **本人**      | HEIC→JPEG、图片源合并                 |
| 消息归一化           | imessage-normalize.mjs     | 125  | 上游+本人     | 含引用消息（thread 字段）             |
| 轮询 runtime         | runtime.mjs                | 323  | 上游+本人重构 | bot client（分段/延迟发送）+ 轮询循环 |
| **拟人分段**         | reply-splitting.mjs        | 26   | **本人**      | 353a17b9                              |
| **拟人延迟**         | typing-delays.mjs          | 41   | **本人**      | 810db43b                              |
| **companion 控制器** | companion-controller.mjs   | 319  | **本人**      | ac986877 等                           |
| **companion 节奏**   | companion-scheduler.mjs    | 219  | **本人**      | 日夜窗口/上限/静默                    |
| **companion 动机**   | companion-motives.mjs      | 146  | **本人**      | 9 种动机按 day phase 加权             |
| **companion 情绪**   | companion-mood.mjs         | 77   | **本人**      | warmth 衰减、间隔乘数                 |
| **表情包上下文**     | imessage-stickers.mjs      | 94   | **本人**      | c90abcda                              |
| **对方身份上下文**   | imessage-peer.mjs          | 104  | **本人**      | 7fe9f4be，contacts.json 备注          |
| 渠道日志             | channel-log.mjs            | 51   | **本人**      | 269fa94e，单文件全链路日志            |
| 出站 artifact        | outbound-artifacts.mjs     | 30   | **本人**      | 主动消息也能带文件                    |
| 配置/状态存储        | config-store / state-store | 42   | 上游          | bot 注册、会话绑定                    |
| 桥接                 | imessage-bridge.mjs        | 17   | 上游          | 复用 shared text-harness-bridge       |

### Host 插件层（dsh-im: plugin-src/host/channels/imessage/，163 行）

| 文件           | 行数 | 说明                                                                                                                                                                  |
| -------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| index.mjs      | 57   | cordis 插件入口：注入 connection/credentials/typertGateway                                                                                                            |
| rpc.mjs        | 93   | 管理 RPC：connection.status / bot.bind-native / permissions.status / bot.reconnect / bot.delete / workspace.set / model.set / access-policy.set / companion endpoints |
| production.mjs | 13   | 生产控制器装配                                                                                                                                                        |

### 桥层（dsh-im: src/channels/shared/，iMessage 用到的核心子集）

| 模块           | 文件                                | 行数   | 职责                                                  |
| -------------- | ----------------------------------- | ------ | ----------------------------------------------------- |
| 文本桥         | text-harness-bridge.mjs             | 2,478  | 消息队列、命令分发（/new /help /ws…）、流式回复       |
| 会话绑定       | workspace-session.mjs               | 266    | conversationKey→sessionId，绑定事务（见 §6.1）        |
| 绑定锁         | session-binding-lock.mjs            | 42     | 按 conversationKey 串行化绑定事务                     |
| 工作区存储     | bot-workspace-store.mjs             | ~2,400 | 每机器人工作区、per-conversation 隔离目录、fence 机制 |
| 隔离目录       | conversation-directory(-ensure).mjs | ~110   | 目录名 = hash(botIdentity+conversationKey)            |
| 白名单         | access-policy.mjs                   | ~150   | direct/group × open/allowlist                         |
| Harness 客户端 | harness-client.mjs                  | ~2,500 | DSH RPC：session.create / ask / workspace.list        |

---

## 五、功能全景（基线 642ad21b 之后的 34 个提交）

### 拟人化输出

- 语义分段发送（353a17b9）
- 按段长度打字延迟（810db43b）
- 命令回执一整段即发（47def401）
- /help 列出全部命令（eb657c57）

### 多媒体

- 接收图片 + HEIC 自动转 JPEG（5e6e1698）
- 图片消息只发内容块，不注入标注清单（ce9d0a52）
- 发送图片与文件到手机（c27b85ae）
- 接收引用回复（91501597）
- 引用消息带图（33466aac、95a571f0）

### companion 主动陪伴（最大功能块，12 个提交）

- 核心：动机/节奏/情绪/静默时段（ac986877）
- 强制唤醒绕过静默窗口（df8a26c3、0979ebeb、2b7b18c3）
- 主动消息可携带文件（ef0d2af6）
- `every` 区间硬上限（a47098a5）
- 斜杠命令不重置静默时钟（0e8b2969）
- 设置页热更新，无需重启（b6f29820、11299cb4、b3a032b1）

### 上下文增强

- 表情包清单注入 prompt（c90abcda）
- 告诉模型"她在跟谁说话"：peer 身份 + contacts.json 备注（7fe9f4be、f887339f）

### 安全

- 白名单锁定为显式 allowlist（bb96f094）
- 策略拒绝写日志不留静默（4b264fc4）

### 运维

- 全链路单文件日志 ~/.dsh/im/imessage-channel.log（269fa94e）
- schedule 提醒 relay 到绑定的私聊（0facfec5、d2132d01）
- API/runtime 模块化拆分（e0976f80）

### 上游基线（642ad21b 之前已有）

- chat.db 轮询 + osascript 发送 MVP、会话映射、设置页权限流程、token 机器人注册

---

## 六、必须保留的关键设计（踩过的坑）

### 6.1 会话绑定事务（孤儿会话 bug）

流程：

1. 先生成 plannedSessionId 并**预绑定**（prompt 组装需要看到绑定）
2. 调 `session.create`（带 sessionId）
3. **成功后无条件重申绑定**——因为首次派生隔离目录会在创建中途 clearSession，不重申会话就成了孤儿（后续消息又建第二个会话）

外加：

- 绑定操作按 conversationKey 加锁（串行化短事务）
- 创建失败时回滚到 previousSessionId
- 工作区切换 fence（generation 比对）：切换后旧会话不再接新 prompt

### 6.2 per-conversation 工作区隔离

- 每个新会话创建**前**，在基工作区下派生隔离目录
- 目录名 = `conv-` + conversationKey 可读化 + `hash(botIdentity + conversationKey)[:16]`
- **同一手机号不论多少个会话，永远同一个目录**（per-conversation 策略，与 sessionId/时间无关）
- 开启隔离后禁用 /ws、/conv 手动切换（防串目录）
- 目录创建失败自动回退基工作区并告警，不阻塞消息

### 6.3 白名单在最前面

- direct/group 两个 scope，各自 open/allowlist
- iMessage 用户标识 = E.164 手机号（如 +8613…）
- allowlist.users: [{id, canExecuteCommands}]
- 拒绝必须留日志（策略审计）

### 6.4 companion 状态持久化

- 每对话 entry：warmth/mood、计数器、pending
- 重启后节奏不重置；用户刚说话后进入 40–90 分钟静默

### 6.5 消息幂等

- 游标（message ROWID）+ seenMessageIds（guid）双保险
- 重启/崩溃后不丢消息、不重复处理

---

## 七、存储布局（参考 dsh-im，可沿用设计）

```
~/.dsh/
├── integrations/<本插件名>/          # ⚠️ 与 dsh-im 的 dsh-imessage 目录区分
│   ├── config.json                  # 机器人注册（botId/platformId/tokenRef/companion 参数）
│   ├── workspaces.json              # 工作区绑定 + accessPolicies(白名单) + 隔离目录记录
│   └── bots/<botId>/state.json      # 会话绑定 + 游标 + seenIds + companion 状态
├── im/                              # 默认基工作区
│   ├── conv-<手机号>-<hash>/        # 每人隔离目录（自动创建，0700）
│   ├── contacts.json                # peer 备注
│   ├── stickers/                    # 表情包目录
│   └── imessage-channel.log         # 渠道日志
└── sessions/<workspace转义>/session-<uuid>/
    └── session.v4.jsonl.zstd        # DSH 会话记录（DSH Host 管）
```

配置文件只在启动时读取，手改必须重启；运行中写回会覆盖未加载的手改。

---

## 八、新项目建议结构（Electron + React + TS）

```
dsh-imessage/
├─ electron/
│  ├─ main/
│  │  ├─ messagesApi.ts        # chat.db 轮询 + osascript 发送（核心）
│  │  ├─ decode/
│  │  │  ├─ attributedBody.ts  # protobuf 正文解码
│  │  │  └─ attachments.ts     # HEIC→JPEG、图片源
│  │  ├─ normalize.ts          # 消息归一化 + 引用 + 防循环
│  │  ├─ companion/
│  │  │  ├─ scheduler.ts       # 昼夜节奏/上限/静默
│  │  │  ├─ motives.ts         # 动机库（day phase 加权）
│  │  │  ├─ mood.ts            # warmth 衰减
│  │  │  └─ controller.ts      # 唤醒→ask→deliver
│  │  ├─ humanize.ts           # 分段 + 打字延迟
│  │  ├─ policy.ts             # 白名单（direct/group × open/allowlist）
│  │  ├─ sessions.ts           # conversationKey→sessionId + 绑定事务 + 隔离目录
│  │  ├─ stores/               # config / workspaces / state JSON 存储
│  │  ├─ dshClient.ts          # DSH Harness RPC 封装
│  │  └─ channelLog.ts
│  └─ preload.ts
├─ src/                         # React 设置面板
│  ├─ pages/
│  │  ├─ PermissionsCard.tsx   # 两项权限检查 + 引导
│  │  ├─ BotsCard.tsx          # 绑定/状态/工作区/模型
│  │  └─ CompanionCard.tsx     # 节奏参数表单（热更新）
│  └─ api/                      # IPC 封装
└─ shared/types.ts              # 前后端共享类型
```

### 实现顺序建议

1. `messagesApi`（收发 + 权限检查）→ 手工验证
2. `dshClient` + `sessions`（绑定 + 会话创建）→ 一问一答跑通
3. `policy`（白名单）+ `stores`
4. `humanize`（分段/延迟）
5. companion（scheduler → motives → mood → controller）
6. React 面板（权限 → 机器人 → companion）

---

## 九、安全边界（照抄 dsh-im 的原则）

- chat.db **只读**查询，绝不写入 Messages 数据库
- 发送只走 Messages.app 自动化接口
- 不上传数据库、不存 Apple ID 密码、不把本机授权信息发给前端
- chat.db 是 macOS 内部库而非公开 API，系统升级需跟进适配
