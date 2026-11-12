// 客户端半身（Step 0 探针）：在设置弹窗左侧注册一个 iMessage 菜单。
//
// 这是最小可验证面：只注册槽位、只渲染一行占位文案。它存在的目的是
// 证明「双面包 + closure-factory 产物 + settings.section 槽位」这条链路
// 在真宿主上走得通；真正的配置表单在后续步骤里长出来。
//
// 实测事实（2026-11-12 真机探针）：直接 `slots.register` 会在槽位声明
// 之前抛 `slot "settings.section" is not declared`——本 entry 可能先于
// 声明方（ui-settings-general）激活。因此必须用 `slots.inject(key, cb)`
// 等声明就绪后再注册。

import { createElement } from 'react';

/** 宿主提供的客户端服务（cordis fiber inject）。 */
export const inject = ['slots'];

/** 设置菜单条目 id（同时是 profile patch 的 entry id 之外的身份标识）。 */
export const SECTION_ID = 'dsh-imessage';

/** 菜单排序：落在内置插件（order 40 段）之后。 */
export const SECTION_ORDER = 50;

/** 探针占位组件：只证明槽位被渲染。 */
function ProbeCard() {
  return createElement('div', { 'data-dsh-imessage-probe': '' }, 'iMessage settings coming soon');
}

/**
 * 挂载设置菜单。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: {
  slots: {
    register(
      options: { name: string; id: string; order: number; label: () => string },
      component: unknown,
    ): () => void;
    inject(key: string, callback: () => () => void): () => void;
  };
  effect(fn: () => () => unknown, label?: string): void;
}): void {
  ctx.effect(
    () => ctx.slots.inject('settings.section', () => ctx.slots.register(
      // 产品名不做翻译：zh/en 都显示 iMessage
      { name: 'settings.section', id: SECTION_ID, order: SECTION_ORDER, label: () => 'iMessage' },
      ProbeCard,
    )),
    'dsh-imessage: settings section',
  );
}
