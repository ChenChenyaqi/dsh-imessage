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
- host 层实现（`src/host/`）的注释是这些事实的消费现场，双向引用要同步；
- **最小面字段防再犯四条**（源自 2026-11-22 exec.agent.sessionId 事故：
  grep 到 `CreateAgentOptions.sessionId` 就下结论，没打开 `Agent` 接口
  本身——官方字段是 `id`，同项目 `HostBareAgent` 早已实测记录，真机
  首验才暴露）：
  1. 新写/修改 Host* 最小面字段前，先 `awk` 出官方接口**全文**逐字段
     对照，注释附源码坐标——禁止凭记忆或 grep 片段定字段名；
  2. 同概念单一定义：Agent 身份一律复用 `HostBareAgent`（`{id}`），
     禁止另起声明；
  3. 宿主运行时鸭子契约（execute/render/saveImages 等）首次真机跑通
     前不标完成、不进提交——类型检查与照声明造的 fake 都无法证伪
     字段名错误，只有运行时能；
  4. 测试里宿主形状的 fake 照官方源码造（标注坐标），不照我们的
     声明造——声明错了 fake 才测得出。
