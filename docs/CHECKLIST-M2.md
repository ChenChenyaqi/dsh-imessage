# M2 真机验收 Checklist（macOS · iMessage 收发内核）

> 手工验收工具：`node scripts/dev-cli.mjs <command>`（先 `pnpm build`）。
> 环境：Mac 本机登录 iMessage；权限主体 = 运行命令的终端 app（TCC 责任进程）。

## 权限与库访问

- [x] `probe`：FDA 与 Messages 自动化双绿（2026-11-07，iTerm2 已授权）
- [x] `peek 5`：真库 schema 探测通过；读到 Messages.app 运行中的 WAL 最新数据
      （19:26:46 的消息秒级可见）；date 转换为正确本地时间

## 解码与归一化

- [x] `listen --replay N`：回放最近 N 行，typedstream 解码 + normalize 全链路打印；
      accepted 消息文本正确、conversationKey 为 +86 形态；
      fromMe/垃圾号消息显示跳过原因
- [x] 结构 fixture 单测：30→8 条重组脱敏样本 + 构造用例全绿（CI 可跑）

## 发送（写路径）

- [x] `send <号码> '<含引号和换行的文本>'`：手机端收到两行文本、引号保留
      （2026-11-08，转义链路验证）
- [x] `send --system <号码> '<文本>'`：手机端收到 `[dsh] ` 前缀消息（系统路径）
- [x] 发出的消息落库后在 attributedBody（text 列为 null），自家解码器可完整读回

## 实时收链路（水位模式）

- [x] `listen`（无参数，从当前水位起步）：手机发一条文本 → 2s 内出现在
      输出行（2026-11-08 实测：`✓ 12:10:05 +861...: 你好`）；不回放旧消息
- [ ] 手机发一条**图片**消息 → 输出 `[attachment: image, not yet supported]`
      占位（纯附件降级）——待自然验证：随时发图后跑 `listen --replay 5` 可补验
- [ ] 手机发一条**垃圾短信/服务号**消息 → 显示跳过（invalid-handle 或正常
      accepted 但不属白名单——M3 gate 之前无白名单拦截，属预期）

## 已知边界（M2 范围外）

- 群聊消息跳过（memberCount > 1）；引用消息 quotedText 已提取未注入 prompt（P1）
- 白名单拦截在 M3 gate，本阶段 listen 会显示所有 accepted 消息
- 附件收发在 M5（HEIC 转码 / send POSIX file）
