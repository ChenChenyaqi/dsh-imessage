# 宿主事实：客户端 UI 插件（真机探针 2026-11-12）

Step 0 探针的产出：把「设置弹窗左侧加一个我们自己的菜单」这条链路全部
实测打通。所有结论都有真机验证，不是读源码推断。

## 1. 单包双面：不需要拆包

`packages/client/modules/src/index.ts` 的 `resolveMeta()` 按**宿主 entry 的
包根**扫描：包在 `package.json` 声明 `dsh.client`（`platform: 'web'`）且
`exports["./client"]` 指向产物，则同一条 entry 额外加载一份浏览器半身。

实测：我们的 profile patch 里仍然只有一条 entry（`chenyaqi-dsh-imessage`），
浏览器拿到的 boot 行是：

```json
{ "id": "@chenyaqi/dsh-imessage",
  "url": "plugins/??@chenyaqi/dsh-imessage/client.js&rev=<hash>",
  "inject": ["@deepseek-ai/dsh-client-ui-settings"] }
```

file: link 安装（`dsh plugin --profile <p> add <repo>`）也能正常扫描，**不需要
workspace 拆两包**。

## 2. 产物格式：closure-factory

浏览器端不是普通 ESM，而是惰性 CJS 表（`client/modules/src/client/manifest.ts`
头注释）：

```js
window.__ModuleLoader__.load({
  id: "@chenyaqi/dsh-imessage",
  factory: function (require) {
    var module = { exports: {} };
    (function (module, exports, require) { /* esbuild CJS 产物 */ })(module, exports, require);
    return module.exports;
  },
});
```

- 脚本执行时**只登记工厂**，求值发生在 materialize。
- 外部依赖走注入的 `require`，从宿主冻结模块表解析。
- 实现在 `scripts/lib/client-bundle.mjs`（esbuild CJS + 包装），
  `scripts/build.mjs` 产出 `lib/client.js`。

## 3. 可共享的平台模块（externals 白名单）

`packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES`：

```
react, react/jsx-runtime, react-dom, react-dom/client, @deepseek-ai/cordis, zod,
@tanstack/react-virtual, @deepseek-ai/dsh-client-store,
@deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-primitives,
@deepseek-ai/dsh-client-ui-dockkit
```

`@deepseek-ai/dsh-client-ui-primitives`（React 18，样式只用 `--dsw-*` 令牌）
提供 `Button` / `Input` / `Switch` / `SegmentedControl` / `Menu` / `Tag` /
`Toast` / `Tooltip` / **`ConfigField`**（choices 非空→下拉，否则 textarea）。
**不引入第三方组件库**：平台表之外的模块不共享，打了就是第二份 React。

## 4. 挂载设置菜单：`settings.section` + 必须 `slots.inject`

设置弹窗左侧每一项都是客户端插件注册的 `settings.section` 列表槽位
（`ui-settings-general` 声明该槽位；`ui-settings-account` 等注册）。

**踩坑（探针实测）**：直接 `ctx.slots.register({ name: 'settings.section', ... })`
会让整个客户端 boot 失败：

```
web boot: 1 entry did not activate
@chenyaqi/dsh-imessage: failed
```

原因是 `slots.register` 在槽位**声明**之前调用会抛
`slot "settings.section" is not declared`，而我们的 entry 可能先于声明方
激活。正确写法（`ui-renderer/src/client/registry.ts:209` 的 `slots.inject`
语义：等声明就绪再跑回调，声明撤销时连带 dispose）：

```ts
ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register(
  { name: 'settings.section', id: 'dsh-imessage', order: 50, label: () => 'iMessage' },
  Card,
)));
```

修复后实测：设置弹窗左侧出现「iMessage」，点开渲染出我们的组件
（见 `docs/probe-step0-settings-menu.png`）。

## 5. 配置读写：`ctx.configForms.get(entryId)`

- 读：`form.getSnapshot()` → `{ value, base, user, revision, writable }`
- 写：`form.set(field, value)` / `form.unset(field)` / `form.mutate(ops, revision)`
- 语义：写队列 + 版本冲突恢复，最终落到 settings RPC → `configEditor.edit()`
- 只有 Host 侧 `settings.describe()` 里出现的命名空间才有表单（即 schema 必须
  含 volatile 字段，见 `docs/host-api-facts-settings.md`）

**注意**：Host 侧自动生成的 form **没有任何通用 UI 渲染器**——`plugins.row.config`
槽位和 `settings.section` 槽位都必须由客户端插件自己注册组件。这就是为什么
Host-only 插件在任何界面都看不到配置。

## 6. 探测方法论（以后复用）

1. 干净 web profile 副本 + `dsh plugin add <repo>` + patch 写我们的 config
2. `DSH_IMESSAGE_HOME=<临时目录>` 起实例（隔离真实 state.json，避免与桌面实例
   抢同一文件）；白名单填假号码，杜绝真发消息
3. chrome-devtools MCP 打开 `http://127.0.0.1:<port>/?token=...`
4. 断言顺序：先看 `window.__DSH_BOOT__.entries` 有没有我们的行（发现层）→
   再 fetch `row.url` 看 200（服务层）→ 再 materialize 看 exports（工厂层）→
   最后看 boot banner 有没有激活失败（生命周期层）
5. 收尾：杀进程、删临时 profile 与临时目录

**排查提示**：`fetchBundle` 只服务「已广告的组合 URL」，手工 fetch 时漏掉
`&rev=<hash>` 会得到 404——那不是宿主 bug，是探针写错 URL。
