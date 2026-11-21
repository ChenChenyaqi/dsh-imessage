# docs 索引

规划与设计定案都在这里。两个总纲放根上；每个需求一个目录，目录内固定有
`plan.md`（实施方案），支撑文件（探针结论、宿主事实等）随目录放。

## 总纲

- [PLAN.md](./PLAN.md) — 实施计划：宏观里程碑路线图
- [ARCHITECTURE.md](./ARCHITECTURE.md) — dsh-im iMessage 渠道解构参考；含本项目已确认决策（D1–D9）与风险对策（实际模块架构见根 README「架构」段与各需求目录 plan.md）

## 已完成（M1–M5，按代码反写）

- [foundation/](./foundation/plan.md) — M1 底座：数据根 / 类型 / i18n / 日志 / state store
- [imessage-kernel/](./imessage-kernel/plan.md) — M2 iMessage 收发内核：chatdb / 解码 / normalize / 双路径发送
- [session-pipeline/](./session-pipeline/plan.md) — M3 会话路由与管线：预绑定事务 / 懒验证三态 / at-most-once
- [host-integration/](./host-integration/plan.md) — M4 宿主集成：cordis / DshPort / 通道装配 / e2e
  - host-api/ — DSH 宿主 API 事实库（plugin/rpc/ask，带源码行号，防接口漂移）
  - settings-ui/ — 设置页设计（M4 超额；preset 下拉部分属 M5）
- [agent-preset/](./agent-preset/plan.md) — M5 人设预设：preset 子包 / 会话贯通 / 降级链

## 进行中

- [media-exchange/](./media-exchange/plan.md) — M6 媒体收发：收图（HEIC→JPEG）/ 发图发文件 / 引用回复
