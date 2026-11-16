// 卡片子组件的 jsdom 渲染 helper（方案 D）：Provider 包裹 + 可推送 rerender。
//
// 用法：
//   const view = renderCard(<LocaleSelect />);
//   view.container.querySelector('select')!  // 原生 DOM 断言
//   view.rerender({ saved: { locale: 'en' } });  // 模拟宿主推送

import { act } from 'react';
import { createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { settingsMessages } from '../../src/client/i18n/text';
import { CardProvider, type CardContextValue } from '../../src/client/settings/card-context';
import { createDraftStore } from '../../src/client/settings/draft-store';
import type { PresetRemote } from '../../src/client/settings/preset/logic';
import type { FieldOp, SavedBaseline } from '../../src/client/settings/useCardForm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export type CardMessages = (typeof settingsMessages)['zh'];

export interface RenderCardOptions {
  saved?: Partial<SavedBaseline>;
  mutate?: (ops: readonly FieldOp[]) => Promise<boolean>;
  messages?: CardMessages;
  /** Agent presets 的 remote 通道（preset 域拉 roster 用）。 */
  remote?: PresetRemote;
}

export interface RenderCardResult {
  readonly container: HTMLElement;
  readonly store: ReturnType<typeof createDraftStore>;
  /** 换 context 输入（宿主推送 = 换 saved）后重渲染。 */
  rerender(next?: RenderCardOptions): void;
  unmount(): void;
}

function makeValue(store: RenderCardResult['store'], options: RenderCardOptions): CardContextValue {
  return {
    store,
    saved: { locale: 'zh', allowlist: [], ...options.saved },
    mutate: options.mutate ?? (async () => true),
    messages: options.messages ?? settingsMessages.zh,
    remote: options.remote,
  };
}

/**
 * 在卡片 context 内渲染子组件。
 * @param ui - 子组件元素。
 * @param options - saved 基准 / mutate / 词条的初始值。
 * @returns 容器、store 与重渲染面。
 */
export function renderCard(ui: ReactElement, options: RenderCardOptions = {}): RenderCardResult {
  const container = document.createElement('div');
  let root: Root | null = createRoot(container);
  const store = createDraftStore();
  let current = options;

  const tree = () => createElement(CardProvider, { value: makeValue(store, current) }, ui);

  act(() => {
    root!.render(tree());
  });

  return {
    container,
    store,
    rerender(next?: RenderCardOptions) {
      if (next) current = { ...current, ...next };
      act(() => {
        root!.render(tree());
      });
    },
    unmount() {
      act(() => {
        root?.unmount();
        root = null;
      });
    },
  };
}

/** 用原型 setter 写值，绕过 React 的 value tracker（否则 onChange 不触发）。 */
function setNativeValue(target: HTMLElement, value: string): void {
  const proto =
    target instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(target, value);
}

/** 触发原生 change 事件（select：React 合成 onChange 监听 change，需冒泡）。 */
export function fireChange(target: HTMLElement, value: string): void {
  act(() => {
    setNativeValue(target, value);
    target.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** 触发原生 input 事件（text input 的 onChange 监听 input，需冒泡）。 */
export function fireInput(target: HTMLElement, value: string): void {
  act(() => {
    setNativeValue(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** 触发原生 click 事件（按钮/复选框）。 */
export function fireClick(target: HTMLElement): void {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** 触发原生 keydown（Enter/Escape 确认/取消）。 */
export function fireKeydown(target: HTMLElement, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

export { act };
