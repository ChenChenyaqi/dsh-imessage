# M6.0 探针结论 · 媒体收发事实清单

> M6 开工探针（PLAN.md M6.0），2026-11-20。
> 三条来源：① 本机真机 chat.db **只读**实测（仅查结构聚合，未取任何消息文本/号码）；
> ② dsh-im 提交 patch（ce9d0a52 / 5e6e1698 / 602ff8a6 / f636c845 / 91501597 / 33466aac / 95a571f0）；
> ③ DSH 源码（GitHub deepseek-ai/deepseek-harness + 本仓 `docs/host-integration/host-api/ask.md` + 本地类型包）。

## ① chat.db attachment 事实

本机聚合数据（72 附件 / 2491 消息）：

| 事实 | 实测值 |
| --- | --- |
| mime 分布 | png 25 / jpeg 18 / gif 15 / **heic 11** / mov 1 / docx 1 / null 1 |
| HEIC 标识 | mime `image/heic`，uti `public.heic` |
| transfer_state | **5 → 66（完成态常态）**、0 → 4、6 → 2 |
| 一消息多附件 | 64 消息 1 附件、2 消息 2 附件（JOIN 扇出，需折叠） |
| filename 形态 | `~/Library/Messages/Attachments/<xx>/<yy>/<file>`（波浪号需展开；本机未见百分号转义）；贴纸在 `~/Library/Messages/StickerCache/…`；另有 2 条 `/var/folders/…`（第三方 bot 暂存痕迹，见③） |
| is_sticker=1 | 4 条，全部位于 StickerCache |
| hide_attachment=1 | 21 条（dsh-im SQL 未过滤，见分叉②） |
| 引用回复 | `thread_originator_guid` 非空 4 条（文本 JOIN 我们 M2 已做） |
| 图片大小 | 954B – 4.6MB（均值 ~546KB） |

dsh-im 5e6e1698 的接入 SQL（照抄级事实）：

```sql
LEFT JOIN message_attachment_join maj ON maj.message_id = m.ROWID
LEFT JOIN attachment a ON a.ROWID = maj.attachment_id
  AND a.is_sticker = 0 AND a.transfer_state = 5 AND a.filename IS NOT NULL
WHERE … AND ((m.text IS NOT NULL AND m.text != '') OR m.attributedBody IS NOT NULL
  OR (a.filename IS NOT NULL AND a.mime_type LIKE 'image/%'))
```

**结论**：

- **完成态 = `transfer_state = 5`**（实测互证：66/72；0 = 摄取竞态卡死、6 = 不可读路径，均见③）
- 贴纸按 `is_sticker = 0` 排除；纯图消息（text / attributedBody 皆空）靠 WHERE 的 image 分支纳入
- 多附件 JOIN 行由 mergeAttachmentRows 折叠回单消息；附件行携带 `transfer_name`（展示名）/ `total_bytes`
- 非图片附件（mov / docx）被 `image/%` 条件天然排除

## ② DSH ask 图片内容块（A 面进程内）

我们 host 走 A 面（apiProxy → `agent.followup`）。源码级事实（`docs/host-integration/host-api/ask.md` + `packages/attachment/attachment/src/{types,index}.ts`）：

- `followup(message)` 的 `content: ContentBlock[]`：`{type:'text', text}` 可混排
  **`{type:'image', attachment: ImageAttachmentRef}`**
- **ImageAttachmentRef 不是 base64**：`{attachmentId（opaque）, mediaType, bytes, width, height, name?}`
  ——由附件服务签发（`AttachmentStore`，**cordis 服务名 `attachments`**，宿主内置）
- **插件侧获取路径**：注入 `attachments` 服务 →
  `saveImages([{data: Uint8Array, mediaType, name?}])` → `readonly ImageAttachmentRef[]`
  （先逐个 validate 再落存，保序返回）
- `mediaType` 仅收 `image/png | image/jpeg | image/webp | image/gif`——
  **`image/heic` 不在列：HEIC→JPEG 转码是必要步骤**（与 dsh-im 实践同向，多一层 DSH 侧理由）
- 默认配额（attachment-local `DEFAULT_*`）：单图 50MB / 每消息 20 张 / 每消息 200MB / 64M 像素 / 边长 65535px
- 文本模型自动降级：DSH 把图 offload 为稳定占位文本 + 只读路径（我们无需处理）
- 对比 B 面（API Remote）/ C 面（SDK）：wire 格式 `{type:'image', mediaType, data: base64}`，
  网关 `admitEncodedImages` 送入附件存储——dsh-im harness-client 走的这条；
  **插件走 A 面直接传 Uint8Array，省一轮 base64**
- dsh-im ce9d0a52 定案（语义照抄）：图片**只以内容块进 ask**，不注入逐图标注、
  不注入图片清单；伴随的非图片文件清单（`<dsh_im_files>` manifest）保留

## ③ 附件发送（osascript + 暂存纪律）

sendFile 语法（dsh-im f636c845 期 `imessage-api.mjs`，需 macOS 26 Tahoe）：

```applescript
tell application "Messages"
  set serviceList to every service whose service type = iMessage
  if (count of serviceList) is 0 then error "No iMessage service is available"
  set targetService to item 1 of serviceList
  set targetBuddy to buddy "<recipient>" of targetService
  send POSIX file "<绝对路径>" to targetBuddy
end tell
```

- macOS 26 起 `send` 命令原生支持 file 直接参数——附件与文本同一自动化通道，
  无需剪贴板/UI scripting；权限错误分类同 sendText（`-1743` / not authorized / assistive）

**暂存纪律**（602ff8a6 → f636c845 两次修复，终态）：

1. osascript send 返回 ≠ 已投递：Messages 的 helper daemon **异步**摄取/复制/上传附件；
   发完立即删暂存 → 大文件竞态丢失（`transfer_state=0` 卡死、无任何错误、手机收不到）
2. 暂存目录必须是 `os.tmpdir()`（`/var/folders`）：helper daemon 不读任意 home 路径
   （第一修用了 `~/.dsh` 下稳定目录 → `transfer_state=6` 永不投递——与本机实测
   2 条 `/var/folders` 附件、2 条 state=6 互证）
3. 终态方案：文件名 `<prefix>-${pid}-${ts}-${name}`、mode 0600、**保留 1 小时**；
   **下次发送时**按前缀 + mtime 清扫（无定时器）；清扫失败 cosmetic（仅日志，不阻塞发送）
4. 引用回复里的图引用 Messages 自己的副本展示（95a571f0），不二次暂存进工作区

## 结论映射（→ M6.1–M6.3）

| 探针 | 映射 |
| --- | --- |
| ① | M6.1：chatdb SQL 补附件准入条件（state=5 / is_sticker=0 / image/% / 纯图分支）+ 多附件行折叠；附件行带 transfer_name / total_bytes |
| ①+③ | HEIC→JPEG：读原文件（expandHome）→ tmpdir 中间 `.heic` → `/usr/bin/sips -s format jpeg <in> --out <out>` → 读回 bytes；name/mediaType 同步改 `.jpg`/`image/jpeg`；read/exec 注入 |
| ② | M6.1：`AskInput.prompt` 内容块化——core 自有 `[{type:'text'} \| {type:'image', bytes, mediaType, name?}]`；host 注入 `attachments` 服务 → `saveImages` → ref 块进 followup（DshPort 仍是唯一接缝） |
| ③ | M6.2：sender 增 `send POSIX file` 路径；暂存用**自有前缀 `dsh-imessage-out-`**（与 dsh-im 的 `dsh-im-out-` 区分，避免共存时互相误清扫），其余按 1h 保留 / 发送时清扫条款 |
| ① | M6.3：引用文本 JOIN 已有（M2）；引用携带图片 = JOIN 原消息附件并入引用块 |

## 开工分叉（已拍板，2026-11-21 均按推荐）

1. **非图片附件**（mov / docx / audio）：跳过 + 留痕（推荐——与 dsh-im `image/%` 准入一致；
   `FileAttachmentRef` 文件块能力留到 M7+ 评估）
2. **hide_attachment=1**：不过滤（推荐——与上游一致；语义未证实前不引入分歧）
