# M6.1 收图 · 设计与实施方案

> 状态：已拍板（2026-11-21，4 分叉均按推荐执行）。探针事实依据见同目录
> `probes.md`（① chat.db 附件准入、② DSH 图片内容块）。范围仅**接收侧**；
> 发图/发文件是 M6.2，开工时另立文档。分步交付惯例：每步 = 源文件 +
> 镜像测试 + `pnpm check` 全绿即停。

## 数据流（变更后）

```
chatdb ──附件准入 SQL──▶ normalize ──折叠+纯图接入──▶ gate（不变）──▶ router（不变）
  ──▶ pipeline ──media.load（读文件+HEIC→JPEG）──▶ DshPort.ask(prompt: AskPart[])
  ──▶ host dsh-port ──attachments.saveImages──▶ ref 块进 followup
```

读文件/转码**不进 normalize**（保持纯数据转换、零 IO）；media 加载在
pipeline 的 ask 前一步，deps 注入（同 `preset()` 用时读模式）。

## 设计要点

- **图片级失败不阻塞**：单图读失败/转码失败/DSH 校验失败都只剔该图 + 留痕，
  文本照发；全失败且无文本 → 占位文本兜底，避免空 prompt 吞消息
  （at-most-once 语义下整条失败 = 吞消息，代价过高）
- **不注入标注与文件清单**（probes ②，dsh-im ce9d0a52 定案）：图片只以
  内容块进 ask
- **DshPort 仍是唯一接缝**：core 用自有 AskPart 结构（bytes 形态），
  host 负责映射为 DSH 的 ImageAttachmentRef 块
- **中转拷贝转码**：sips 只碰 tmpdir 中自有的中间文件（input/output），
  不直接读写 Messages 源路径——行为与 dsh-im 已验证实现一致；
  中间文件 finally 删（转码是进程内临时物，与 M6.2 外发暂存的
  1h 纪律是两回事，不要混淆）

## 变更清单

### core（5 处）

| 文件 | 变更 |
| --- | --- |
| `imessage/chatdb.ts` | ① 附件 JOIN 的 **ON 子句**加准入（放 ON 不放 WHERE：未完成附件只置空附件字段、不吞整条消息）`AND a.is_sticker = 0 AND a.transfer_state = 5 AND a.filename IS NOT NULL`；② SELECT 增 `transfer_name AS attachmentName`、`total_bytes AS attachmentBytes`；③ WHERE 增纯图分支 `OR (a.filename IS NOT NULL AND a.mime_type LIKE 'image/%')` |
| `types/messages.ts` | 新 `MessageAttachment = {path; mediaType; name: string\|null; bytes: number\|null}`（path 保持 `~/` 原始形态，展开是 media 职责）；`NormalizedMessage` 增**可选** `attachments?`（旧 fixture 零改动） |
| `imessage/normalize.ts` | ① `normalizeRows` 折叠升级：同 guid 各行的附件收集去重（现状只留首行字段）；② 纯附件分支改造：有 image 附件 → `text = ''` accepted（替换现 `[attachment: image, not yet supported]` 占位符）；无附件且双源空 → 维持 skip `empty` |
| `imessage/media.ts`（新） | `loadImages(atts, deps)`：expandHome → 读源 bytes → HEIC 集写 tmpdir 中间 `.heic` → `/usr/bin/sips -s format jpeg <in> --out <out>` → 读回 → finally 删中间文件；name/mediaType 同步 `.jpg`/`image/jpeg`。deps 全注入（readFile/writeFile/execFile/tmpdir/homedir，CI fake）。返回 `{loaded, skipped}`——非 image / 失败结构化上报 |
| `types/dsh.ts` + `router/pipeline.ts` | `AskPart = {type:'text';text} \| {type:'image';bytes;mediaType;name?}`；`AskInput.prompt: string \| readonly AskPart[]`（联合——系统路径/现有调用零改动）。pipeline deps 增可选 `media`：ask 前组装 blocks（文本块 + 图片块）；media 缺省或图片失败 → 该图剔除 + log；全失败且 text 空 → 退化为 `[图片]` 占位文本 |

### host（2 处）

| 文件 | 变更 |
| --- | --- |
| `channel.ts` | deps 增 `media: {load: loadImages}`（nodeDeps 真实现） |
| `dsh-port.ts` | ask 增 blocks 分支：image 块 → `attachments.saveImages([{data, mediaType, name}])` → ref 块保序混入 followup content。**服务缺失（老宿主）或单图校验失败 → 该图剔除 + warn**（图片是增强不阻塞文本，通道可用性优先）；string prompt 直通不变 |

## 日志

- 新事件 `pipeline.media-loaded`（**仅有附件的消息打点**，空批不打点原则不变）：
  `loaded` / `failed` 数、`skipReasons` 分布、总 bytes——正文与图片内容
  永不入日志（纪律不变）

## 分步交付

- **Step A · 读侧元数据**：chatdb 准入 SQL + 新列 + normalize 折叠/纯图 +
  类型 + fixture（transfer_state 矩阵 0/5/6、sticker、无 filename、
  非 image mime、多附件、纯图）
- **Step B · media 模块**：`media.ts` + fake deps 测试（sips 参数、
  `.jpg` 命名、finally 清理含失败路径、跳过矩阵）
- **Step C · 贯通**：AskPart + pipeline 组装（fake port 断言 blocks）+
  dsh-port 映射（fake attachments：入参/顺序/ref 块/降级）+
  `pnpm check` + 覆盖率 ≥93% 不降

## 待拍板分叉

| # | 分叉 | 推荐 | 理由 |
| --- | --- | --- | --- |
| 1 | `AskInput.prompt` 形态 | `string \| AskPart[]` 联合 | 系统路径零改动；host 一处 narrow |
| 2 | 图片级失败 | 静默跳过 + log；全失败文本兜底 | 整条失败会吞消息；图是增强非前提 |
| 3 | DSH 配额预检 | 不做本地预检，`saveImages` 报错按图剔除 | 避免双份配额逻辑漂移；DSH 是权威 |
| 4 | 纯图消息 text 块 | 不加 text 块（纯 image 块） | DSH validate 视附件为合法 content；加占位违背"不注入标注"定案 |

另见 `probes.md` 文末两个 M6 级分叉（非图片附件跳过 / hide_attachment
不过滤），同样影响本步实现。
