# 方案 A：设置界面（客户端 UI 插件）实施计划

目标：DSH 设置弹窗左侧出现「iMessage」菜单，可编辑**语言**与**白名单**，
保存后立即生效（不重启），并持久化到 profile patch。

## 0. 为什么必须写客户端插件（结论先摆）

- 设置弹窗左侧菜单 = 客户端插件注册槽位 `settings.section`
  （`ui-settings-account:323`、`ui-settings-plugins:76` 等，全是手写 React 组件）。
- 插件页的组件行配置 = 槽位 `plugins.row.config`，同样只有手写组件注册；
  Host 侧 `settings.describe()` 生成的 form 只是作为 prop 传进槽位，
  **DSH 0.2.x 没有通用自动表单渲染器**。
- 因此 Host-only 插件在任何界面都没有配置入口（已实测确认）。

## 1. 架构决定（已用源码核实）

| 决定 | 内容 | 依据 |
|---|---|---|
| 单包双面 | 不拆包、不加 entry：`package.json` 加 `dsh.client` + `exports["./client"]`，客户端半身随宿主 entry 自动加载 | `client-modules/src/index.ts:906` 按 entry 解析包根 |
| 产物格式 | closure-factory：`window.__ModuleLoader__.load({id, factory})`，externals 走注入的 `require` | `client/modules/src/client/manifest.ts` 头部契约 |
| 外部依赖 | 只用平台模块表里的：`react`、`react/jsx-runtime`、`@deepseek-ai/cordis`、`dsh-client-ui-primitives`、`dsh-client-ui-slots`、`dsh-client-store` | `client/web/src/platform.ts` PLATFORM_MODULES |
| 组件库 | **DSH 自带 primitives**（`ConfigField`/`Button`/`Tag`），不引第三方 | ConfigField 即「choices 下拉 / 否则 textarea」 |
| 挂载槽位 | `settings.section`，id `dsh-imessage`，order 落在「内置插件」之后 | 同上 |
| 数据面 | `ctx.configForms.get('chenchenyaqi-dsh-imessage')` 读快照 + `form.set(field, value)` 写 | `ui-settings/src/client/config-form.ts:129` |
| 样式 | 不用自定义 CSS（避免 lightningcss 流程），只 primitives + 内联样式 | tsdown.client.ts CSS 契约 |
| i18n | 复用 `src/core/i18n`（纯函数，无 node 依赖）新增 UI 文案键 | 现有 zh/en 字典 |

写入链路（已真机实测通）：
```
ConfigField → form.set() → settings.mutate RPC → configEditor.edit()
  → 原子写 cordis.patch.yml → loader _commitVolatile
  → emit loader/volatile-update → channel.updateConfig()
  → 日志 channel.config-updated（实测 8s 内 allowlistCount 1→2）
```

## 2. 步骤

### Step 0 · 客户端加载可行性探针（✅ 已完成 2026-11-12）
最小客户端半身：只注册一个 `settings.section` 显示 "dsh-imessage probe"。
- 产出 `lib/client.js`（手写 closure-factory 包装）+ `dsh.client` 清单
- 隔离 web profile（`DSH_IMESSAGE_HOME` 指向临时目录，白名单填假号码）
- chrome-devtools MCP 驱动：设置弹窗 → 应出现「probe」菜单
- 结果写入 `client-ui.md`（槽位 id/顺序/require 表/失败模式）

**结论（全部实测通过）**：
- 单包双面可行，file: link 也能被扫描 → **不需要拆包**（成本下调）
- closure-factory 产物格式验证通过（`scripts/lib/client-bundle.mjs`）
- 菜单已真实出现（无障碍树断言，验证方式见下）
- **踩坑已固化**：必须 `slots.inject('settings.section', () => register(...))`，
  直接 register 会让整个客户端 boot 失败

### Step 1 · 构建与清单接线
- `package.json`：`exports`（`.`→`lib/index.js`，`./client`→`lib/client.js`）、
  `dsh.client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-settings','@deepseek-ai/dsh-client-locale'] }`
- `scripts/build.mjs`：加第二个 esbuild target（jsx: automatic、externals、CJS），
  产物包进 closure-factory 模板
- devDeps：`react`、`@types/react`、`@deepseek-ai/dsh-client-ui-primitives`、
  `-ui-slots`、`-client-store`、`-ui-settings`（版本 0.2.2-rc.2）
- 独立 `tsconfig.client.json`（jsx: react-jsx，排除 node 代码）；`pnpm check` 覆盖

### Step 2 · 纯逻辑 controller（测试先行）
`src/client/allowlist-controller.ts`：文本 ↔ 数组归一化（每行一个、去空行、
去重、保留原始写法交给 core 的 makePolicy）、locale 选项、脏值判断、校验错误、
提交（调用注入的 form 接口）。
- 纯 TS，零 React，`tests/client/*.test.ts` 全覆盖
- 边界：空文本 = 全拒（要显式提示"空白名单=全拒"）、非法行提示但不阻塞保存、
  提交失败（RPC 拒绝）的错误文案

### Step 3 · React 组件（薄壳）
`src/client/SettingsCard.tsx`：两个 `ConfigField` + 保存按钮 + 状态 Tag。
只做渲染与事件转发，逻辑全在 controller。
覆盖率：controller 满覆盖，组件靠真机验证（DOM 单测成本不划算）。

### Step 4 · 客户端插件入口
`src/client/index.ts`：`export const inject = ['slots','locale','configForms']`、
注册 `settings.section`、注册 zh/en 字典。

### Step 5 · 真机联调 + 收尾（✅ 已完成 2026-11-12）
chrome-devtools 脚本化验收：
1. 设置 → iMessage 菜单存在
2. 改白名单 → 保存 → 日志 `channel.config-updated`（新数量）
3. 重启 DSH → `channel.started` 的 `allowlist` 是新值 → 持久化闭环
4. 白名单外号码发消息 → `message-skipped not-allowlisted`（策略真生效）
产出：真机 e2e 脚本 `tests/e2e/settings-ui.spec.ts`（`pnpm e2e`，约 4.5 秒，
隔离临时 DSH_HOME 并自动清理）。

## 3. 风险与应对

| 风险 | 应对 |
|---|---|
| ~~双面包扫描不认 file: link 包~~ | ✅ Step 0 已验证支持，不再需要拆包 |
| externals 未命中平台表 → 运行时报错 | Step 0 抓到真实错误信息再定 externals 清单 |
| 客户端 bundle 误引 node 模块（如 core/chatdb） | 客户端只允许 import `@/core/i18n` 与类型；esbuild 加 platform=browser，node 内置直接报错 |
| 桌面 app 客户端清单校验更严 | Step 0 在 web 验证 + 桌面 app 复验一次 |
| allowlist 是数组，`form.set` 传数组是否被接受 | Step 0/2 顺带验证；不接受则退回"数组展开成 JSON 文本"方案 |

## 4. 不做的事（范围外）

- 运行状态展示（cursor/会话数/权限）→ 后续版本，可复用已有 `/api/dsh-imessage/status`
- 权限引导（磁盘访问/自动化申请）→ 后续
- 会话管理（查看/解绑）→ 后续

## 5. 预估

| 步骤 | 工作量 |
|---|---|
| Step 0 探针 | ✅ 已完成 |
| Step 1 构建接线 | 0.5 天 |
| Step 2 controller + 测试 | 0.5 天 |
| Step 3–4 组件与入口 | 0.5 天 |
| Step 5 联调验收 | 0.5 天 |
| **合计** | **剩余 1.5–2 天** |
