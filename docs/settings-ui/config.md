# 宿主事实：插件配置 / 设置界面（真机实测 2026-11-12）

本文只记实测与源码交叉验证过的事实，供以后改配置面时防漂移。

## 1. 设置页只认 volatile 字段

`packages/settings/settings/src/schema.ts`

- `volatileForm(schema)`：只保留「最近 volatile 祖先」下的字段；整个 schema
  没有 volatile 字段时返回 `undefined`。
- `SettingsForms.describe()`（`settings/src/index.ts:302`）的准入条件全中才会
  产出描述符：
  1. `schema(entry)` 有值——即 `entry.fiber.runtime.Config` 存在且含 `toJSON`；
     `runtime.Config` 来自 `plugin.Config`（cordis registry.ts:326）；
  2. `entry.fiber` 存在、`runtime !== null`、`state === FiberState.ACTIVE`；
  3. `volatileForm(schema) !== undefined` ← **无 volatile 字段 = 设置页彻底隐形**。

即：功能性插件导出的具名 `Config`（schemastery）就是宿主读到的 schema；把字段
换成 `.volatile()` 才进表单。`applies: 'live'` 由 describe 固定给出。

**实测（真宿主探针，2026-11-12）**：本插件条目出现在 describe() 里：

```json
{ "ns": "chenyaqi-dsh-imessage", "applies": "live", "autoGenerate": true }
```

这条同时反证了 volatile 已被识别——否则 describe() 会因 form 为 undefined 直接跳过。

## 2. 自动生成的表单在哪：插件页，而不是设置弹窗

- 自动生成的表单消费方是 `packages/client/ui-plugin-manager`
  （侧栏「插件」页）：`PluginManagerPage.tsx` 的
  `formFor(rowId)` 用 `configForms.describe()` 的 ns 匹配 Loader 条目 id
  （`rowId = row.id`，即 profile patch 里的 entry id）。命中才渲染表单。
- 设置弹窗里的「内置插件」是 `packages/client/ui-settings-plugin-inventory`：
  通过 slot `settings.plugins.tab` 注册的**只读清单**（展示 fiber 阶段、
  模块名），不含任何配置表单。
- 因此：**本插件的配置表单在「插件」页 → 本 bundle → 条目
  `chenyaqi-dsh-imessage` 详情里**；设置弹窗不会出现它。
  想在设置弹窗里拥有专属页面，需另写客户端插件注册
  `settings.plugins.tab`（React 组件 + 客户端产物），成本远高于自动表单。

## 3. UI 保存 = 改写 profile patch（持久化由宿主保证）

`packages/boot/config-editor/src/index.ts` 的 `edit()`：

1. `settings.update(ns, patch)` → `configEditor.edit()`
2. 读 profile 的 `patchPath`（`~/.dsh/profiles/<p>/cordis.patch.yml`）
3. 只改该 entry 的 `config` 段，其余条目原样
4. `writeFileAtomic` + 文件锁，mode 0600 写回

所以 UI 改完重启即生效，插件**无需自存配置副本**。
（注意 139 行：若该条目被 home patch 或命令行覆盖，UI 编辑会报错拒绝。）

## 4. 热更新链路

1. UI 提交 → loader `Entry._commitVolatile` 解析新 raw config、比较非 volatile
   有效值，一致则**不重挂载**，提交进运行引用并 emit `loader/volatile-update`。
2. volatile 字段在运行期是活引用（`Volatile<T>`，`.get()` 取不可变快照）；
   纯对象引用非法值（函数、环）报 `ValidationError`。
3. 插件侧监听该事件 → 读 `.get()` → 应用（本插件：`channel.updateConfig()`）。
   监听器抛错由 loader 记录，不影响已提交的配置。

## 5. 复现探针（以后验证设置面不想靠肉眼）

```bash
# 1) 干净 web profile 副本（勿用 desktop：Electron 独占）
dsh --profile <p2> --from-default-profile web --dump-config > /dev/null
dsh plugin --profile <p2> add <本仓根目录>
# 2) 在 ~/.dsh/profiles/<p2>/cordis.patch.yml 写本插件条目 config
# 3) overlay 插入只读探针（inject: ['settings']，3s 后 dump describe()）
dsh --profile <p2> --patch /tmp/probe.yml --no-open --port 0
```

探针只用 `settings.describe()`（只读），不建 workspace / session，跑完直接
删掉临时 profile。

**教训**：即便挂在干净 profile 上，插件的**数据目录是全局共享的**
（`~/.dsh-imessage/`）。探针挂载插件会真的开始轮询本机 chat.db——与正在运行的
桌面实例抢同一个 state.json。本次实测确认 `processed: 0`、cursor 未动，但正确
做法是探针 profile 里把 `allowlist` 指向假号码（本次即如此）并尽快收进程。
