# M2 · iMessage 收发内核（macOS 面）

> 需求：读 `chat.db` 收消息、osascript 发消息的纯内核层。本文按代码反写
> （代码为唯一事实标准），沉淀设计定案供后续改动对照，过程记录不在此。

## 范围

`src/core/imessage/` 六个模块 + dev-only CLI（`scripts/dev-cli.mjs`，不进 npm 包）：

| 模块 | 职责 |
| --- | --- |
| `env.ts` | 环境与权限探测（FDA + 自动化），错误分类 |
| `chatdb.ts` | `node:sqlite` 只读访问：schema 探测、水位、增量拉取 |
| `typedstream.ts` | attributedBody（typedstream 归档）正文提取 |
| `normalize.ts` | 原始行 → NormalizedMessage：策略过滤 + 双源文本合并 |
| `sender.ts` | osascript 发送：AppleScript 转义、错误分类、双路径入口 |
| `humanize.ts` | AI 回复拟人化编排：语义分段 + 打字延迟 |

## 设计定案（均已代码落地）

### 双路径发送（PLAN 定案）

- AI 路径 `sendText`：原样发送，分段与延迟由 `sendHumanized` 编排。
  pipeline 只调 `sendHumanized`，风格可配置（`ReplyStyle`：分段开关 /
  最大分段数 / 延时系数，默认 `LEGACY_STYLE` = 分段、不封顶、原速）。
- system 路径 `sendSystem`：无延迟、一次发出、自动加 `[dsh] ` 前缀。
  前缀常量 `DSH_PREFIX` 与 normalize 的回环过滤共用（单一事实来源）。
  消费方是 pipeline 的 i18n 系统词条（会话切换告知、回复不可用告知）。

### macOS 依赖全部可注入（CI/Linux 可跑）

- `env.ts`：`ProbeDeps`（statFile / readFileHead / runAppleScript）。
- `sender.ts`：`SenderDeps.runOsascript`（默认 `node:child_process`）。
- `humanize.ts`：sleep 与随机源均可注入（测试假钟 + 固定随机）。
- `chatdb.ts` 直用 `node:sqlite`，测试以内存库构造 schema。
- core 层无真 IO；真 IO 默认实现仅供 dev CLI / 组装层使用。

### 解码失败降级占位，绝不丢消息

- typedstream 任何环节失败（无类名 / 无标签 / 长度越界 / 坏 UTF-8）
  返回 null，由 normalize 降级为占位文本：
  - 解码成功但剥 U+FFFC 后为空（纯附件）→ `[attachment: image, not yet supported]`
  - 解码失败 → `[undecodable message]`
- 占位是协议标记（故意英文，不走 i18n），AI 理解后自行本地化转述。
- normalize 输出两态 accepted / skipped（带 reason），本层不抛错——
  单条坏消息不阻塞管道。

### chatdb 实测定案

- readonly 打开即可读到 WAL 最新数据，无需复制库。
- `date` 是 Mac absolute 纳秒（18 位，超 JS 安全整数）：SQL 层
  `CAST AS TEXT` 带出十进制字符串，消费侧 BigInt 精确转换；
  浮点除法方案实测丢精度，已否决。
- 群聊判定用 `chat_handle_join` 成员数（>1 即群），不依赖 `chat.style`
  枚举语义（无文档）。
- 单查询 JOIN：消息 + chat + handle + 成员数 + 附件 + 引用原消息一条
  SQL 拉全；多附件展开多行，normalize 按 guid 合并（首行为主体）。
- schema 探测：依赖表列缺失（macOS 大版本升级改表）抛
  `ChatDbSchemaError` 明确报错，不静默。
- 拉取只下沉静态条件（`is_from_me=0`、`ROWID > 水位`、LIMIT 升序）；
  策略性过滤全在 normalize 层，poller/gate 保持纯粹。

### normalize：防循环与跳过语义

- 跳过原因枚举：`from-me`（SQL 已滤，防御性再滤）/ `bot-prefix`
  （`[dsh]` 回环）/ `group-chat`（MVP 只做单聊）/ `no-handle`（系统事件）/
  `invalid-handle`（手机号归一化失败，默认拒绝）/ `empty`（无文本也无
  BLOB，tapback 等）。
- 双源文本合并：`text` 列优先，空则 typedstream 解码 attributedBody
  （macOS 26 起正文基本只在 BLOB）；皆空才 skip。
- conversationKey = `normalizePhone(handleText)`；date 经 BigInt 通道
  转 epoch 毫秒；输出按 rowid 升序，不依赖上游排序约定。

### sender 实测定案（osascript）

- AppleScript 字符串字面量只转义实测验证过的形式（`\\ \" \n \t`，
  JSON.stringify 子集）；不认 `\uXXXX`——其余控制字符防御性替换为空格。
- service 定位用 `every service whose service type = iMessage` 取第一个，
  不依赖 service 名。
- 错误分类三态：`automation-permission`（stderr -1743 / not authorized）/
  `no-imessage-service` / `send-failed`（其余，网络/账号等）。
- 入参校验前置：地址非空、无换行、≤512；文本 trim 后非空。

### humanize：分段哲学与节奏（参数来自 dsh-im 实测，冻结防漂移）

- 一行 = 一条气泡；空行丢弃；``` 代码块围栏整体保留永不切断；
  分段数封顶时超出部分换行并入末段（内容不丢）。
- 每段前都等待（含末段）：首段 600–1800ms「思考」；段间 250ms 基础 +
  4 字/秒打字时间；±25% 抖动后夹逼 [250ms, 5000ms]；代码块按「粘贴」
  300–800ms 平坦延迟。
- 延时系数先乘再夹回上限（clamp 只在乘之前会让大系数把单段等待放大到
  上限的 N 倍，真机踩过：系数 5 → 25s）；系数 0 = 分段但不等待。
- abort 信号贯穿等待与发送；发送失败直接上抛（已发出的段无法撤回，
  重试/放弃策略归 M3 pipeline）。

### env：权限探测

- 两项独立探测、不短路（设置页一次显示所有缺口）：disk（FDA，读
  chat.db 的前提）+ automation（osascript 的前提）；探测命令
  `get name`——不登录、不建会话、不发送。
- chat.db 不存在归入 disk 失败，detail 区分「文件不存在」与「无权读取」。
- 权限主体（TCC 责任进程）随宿主形态漂移（终端 / desktop 插件进程），
  探测结果只代表当前宿主环境的实际能力。

## 验收状态

- [x] 解码 / 归一化 / 分段单测绿（`tests/core/imessage/` 镜像六模块，
  typedstream 用合成 BLOB fixture 覆盖长度的全部编码分支）
- [x] macOS 依赖全部注入 fake，CI（linux）可跑全分支
- [x] dev-only CLI 手工工具（probe / peek / send [--system] / listen），
  真机收、发各通一条文本
