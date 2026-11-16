// useChunkedDrafts 规格（方案 D：context 自取 + store 按字段订阅）。

// @vitest-environment jsdom
import { createElement } from 'react';

import { describe, expect, it } from 'vitest';

import { settingsMessages } from '@/client/i18n/text';
import { CardProvider, type CardContextValue } from '@/client/settings/card-context';
import { createDraftStore, type DraftStore } from '@/client/settings/draft-store';
import type { SavedBaseline } from '@/client/settings/useCardForm';
import { useChunkedDrafts } from '@/client/settings/chunked/useChunked';
import { act, renderHook } from '../../../helpers/render-hook';

const MESSAGES = settingsMessages.zh;

function mount(saved: Partial<SavedBaseline>, store: DraftStore = createDraftStore()) {
  let value: CardContextValue = {
    store,
    saved: { locale: 'zh', allowlist: [], ...saved },
    mutate: async () => true,
    messages: MESSAGES,
  };
  const rendered = renderHook(() => useChunkedDrafts(), {
    wrapper: ({ children }) => createElement(CardProvider, { value }, children),
  });
  const push = (next: Partial<SavedBaseline>) => {
    value = { ...value, saved: { locale: 'zh', allowlist: [], ...saved, ...next } };
    rendered.rerender();
  };
  return { ...rendered, push, store };
}

describe('useChunkedDrafts · override semantics', () => {
  it('derives drafts from the saved baseline with defaults', () => {
    const { result } = mount({});
    expect(result.current).toMatchObject({
      chunked: false,
      maxChunks: '8',
      delayFactor: '1',
      dirty: false,
    });
  });

  it('follows host pushes for unedited fields even after a sibling is edited', () => {
    // per-field override：编辑过 maxChunks 后，开关仍跟随宿主推送
    const { result, push } = mount({ chunkedReplies: true, maxChunks: 8 });

    act(() => result.current.setMaxChunks('12'));
    expect(result.current.dirty).toBe(true);

    push({ chunkedReplies: false });
    expect(result.current.chunked).toBe(false);
    expect(result.current.maxChunks).toBe('12');
  });

  it('marks only real edits as dirty (whitespace-tolerant numbers)', () => {
    const { result } = mount({ maxChunks: 8, delayFactor: 1, chunkedReplies: true });

    expect(result.current.dirty).toBe(false);
  });

  it('ignores sub-field edits for dirty while the switch is off', () => {
    const { result } = mount({ chunkedReplies: false, maxChunks: 8 });

    act(() => result.current.setMaxChunks('12'));
    // 开关关闭：子输入不可见，残留草稿不算改动
    expect(result.current.dirty).toBe(false);
  });

  it('reports validation errors only while the switch is on', () => {
    const { result } = mount({ chunkedReplies: true });

    act(() => result.current.setMaxChunks('garbage'));
    expect(result.current.maxChunksError).toBe(true);

    act(() => result.current.setChunked(false));
    expect(result.current.maxChunksError).toBe(false);
  });

  it('converges back to clean once the host catch-up push arrives', () => {
    const { result, push } = mount({ chunkedReplies: false });

    act(() => result.current.setChunked(true));
    expect(result.current.dirty).toBe(true);

    push({ chunkedReplies: true });
    expect(result.current.chunked).toBe(true);
    expect(result.current.dirty).toBe(false);
  });
});
