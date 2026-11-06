[English](./README.en.md) | **中文**

# dsh-imessage

> 把 macOS 原生 iMessage 接入 DeepSeek Harness（DSH）的官方 cordis 插件：
> 收，只读轮询 `chat.db`；发，osascript 控制 Messages.app。数据不出你的 Mac。

![node](https://img.shields.io/badge/node-%E2%89%A522-339933) ![dsh](https://img.shields.io/badge/DeepSeek%20Harness-0.2.x-4D6BFE) ![typescript](https://img.shields.io/badge/TypeScript-5.9-3178C6) ![license](https://img.shields.io/badge/license-MIT-black) ![stage](https://img.shields.io/badge/stage-M1%20骨架-orange)

---

## 为什么做这个

市面上的 iMessage × DSH 方案（如 photon-hq/dsh-imessage）走**云端托管**：消息过第三方服务器，号码也是托管号。本插件走另一条路——

- **本地原生**：直读本机 `~/Library/Messages/chat.db`（只读），通过 Messages.app 自动化接口发送，聊天记录不出机器
- **零云依赖**：不注册第三方服务、不需要托管号码，用你自己的 Apple ID
- **白名单准入**：默认拒绝，只有显式允许的手机号能触发机器人
- **会话隔离**：每个手机号独立的 DSH 会话与隔离工作区，互不串扰
- **拟人化输出**：语义分段 + 打字延迟，长代码块按"粘贴"节奏整块发送

## 架构

```
src/
├─ core/     ← 纯 TS 内核（零框架依赖，可独立单测）
│  ├─ imessage/   权限探测 · chat.db 轮询 · typedstream 解码 · 归一化 · 发送 · 拟人化
│  ├─ routing/    白名单+幂等门 · 会话路由 · 单向流水线
│  ├─ stores/     配置/状态（原子写）
│  └─ i18n/ log/
└─ host/     ← 薄 cordis 适配层：apply() 生命周期 · apiProxy→DshPort · 管理面
```

内核定义 `DshPort` 端口接口，host 层用 DSH 的 apiProxy 实现它——DSH 版本接口变动只波及 host，内核稳定。

## 前置要求

- macOS（在 Messages.app 登录 iMessage）
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) desktop 0.2.x
- 两项系统权限（插件设置页会引导开启）：
  - **完全磁盘访问**：读取 `chat.db` 必需
  - **自动化（控制 Messages.app）**：发送消息必需

## 路线图

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| M1 | 骨架 · 类型 · 存储 · i18n · 日志 | 🚧 进行中 |
| M2 | 收发内核（chat.db 轮询 / 解码 / osascript / 拟人化） | ⏳ |
| M3 | 会话路由 · 白名单 · 幂等 · 流水线 | ⏳ |
| M4 | cordis 宿主 · MVP 收口 | ⏳ |
| P1 | 收图（HEIC→JPEG）· 引用回复 · 发文件 · 基础命令 | ⏳ |
| P2 | companion 主动陪伴 · 表情包 · 设置页 UI | ⏳ |

详见 [PLAN.md](./docs/PLAN.md)（实施计划）与 [ARCHITECTURE.md](./docs/ARCHITECTURE.md)（架构蓝图）。

## 安装

> 🚧 尚未发布到 npm（MVP 完成后发布 `@chenyaqi/dsh-imessage`）。

届时：

```sh
dsh plugin --profile desktop add @chenyaqi/dsh-imessage
```

## 开发

```sh
pnpm install
pnpm check    # typecheck + lint + build + test
pnpm build    # esbuild → lib/index.js（单文件 ESM）

# 冒烟验证插件可被 DSH 宿主加载
dsh --profile web --patch <(echo "- insert:\n  - id: chenyaqi-dsh-imessage\n    name: '$PWD/lib/index.js'")
```

## 许可证

[MIT](./LICENSE)
