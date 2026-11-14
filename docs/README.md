# docs 索引

规划与设计定案都在这里。两个总纲放根上，其余按正在做的功能分子目录；新功能开工时建自己的目录（P1 收图、P2 companion 届时各建）。

## 总纲

- [PLAN.md](./PLAN.md) — 实施计划：宏观路线图与已确认决策
- [ARCHITECTURE.md](./ARCHITECTURE.md) — 架构蓝图（dsh-im iMessage 渠道解构 + 本项目重写蓝图）

## host-api/ — DSH 宿主 API 事实清单

host 适配层（`src/host/`）的依据：源码探索与真机探针互证，事实均附文件行号。

- [plugin.md](./host-api/plugin.md) — 插件宿主机制：服务面、inject、生命周期
- [ask.md](./host-api/ask.md) — 流式问答（ask/prompt）事件流
- [rpc.md](./host-api/rpc.md) — 会话与工作区 RPC

## settings-ui/ — 设置界面（已完成）

- [plan.md](./settings-ui/plan.md) — 实施计划（方案 A：客户端 UI 插件）
- [client-ui.md](./settings-ui/client-ui.md) — 客户端 UI 插件真机探针事实
- [config.md](./settings-ui/config.md) — 插件配置 / 设置界面实测（volatile 字段）
