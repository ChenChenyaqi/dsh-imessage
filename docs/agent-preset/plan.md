# 人设预设（agent preset）· 需求实施方案

> 需求（M5）：iMessage 会话带固定人设。内置大肥鱼（id `dafeiyu`）预设
> 包随仓库发布，用户可在设置页显式选择；预设只影响新建会话，缺失时
> 逐会话优雅降级。本文按代码反写（代码为唯一事实标准）。

## 架构（三个落点）

| 落点 | 事实 |
|---|---|
| `preset/` 子包 | `@chenchenyaqi/dsh-imessage-preset`，零代码纯补丁层：`dsh.bundle.patch` 指向 `cordis.patch.yml`（dsh-persona prefix/suffix + 工具组合，order 5）；`files` 只发补丁文件；发版校验 tag/主包/preset 三者版本一致（`scripts/check-release-versions.mjs`） |
| core 契约 | `CreateSessionInput.preset?`（缺省 = 宿主默认预设）；`RouterDeps.preset: () => string \| undefined` 用时读 |
| host / client | `src/host/dsh-port.ts` resolve→mount 组合链；`src/client/settings/preset/`（logic / usePreset / PresetSelect） |

## 生效链（已核实）

- **显式选择 > dafeiyu(已装) > 宿主默认**：
  - `agentPreset` 是 volatile 配置，**默认空 `''`**（≠定案的"默认
    dafeiyu"）：显式留空 = 未设置，由下层解析意图
  - channel 组装传 `preset: () => live.agentPreset || DEFAULT_PRESET_ID`
    （`DEFAULT_PRESET_ID = 'dafeiyu'`，client 下拉与 host 路由共享
    同一常量，`src/core/types/config.ts`）；dafeiyu 未装 → 组合链
    resolve 失败 → 降级无人设（见下）
- **preset() 用时读**：`createAndBind` 每次现调 `deps.preset()` 取
  live 值 → 热更（`channel.updateConfig`，日志 `channel.config-updated`
  的 `changed:['agentPreset']`）只影响之后新建的会话。对齐 DSH 事实：
  composition 创建时定格（`agent-preset/locked`），已有会话不换人设
- **resolve→mount 组合链**（dsh-port `createSession`）：
  `agentPresets.resolve(id)` → `meta.agentPreset`（持久化记账，
  resume 保持同组合）+ setup 回调内 `mount(agentContext, resolved)`
  （组合挂载是人设生效唯一路径；只传 meta 不生效）

## 降级（逐会话，warn 不停机）

- `agentPresets` 服务：host/index.ts 动态 `ctx.get('agentPresets')`
  （探针纪律，不进 inject），无预设体系的宿主上 undefined
- 服务缺失 → 无人设创建 + warn `preset-unavailable`；resolve 抛错
  （如预设被卸载）→ 无人设创建 + warn `preset-resolve-failed`
- 降级点在 **createSession 时逐会话判定**，不在 `channel.started`
  标注（与原定案偏差）；预设是体验项，不许炸通道
- `channel.started` 的 `agentPreset` 字段只回显意图值（排查用），
  不代表降级与否

## 设置页（UI 架构见 docs/host-integration/settings-ui/）

- 数据走官方 remote roster 通道 `ctx.remote.agentPresets.list()`
  （与官方 Agent presets 页同款）；usePreset 拉取一次写进草稿 store
  的 `presetOptions` 键，服务缺失/失败 = 空列表 → 下拉退化为当前值
  兜底行
- `presetOptions`：只保留已安装且启用的（`broken !== undefined`
  整行剔除）+ 去重；显示名 = 内置词典 `presetNames`（standard/ptc/
  minimal/cordis 的本地化名）→ roster `name` → 裸 id
- **显式选择永不静默回退**：`effectivePreset` 先返回非空 draft；
  已选预设被卸载时 `presetChoices` 补兜底行，当前值仍可见可选
- 「未设置 ≠ 选了 dafeiyu」：dirty 只认显式编辑（显示默认不点亮
  保存）；保存聚合时生效值为空则省略 agentPreset op（留给宿主默认）
- DOM 契约（e2e 依赖）：`select[data-field="preset"]`，不许丢

## 与定案的偏差

- 预设包定名 `@chenchenyaqi/dsh-imessage-preset`，人设发布**脱敏版**
  （主人角色保留、真名抹除——隐私红线优先于定案的"原样搬入"）
- `agentPreset` 默认空（≠定案的"默认 dafeiyu"），生效链为
  **显式选择 > dafeiyu(已装) > 宿主默认**，显式选择永不静默回退
- 降级不在 `channel.started` 标注，改为 createSession 时逐会话降级
- 设置页下拉数据走官方 remote roster 通道（`ctx.remote.agentPresets.list`），
  broken 整行剔除，显示名走官方内置词典

## 步骤（全部完成）

- [x] preset 子包：**脱敏版**大肥鱼人设（主人角色保留、真名抹除——
  隐私红线优先于"原样搬入"），npm 公有包
- [x] core 契约：`CreateSessionInput.preset` + router 用时读透传
- [x] host 组合链：resolve→mount、meta 记账、双降级路径
- [x] 设置页 preset 域：logic/usePreset/PresetSelect + 保存聚合接线
- [x] 测试镜像：dsh-port（组合生效/两路降级/setup 真执行）、
  session-router（preset 透传）、channel（热更只影响新会话）、
  client preset 域（选项过滤/生效值/兜底行）
- [x] e2e：preset 包随插件一起装（`dsh plugin add <repo>/preset`）；
  断言默认选中 dafeiyu、系统预设显示本地化名、大肥鱼显示发布名、
  显式选择保存后重开设置页仍保持（不被 dafeiyu 抢回）

## 验收标准（达成 [x] 2026-11-13）

真机装插件 + 预设两包，新会话以大肥鱼人设回复；卸预设包自动回退
宿主默认并留痕（warn 不停机）；设置页切换预设只影响新会话（hint
明示「仅对新建会话生效」，会话记忆在工作区文件不丢）；e2e 断言
preset 包随装与显式选择持久性。
