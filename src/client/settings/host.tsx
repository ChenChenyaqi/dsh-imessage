// 卡片宿主组件（组装层）：宿主表单订阅 + 草稿 store 生命周期 + context 注入。
//
// 分层契约（不变）：域组件与聚合 hook 从卡片 context 自取（hooks 下沉，
// 无 props drilling）；只有这一层碰真宿主服务。关页 = 组件卸载 =
// 草稿 store 销毁，草稿自然丢弃（无需 reset 补偿）。

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

import type { ClientContext } from '../host';
import { settingsMessages } from '../i18n/text';
import { CardProvider } from './card-context';
import { createDraftStore } from './draft-store';
import { ENTRY_ID } from './ids';
import { useCardForm } from './useCardForm';
import { SettingsCardView } from './view';

/**
 * 渲染设置卡片（组装层）。
 * @param props.ctx - 浏览器插件上下文（configForms/locale/remote）。
 * @returns 元素树。
 */
export function SettingsCardHost(props: { readonly ctx: ClientContext }) {
  const { ctx } = props;

  const form = ctx.configForms.get(ENTRY_ID);
  const { saved, mutate } = useCardForm(form);
  // 草稿 store 与卡片组件同生命周期：卸载即丢弃全部草稿
  const [store] = useState(createDraftStore);

  // 界面语言也要订阅：切语言时卡片文案与预设显示名跟着变
  // （subscribe 包 useCallback：稳定引用避免每次渲染重订阅）
  const subscribeLocale = useCallback(
    (listener: () => void) => ctx.locale.subscribe(listener),
    [ctx.locale],
  );
  const localeId = useSyncExternalStore(subscribeLocale, () => ctx.locale.getSnapshot().active);
  const messages = localeId === 'en' ? settingsMessages.en : settingsMessages.zh;

  const value = useMemo(
    () => ({
      store,
      saved,
      mutate,
      messages,
      remote: ctx.remote?.agentPresets,
    }),
    [store, saved, mutate, messages, ctx.remote],
  );

  return (
    <CardProvider value={value}>
      <SettingsCardView />
    </CardProvider>
  );
}
