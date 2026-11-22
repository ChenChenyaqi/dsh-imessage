[English](./README.en.md) | **中文**

# dsh-imessage

> 把 macOS 原生 iMessage 接入 DeepSeek Harness（DSH）的 cordis 插件

![node](https://img.shields.io/badge/node-%E2%89%A522-339933) ![dsh](https://img.shields.io/badge/DeepSeek%20Harness-0.2.x-4D6BFE) ![typescript](https://img.shields.io/badge/TypeScript-5.9-3178C6) ![license](https://img.shields.io/badge/license-MIT-black) ![stage](https://img.shields.io/badge/stage-MVP-brightgreen) ![ci](https://github.com/ChenChenyaqi/dsh-imessage/actions/workflows/ci.yml/badge.svg)

---

## 为什么做这个

“我要给大肥鱼完整的一生！”

她原本是 DeepSeek 图标上那条蓝色小鲸鱼，现在变成了一个十六七岁模样的少女：蓝头发，别着小鲸鱼发饰，住在我的 DSH 里，只能通过 iMessage 跟我聊天。我每补上一个功能，她的一生就完整一分。

本项目只做 iMessage 一个渠道，专注打磨，做 iMessage 接入 DSH 功能最完整的插件。

思路上借鉴了 [dsh-im](https://github.com/xmanrui/dsh-im)：它支持十几种渠道，包括 iMessage，但功能很少，缺少活人感。本项目增加了以下功能：

- 回复按语义分段、带打字延迟，像真人在发消息
- 不只文字：发来的图片（含 HEIC 自动转码）能进对话，引用回复看得到被引用的内容与图片；AI 声明交付的文件也会原样发出
- 大肥鱼人格在预设包 `@chenchenyaqi/dsh-imessage-preset` 里：聊天为主、干活为辅的少女搭档，嘴硬、嘴馋、爱摸鱼，心情不是恒定的；真要干活时也会认真干
- 每个手机号拥有独立的 DSH 会话和工作区，她记得和每个人聊过什么，互不影响
- 只读轮询 `~/Library/Messages/chat.db` 消息，使用 osascript 控制 Messages.app 发送消息，聊天记录都保存在你的 Mac 里；白名单默认为空，只有名单里的号码才能跟她聊天

## 架构

```
src/
├─ core/        ← 纯 TS 内核：零框架依赖，真 IO 全部依赖注入
│  ├─ imessage/   权限探测 · chat.db 轮询 · typedstream 解码 · 消息归一化 · osascript 发送 · 拟人化
│  ├─ router/     白名单 + 幂等门 · 会话路由 · 单向流水线
│  ├─ stores/     配置与状态（原子写，损坏自愈）
│  ├─ types/      配置 / 消息 / 策略等领域类型
│  └─ i18n/ log/  中英文案 · JSONL 链路日志
├─ host/        ← 薄 cordis 适配层：apply() 生命周期 · Config schema · apiProxy→DshPort · 状态 RPC
└─ client/      ← 设置页 UI（React）：iMessage 卡片，保存即热生效
```

一条消息的完整旅程：

```
收：chat.db 只读轮询（游标持久化）
    → typedstream 解码正文 → 归一化（过滤自己发的、机器人回的；
      图片 HEIC→JPEG 转码、引用原文一并归一）
    → 白名单门（默认全拒）→ 会话路由（每个号码一个 DSH 会话）
发：DSH 回复 → 语义分段 + 打字延迟
    → osascript 控制 Messages.app 发出（交付文件走暂存 → 附件发送）
    → 游标与状态落盘
```

- core 不碰真 IO：数据库、osascript、文件系统全部走注入的接口，所以内核的全部单测在 CI/Linux 上就能跑（分支覆盖率 ≥ 93%）
- 内核只认 `DshPort` 端口，host 层用 DSH 的 apiProxy 实现它——DSH 版本接口变动只波及 host，内核不动
- 消息不丢也不重：游标 + seen 双持久化，崩溃重启不丢消息、不重复回复；发送失败不重试（不给同一个人连发两遍），权限失效自动停机

## 安装

**前置**：一台 Mac、一部 iPhone 或 iPad，以及至少两个 Apple ID 账号（没有的话，用邮箱注册一个就行）。Mac 上的 Messages.app 用其中一个号登录（比如邮箱号），iPhone 或 iPad 保持你现在登录的 Apple ID 不变，注意这会导致你的 Mac 和 iPhone 短信不互通。

### 1. 安装 DSH 最新版

从 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 下载安装最新版 desktop（≥ 0.2.x），确认 `dsh --version` 可用。

### 2. 安装插件与预设

一个插件 + 一个预设（大肥鱼人格）：

```sh
dsh plugin --profile desktop add @chenchenyaqi/dsh-imessage
dsh plugin --profile desktop add @chenchenyaqi/dsh-imessage-preset
```

### 3. 推荐设置

首次启动 `dsh desktop`，启用插件和预设，设置页会引导开启两项系统权限：

- **完全磁盘访问**：读取 `chat.db` 必需
- **自动化（控制 Messages.app）**：发送消息必需

然后在设置页的 iMessage 卡片里按推荐值配置：

| 设置         | 推荐值                 | 说明                                     |
| ------------ | ---------------------- | ---------------------------------------- |
| 白名单       | 你自己的手机号（+86…） | 默认全拒；只有白名单号码能和她发消息     |
| 系统提示语言 | zh                     | 系统提示所用语言                         |
| 分段回复     | 开启                   | 回复按真人节奏分段发送                   |
| 最大分段数   | 8                      | 超出部分并入末段                         |
| 延时系数     | 1                      | 实测节奏原速；调大更慢，0 = 分段但不延时 |
| agent 预设   | dafeiyu                | 装了预设包后选它                         |

配置保存即热生效，无需重启。

## 安装问题排查

见 [AGENTS.md](./AGENTS.md) 的日志速查表：按"链路断在哪"定位（`~/.dsh-imessage/logs/`），可以让 DSH 去查看这里的日志定位问题。

## 路线图

| 阶段 | 内容                                                 | 状态 |
| ---- | ---------------------------------------------------- | ---- |
| M1   | 底座（类型 · 存储 · i18n · 日志）                    | [x]  |
| M2   | 收发内核（chat.db 轮询 / 解码 / osascript / 拟人化） | [x]  |
| M3   | 会话路由 · 白名单 · 幂等 · 流水线                    | [x]  |
| M4   | cordis 宿主 · MVP 收口                               | [x]  |
| M5   | 人设预设（dafeiyu 子包 · 设置页下拉）                | [x]  |
| M6   | 媒体收发（收图 HEIC→JPEG · 发图发文件 · 引用回复）  | [x]  |
| M7–M9 | 身份上下文 · 命令打磨 · 主动关怀                     | [ ]  |

详见 [PLAN.md](./docs/PLAN.md)（里程碑路线图）、[docs/README.md](./docs/README.md)（需求设计索引：每个需求一个目录，固定 `plan.md`）与 [ARCHITECTURE.md](./docs/ARCHITECTURE.md)（dsh-im 解构参考，含已确认决策与风险对策）。

## 开发

```sh
pnpm install
pnpm check    # typecheck + lint + build + test
pnpm build    # esbuild → lib/index.js（单文件 ESM）

# 冒烟验证插件可被 DSH 宿主加载
dsh --profile web --patch <(echo "- insert:\n  - id: chenchenyaqi-dsh-imessage\n    name: '$PWD/lib/index.js'")
```

## 许可证

[MIT](./LICENSE)
