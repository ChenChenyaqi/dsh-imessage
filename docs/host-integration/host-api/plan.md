# DSH 宿主 API 事实库 · 定位与索引

> 本目录**不是需求设计**，是 DSH 宿主（apiProxy / 插件框架）的源码级事实清单，
> 防接口漂移用（风险对策：DSH rc 版接口漂移只波及 host 层）。需求设计目录
> 见 `docs/<需求>/plan.md` 惯例（如 `host-integration/settings-ui/`、`media-exchange/`）。

## 文件索引

| 文件 | 覆盖 |
| --- | --- |
| `plugin.md` | 插件装配：entry / inject / apply 生命周期 / 服务注入 |
| `rpc.md` | 会话与 workspace RPC（create / rename / history / status） |
| `ask.md` | 流式问答链路：四面（A 进程内 / B API Remote / C SDK / D ACP）的 prompt 与事件流 |

## 维护纪律

- 每条事实必须带源码位置（`packages/.../file.ts:行号`），宿主升级时按图复核；
- 修订时保持「事实」口径——只写实测/源码确认的结论，推断不落盘；
- host 层实现（`src/host/`）的注释是这些事实的消费现场，双向引用要同步。
