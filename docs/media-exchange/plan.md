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
  Step A/B/C 全部落地，真机验收待收口项统一做）
- [ ] **发图/发文件**：sender 增 `send POSIX file` 路径；暂存纪律 =
  `os.tmpdir()` + 自有前缀 `dsh-imessage-out-` + 1h 保留 + 发送时清扫
  （事实见 `probes.md` ③）；发送失败沿用 at-most-once（不重试不重复）
  （开工时扩本文件或另立子文档）
- [ ] **引用回复**：接收侧线程化引用归一化进 prompt；回复引用携带对方消息里的
  图片（引用用 Messages 自己的副本，不二次暂存）
- [ ] **收口**：覆盖率 ≥93% 不降；真机手工验收 checklist 更新；`pnpm check` 全绿

每步收口 = 源文件 + 镜像测试 + `pnpm check` 全绿（沿 M1 惯例）。

## 验收标准

真机收发图/文件各一条；HEIC 自动转码；附件不残留（含 tmpdir 暂存清扫验证）。
