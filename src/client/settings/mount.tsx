// 挂载设置菜单：把「词条 + controller + 槽位」三件事接到宿主上。
//
// 从 index.ts 抽出来的原因：入口只该声明「我是谁、我要哪些服务」，
// 而这里的时序细节（何时建 controller、何时等槽位声明）值得单独测试。

import type { ClientContext } from '../host';
import { CardHost } from './host';
import { createCardController, type CardController } from './controller';
import { settingsMessages } from './texts';
import { ENTRY_ID, LOCALE_NAMESPACE, SECTION_ID, SECTION_ORDER } from './ids';

/**
 * 挂载设置菜单（词条注册 + controller 绑定 + 槽位注册）。
 * @param ctx - 浏览器插件上下文。
 * @returns controller（便于调用方在卸载时释放；也供测试断言绑定）。
 */
export function mountSettingsSection(ctx: ClientContext): CardController {
  // 我们自己的界面词条（不属于宿主字典，注册在自己的命名空间下）
  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, {
      zh: settingsMessages.zh,
      en: settingsMessages.en,
    }),
    'dsh-imessage: settings texts',
  );

  // 表单绑定在 apply 期完成（官方同款：AgentLoopCardController 也是 apply 期
  // 建 controller），controller 与 fiber 同生命周期。
  // 配置命名空间是 profile entry id，菜单 id 只是 UI 身份——用错会拿到空快照。
  const controller = createCardController({
    namespace: ENTRY_ID,
    form: ctx.configForms.get(ENTRY_ID),
    texts: settingsMessagesText(ctx),
  });
  ctx.effect(() => () => controller.dispose(), 'dsh-imessage: settings controller');

  /** 槽位渲染的入口组件（把 locale 服务钉进闭包）。 */
  function ImessageSettingsSection() {
    return <CardHost controller={controller} locale={ctx.locale} />;
  }

  // slots.register 早于槽位声明会抛错（真机踩坑），必须等声明就绪
  ctx.effect(
    () => ctx.slots.inject('settings.section', () => ctx.slots.register(
      // 产品名不做翻译：zh/en 都显示 iMessage
      { name: 'settings.section', id: SECTION_ID, order: SECTION_ORDER, label: () => 'iMessage' },
      ImessageSettingsSection as unknown as (props: Record<string, never>) => unknown,
    )),
    'dsh-imessage: settings section',
  );

  return controller;
}

/** 当前界面语言下的卡片文案（保存失败提示用）。 */
function settingsMessagesText(ctx: ClientContext) {
  const locale = ctx.locale.getSnapshot().active;
  return locale === 'en' ? settingsMessages.en : settingsMessages.zh;
}
