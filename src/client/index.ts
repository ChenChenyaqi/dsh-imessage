// 客户端半身入口：只声明身份与依赖，接线交给 settings/mount。
//
// 分层（每层单独可测，互不越界）：
//   host.ts                 宿主服务契约（类型）
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

/** 宿主提供的客户端服务（cordis fiber inject）。 */
export const inject = ['slots', 'locale', 'configForms'];

export { ENTRY_ID, LOCALE_NAMESPACE, SECTION_ID, SECTION_ORDER } from './settings/ids';

/**
 * 挂载插件。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: ClientContext): void {
  mountSettingsSection(ctx);
}
