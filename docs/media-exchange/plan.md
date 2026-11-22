# 媒体收发（media exchange）· 需求实施方案

> 需求：iMessage 渠道支持图片收发——收图进 AI 会话（内容块）、发图/发文件
> （osascript 附件）、引用回复携带媒体。对齐 dsh-im v5.10.0 后主线，
> 先实测再写码（探针结论见同目录 `probes.md`）。

## 范围与边界

- **收**：图片（png/jpeg/gif/heic）以内容块进 ask；非图片附件（视频/文档/
  音频）跳过留痕，不做 FileAttachmentRef 文件块（M7+ 再评估）
- **发**：图片与文件经 osascript `send POSIX file` 发出；AI 主动发图
  （ask 流产物）不在本需求内
- **隐私红线不变**：图片内容/正文永不入日志；探针与测试只用结构聚合或合成数据

## 实施路线

- [x] **探针（2026-11-20）**：chat.db 附件准入事实 / DSH 图片内容块契约 /
  osascript 发送与暂存纪律，结论见 `probes.md`
- [x] **收图**：附件元数据 → media 加载（HEIC→JPEG，sips 注入）→
  ask 内容块化；详细设计见 `inbound-images.md`（分叉已按推荐拍板；
  真机验证：首验实证 U+FFFC 占位并修复（1161ef4），M6.3 验收的
  引用图再次实证同链路 media-loaded loaded:1）
- [x] **发图/发文件（2026-11-22 真机验收通过）**：sender 增
  `send POSIX file` 路径；暂存纪律 = `os.tmpdir()` + 自有前缀
  `dsh-imessage-out-` + 1h 保留 + 发送时清扫（事实见 `probes.md` ③）；
  交付工具 `imessage_send_file`（全局注册 + 执行时路由校验）→
  collector 保序 → pipeline 交付段；发送失败沿用 at-most-once（不重试
  不重复）+ i18n 系统通知；设计见 `outbound-files.md`（含验收记录
  guid 2A02C255 / chat.db rowid 2753 transfer_state=5）
- [x] **引用回复（M6.3，2026-11-22 真机验收通过）**：接收侧引用归一
  （author 区分 + 被剪降级 + 扇出按 path 去重）→ 引用块 Markdown 前缀
  进 prompt；引用图走 M6.1 media 链路进块（先因后果块序）；设计验收
  一体见 `quoted-replies.md`（四场景全通：us/them 文字、纯图引用、
  caption+图）
- [x] **收口（2026-11-22）**：分支覆盖率 95.66%（基线 93% 不降反升）；
  三个里程碑真机验收记录均已登记（`inbound-images.md` 实证注 /
  `outbound-files.md` / `quoted-replies.md`）；`pnpm check` 全绿
  （670 测试）

每步收口 = 源文件 + 镜像测试 + `pnpm check` 全绿（沿 M1 惯例）。

## 验收标准

真机收发图/文件各一条；HEIC 自动转码；附件不残留（含 tmpdir 暂存清扫验证）。
