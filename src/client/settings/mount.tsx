// 挂载设置菜单：把「槽位组件」接到宿主上。
//
// 时序细节（何时等槽位声明）单独测试；卡片状态全部在 SettingsCardHost
// 的 hooks 里（组件生命周期 = 草稿生命周期，无需手动 dispose）。

import type { ClientContext, SlotComponent } from '../host';
import { SettingsCardHost } from './host';
import { SECTION_ID, SECTION_ORDER } from './ids';

/**
 * 挂载设置菜单（槽位注册）。
 * @param ctx - 浏览器插件上下文。
 */
export function mountSettingsSection(ctx: ClientContext): void {
  /** 槽位渲染的入口组件（把 ctx 钉进闭包）。 */
  function ImessageSettingsSection() {
    return <SettingsCardHost ctx={ctx} />;
  }

  // slots.register 早于槽位声明会抛错（真机踩坑），必须等声明就绪
  ctx.effect(
    () =>
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          // 产品名不做翻译：zh/en 都显示 iMessage
          {
            name: 'settings.section',
            id: SECTION_ID,
            order: SECTION_ORDER,
            label: () => 'iMessage',
          },
          ImessageSettingsSection as SlotComponent,
        ),
      ),
    'dsh-imessage: settings section',
  );
}
