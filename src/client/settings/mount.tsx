// 挂载设置菜单：把「词条 + controller + 槽位」三件事接到宿主上。
//
// 从 index.ts 抽出来的原因：入口只该声明「我是谁、我要哪些服务」，
// 而这里的时序细节（何时建 controller、何时等槽位声明）值得单独测试。

import type { ClientContext } from '../host';
import { CardHost } from './host';
import { createCardController, type CardController } from './controller';
import { presetOptions } from './card';
import { settingsMessages } from './texts';
import { ENTRY_ID, LOCALE_NAMESPACE, SECTION_ID, SECTION_ORDER } from './ids';

/**
 * 挂载设置菜单（词条注册 + controller 绑定 + 槽位注册）。
 * @param ctx - 浏览器插件上下文。
 * @returns controller（便于调用方在卸载时释放；也供测试断言绑定）。
 */
export function mountSettingsSection(ctx: ClientContext): CardController {
  // 我们自己的界面词条（不属于宿主字典，注册在自己的命名空间下）
  // host locale 词典是扁平 key→string：presetNames（id→名称映射）只给
  // 本地下拉用，不注册进宿主
  const { presetNames: _zhNames, ...zhFlat } = settingsMessages.zh;
  const { presetNames: _enNames, ...enFlat } = settingsMessages.en;
  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, { zh: zhFlat, en: enFlat }),
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

  // 预设下拉数据：官方客户端同款 remote 通道（Agent presets 页自己就用它）。
  // 服务不可用（gateway/invocation-unavailable）= 空列表：下拉退化为
  // 当前值兜底，设置页其余功能不受影响。
  ctx.effect(() => {
    void (async () => {
      const remote = ctx.remote?.agentPresets;
      if (!remote) return;
      const result = await remote.list();
      if (!result.ok) return;
      const names = settingsMessagesText(ctx).presetNames;
      controller.setPresetOptions(
        presetOptions(
          result.value.presets,
          controller.getSnapshot().preset.draft,
          typeof names === 'object' ? names : {},
        ),
      );
    })();
    return () => undefined;
  }, 'dsh-imessage: preset roster');

  /** 槽位渲染的入口组件（把 locale 服务钉进闭包）。 */
  function ImessageSettingsSection() {
    return <CardHost controller={controller} locale={ctx.locale} />;
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
          ImessageSettingsSection as unknown as (props: Record<string, never>) => unknown,
        ),
      ),
    'dsh-imessage: settings section',
  );

  return controller;
}

/** 当前界面语言下的卡片文案（保存失败提示用）。 */
function settingsMessagesText(ctx: ClientContext) {
  const locale = ctx.locale.getSnapshot().active;
  return locale === 'en' ? settingsMessages.en : settingsMessages.zh;
}
