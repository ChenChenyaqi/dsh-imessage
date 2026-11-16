// 语言草稿 hook 规格（方案 D：context 自取 + store 订阅）。
//
// 锁定语义：未编辑跟随宿主推送 / dirty 草稿赢 / 宿主回流后自然收敛。

// @vitest-environment jsdom
import { createElement } from 'react';

import { describe, expect, it } from 'vitest';

import { settingsMessages } from '@/client/i18n/text';
import { CardProvider, type CardContextValue } from '@/client/settings/card-context';
import { createDraftStore } from '@/client/settings/draft-store';
import type { SavedBaseline } from '@/client/settings/useCardForm';
import { useLocaleDraft } from '@/client/settings/locale/useLocaleDraft';
import { act, renderHook } from '../../../helpers/render-hook';

const MESSAGES = settingsMessages.zh;

/** 构造 context value（store 跨推送保持不变，saved 可换）。 */
function makeContext(
  store: CardContextValue['store'],
  saved: Partial<SavedBaseline>,
): CardContextValue {
  return {
    store,
    saved: { locale: 'zh', allowlist: [], ...saved },
    mutate: async () => true,
    messages: MESSAGES,
  };
}

describe('useLocaleDraft · override semantics', () => {
  it('follows the saved baseline across host pushes while unedited', () => {
    // rerender 才能看到新 value（wrapper 闭包读最新引用）
    const store = createDraftStore();
    let value = makeContext(store, { locale: 'zh' });
    const { result, rerender } = renderHook(() => useLocaleDraft(), {
      wrapper: ({ children }) => createElement(CardProvider, { value }, children),
    });

    value = makeContext(store, { locale: 'en' });
    rerender();
    expect(result.current.draft).toBe('en');
  });

  it('keeps a dirty draft when the host pushes the same field (draft wins)', () => {
    const store = createDraftStore();
    let value = makeContext(store, { locale: 'zh' });
    const { result, rerender } = renderHook(() => useLocaleDraft(), {
      wrapper: ({ children }) => createElement(CardProvider, { value }, children),
    });

    act(() => result.current.setDraft('en'));
    expect(result.current.dirty).toBe(true);

    // 宿主别处改回 zh：dirty 草稿不被冲掉（同一 store，只换 saved）
    value = makeContext(store, { locale: 'zh' });
    rerender();
    expect(result.current.draft).toBe('en');
    expect(result.current.dirty).toBe(true);
  });

  it('converges back to clean once the host catch-up push arrives', () => {
    const store = createDraftStore();
    let value = makeContext(store, { locale: 'zh' });
    const { result, rerender } = renderHook(() => useLocaleDraft(), {
      wrapper: ({ children }) => createElement(CardProvider, { value }, children),
    });

    act(() => result.current.setDraft('en'));

    // 保存成功 → 宿主写回流（saved 变成草稿值）→ dirty 自然消失
    value = makeContext(store, { locale: 'en' });
    rerender();
    expect(result.current.draft).toBe('en');
    expect(result.current.dirty).toBe(false);
  });
});
