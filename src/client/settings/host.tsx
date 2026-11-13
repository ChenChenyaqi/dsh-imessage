// 卡片宿主组件：把 controller 的快照与界面语言喂给纯视图。
//
// 这里是客户端半身唯一允许出现 hook 的地方（useSyncExternalStore），
// 因此它单独成文件：纯视图保持无 hook（元素树可直接断言），状态机保持
// 无 React（node 单测），只有这一层需要真渲染器（jsdom / 真机）。

import { useEffect, useSyncExternalStore } from 'react';

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
  // controller 比视图活得久（apply 期建、插件卸载才销毁）：关设置页必须
  // 丢弃未保存草稿，否则重开看到的是旧草稿、重启又变回来（真机 bug）。
  useEffect(() => () => props.controller.reset(), [props.controller]);

  return (
    <SettingsCardView
      state={state}
      text={settingsTexts(localeId)}
      onLocaleChange={(value: string) => props.controller.setLocaleDraft(value)}
      onBeginAdd={() => props.controller.beginAdd()}
      onUpdateAddDraft={(value: string) => props.controller.updateAddDraft(value)}
      onConfirmAdd={() => props.controller.confirmAdd()}
      onCancelAdd={() => props.controller.cancelAdd()}
      onRemoveEntry={(index: number) => props.controller.removeEntry(index)}
      onSave={() => void props.controller.save()}
    />
  );
}
