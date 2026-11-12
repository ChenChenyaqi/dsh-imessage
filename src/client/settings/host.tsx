// 卡片宿主组件：把 controller 的快照与界面语言喂给纯视图。
//
// 这里是客户端半身唯一允许出现 hook 的地方（useSyncExternalStore），
// 因此它单独成文件：纯视图保持无 hook（元素树可直接断言），状态机保持
// 无 React（node 单测），只有这一层需要真渲染器（jsdom / 真机）。

import { useSyncExternalStore } from 'react';

import type { HostLocale } from '../host';
import type { CardController } from './controller';
import { SettingsCardView } from './view';
import { settingsTexts } from './texts';

export interface CardHostProps {
  readonly controller: CardController;
  readonly locale: HostLocale;
}

/**
 * 渲染设置卡片（订阅 controller 与界面语言）。
 * @param props.controller - 已绑定的 controller。
 * @param props.locale - 宿主语言服务（渲染期读取当前语言）。
 * @returns 元素树。
 */
export function CardHost(props: CardHostProps) {
  // 只跑在浏览器里，不需要服务端快照（getServerSnapshot 省略）
  const state = useSyncExternalStore(
    (listener) => props.controller.subscribe(listener),
    () => props.controller.getSnapshot(),
  );
  // 界面语言也要订阅：切语言时卡片文案跟着变
  const localeId = useSyncExternalStore(
    (listener) => props.locale.subscribe(listener),
    () => props.locale.getSnapshot().active,
  );

  return (
    <SettingsCardView
      state={state}
      text={settingsTexts(localeId)}
      onLocaleChange={(value: string) => props.controller.setLocaleDraft(value)}
      onAllowlistChange={(value: string) => props.controller.setAllowlistDraft(value)}
      onSave={() => void props.controller.save()}
    />
  );
}
