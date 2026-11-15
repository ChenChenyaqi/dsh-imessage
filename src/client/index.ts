// 客户端半身入口：只声明身份与依赖，接线交给 settings/mount。
//
// 分层（每层单独可测，互不越界）：
//   host.d.ts              宿主服务契约（纯类型声明，无运行时）
//   settings/ids.ts         身份常量（菜单 id / 配置命名空间）
//   settings/texts.ts       界面词条（zh/en）
//   settings/card.ts        纯状态机（无 React、无宿主）
//   settings/controller.ts  订阅与写入时序（无 React）
//   settings/view.tsx       纯渲染（无 hook）
//   settings/host.tsx       hook 组件（useSyncExternalStore）
//   settings/mount.tsx      槽位/词条/controller 接线
//   本文件                   插件入口（inject + apply）

import type { ClientContext } from './host';
import { mountSettingsSection } from './settings/mount';

/** 宿主提供的客户端服务（cordis fiber inject）。
 * remote.agentPresets：官方客户端 Agent presets 页同款通道（官方组件
 * 自身也静态注入它，客户端恒在；缺失时 roster 读失败 → 下拉退化为空）。 */
export const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.agentPresets'];

/**
 * 挂载插件。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: ClientContext): void {
  mountSettingsSection(ctx);
}
