// useAllowlist 规格（方案 D：context 自取 + store 订阅）。
//
// 锁定语义（从 controller 时代迁移）：同字段宿主推送时 dirty 草稿赢。

// @vitest-environment jsdom
import { createElement } from 'react';

import { describe, expect, it } from 'vitest';

import { settingsMessages } from '@/client/i18n/text';
import { CardProvider, type CardContextValue } from '@/client/settings/card-context';
import { createDraftStore, type DraftStore } from '@/client/settings/draft-store';
import type { SavedBaseline } from '@/client/settings/useCardForm';
import { useAllowlist } from '@/client/settings/allowlist/useAllowlist';
import { act, renderHook } from '../../../helpers/render-hook';

const MESSAGES = settingsMessages.zh;
const PHONE = '+8613800000000';
const PHONE_2 = '+8613900000000';

function mount(saved: Partial<SavedBaseline>, store: DraftStore = createDraftStore()) {
  let value: CardContextValue = {
    store,
    saved: { locale: 'zh', allowlist: [], ...saved },
    mutate: async () => true,
    messages: MESSAGES,
  };
  const rendered = renderHook(() => useAllowlist(), {
    wrapper: ({ children }) => createElement(CardProvider, { value }, children),
  });
  /** 模拟宿主推送：换 saved 基准重渲染。 */
  const push = (next: Partial<SavedBaseline>) => {
    value = { ...value, saved: { locale: 'zh', allowlist: [], ...saved, ...next } };
    rendered.rerender();
  };
  return { ...rendered, push, store };
}

describe('useAllowlist · override semantics', () => {
  it('follows the saved baseline across host pushes while unedited', () => {
    const { result, push } = mount({ allowlist: [PHONE] });
    expect(result.current.draft).toEqual([PHONE]);

    push({ allowlist: [PHONE, PHONE_2] });
    expect(result.current.draft).toEqual([PHONE, PHONE_2]);
    expect(result.current.dirty).toBe(false);
  });

  it('keeps a dirty draft when the host pushes that same field (draft wins)', () => {
    const { result, push } = mount({ allowlist: [PHONE] });

    act(() => result.current.removeEntry(0));
    expect(result.current.dirty).toBe(true);

    // 宿主（或别处）推送同字段：dirty 草稿不被冲掉
    push({ allowlist: [PHONE, PHONE_2] });
    expect(result.current.draft).toEqual([]);
    expect(result.current.dirty).toBe(true);
  });

  it('converges back to clean once the host catch-up push arrives', () => {
    const { result, push } = mount({ allowlist: [PHONE] });

    act(() => result.current.beginAdd());
    act(() => result.current.updateAddDraft(PHONE_2));
    act(() => result.current.confirmAdd());
    expect(result.current.dirty).toBe(true);

    push({ allowlist: [PHONE, PHONE_2] });
    expect(result.current.draft).toEqual([PHONE, PHONE_2]);
    expect(result.current.dirty).toBe(false);
  });
});

describe('useAllowlist · add entry row', () => {
  it('confirms a valid number into the draft and closes the row', () => {
    const { result } = mount({ allowlist: [PHONE] });

    act(() => result.current.beginAdd());
    act(() => result.current.updateAddDraft(PHONE_2));
    act(() => result.current.confirmAdd());

    expect(result.current.draft).toEqual([PHONE, PHONE_2]);
    expect(result.current.adding).toEqual({ active: false, input: '', error: null });
  });

  it('treats confirming an empty draft as cancel (row closes, no error)', () => {
    const { result } = mount({ allowlist: [] });

    act(() => result.current.beginAdd());
    act(() => result.current.confirmAdd());

    expect(result.current.adding.active).toBe(false);
    expect(result.current.draft).toEqual([]);
  });

  it('keeps the row open with the error when the input is invalid', () => {
    const { result } = mount({ allowlist: [] });

    act(() => result.current.beginAdd());
    act(() => result.current.updateAddDraft('not-a-number'));
    act(() => result.current.confirmAdd());

    expect(result.current.adding).toEqual({
      active: true,
      input: 'not-a-number',
      error: 'invalid',
    });
    expect(result.current.draft).toEqual([]);
  });

  it('flags duplicates and blocks adding them', () => {
    const { result } = mount({ allowlist: [PHONE] });

    act(() => result.current.beginAdd());
    act(() => result.current.updateAddDraft(PHONE));
    act(() => result.current.confirmAdd());

    expect(result.current.adding.error).toBe('duplicate');
    expect(result.current.addPending).toBe(true);
    expect(result.current.draft).toEqual([PHONE]);
  });

  it('discards the row on cancel', () => {
    const { result } = mount({ allowlist: [] });

    act(() => result.current.beginAdd());
    act(() => result.current.updateAddDraft(PHONE));
    act(() => result.current.cancelAdd());

    expect(result.current.adding.active).toBe(false);
    expect(result.current.draft).toEqual([]);
  });

  it('ignores add-row actions while the row is closed (defensive)', () => {
    const { result, store } = mount({ allowlist: [PHONE] });

    // 收起态直调（组件层不会触发，hook 契约保证无操作）
    act(() => result.current.updateAddDraft('+8613800000001'));
    act(() => result.current.confirmAdd());

    expect(result.current.draft).toEqual([PHONE]);
    expect(store.getSnapshot().adding).toBeUndefined();
  });
});

describe('useAllowlist · derived flags', () => {
  it('warns about an empty allowlist (allow-all = reject-all)', () => {
    const { result } = mount({ allowlist: [] });
    expect(result.current.warning).toBe('empty');
  });

  it('ignores out-of-range removals', () => {
    const { result, store } = mount({ allowlist: [PHONE] });

    act(() => result.current.removeEntry(5));
    expect(store.getSnapshot().allowlist).toBeUndefined();
  });
});
