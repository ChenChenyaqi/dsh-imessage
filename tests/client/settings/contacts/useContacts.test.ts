// useContacts 规格：基准 = saved.contacts（宿主推送自动跟随）+ 行集派生
// + 行内编辑覆盖（draft wins）。

// @vitest-environment jsdom
import { createElement } from 'react';

import { describe, expect, it } from 'vitest';

import { settingsMessages } from '@/client/i18n/text';
import { CardProvider, type CardContextValue } from '@/client/settings/card-context';
import { createDraftStore, type DraftStore } from '@/client/settings/draft-store';
import type { SavedBaseline } from '@/client/settings/useCardForm';
import { useContacts } from '@/client/settings/contacts/useContacts';
import { act, renderHook } from '../../../helpers/render-hook';

const MESSAGES = settingsMessages.zh;
const PHONE = '+8613800000000';

function mount(
  options: {
    saved?: Partial<SavedBaseline>;
    store?: DraftStore;
  } = {},
) {
  const store = options.store ?? createDraftStore();
  let value: CardContextValue = {
    store,
    saved: { locale: 'zh', allowlist: [], ...options.saved },
    mutate: async () => true,
    messages: MESSAGES,
  };
  const rendered = renderHook(() => useContacts(), {
    wrapper: ({ children }) => createElement(CardProvider, { value }, children),
  });
  const push = (next: Partial<SavedBaseline>) => {
    value = { ...value, saved: { locale: 'zh', allowlist: [], ...options.saved, ...next } };
    rendered.rerender();
  };
  return { ...rendered, push, store };
}

describe('useContacts · baseline', () => {
  it('follows saved.contacts when unedited', () => {
    const { result } = mount({ saved: { allowlist: [PHONE], contacts: { [PHONE]: '小陈' } } });
    expect(result.current.rows).toEqual([{ handle: PHONE, value: '小陈' }]);
    expect(result.current.dirty).toBe(false);
  });

  it('rows union the allowlist draft with baseline-only keys (ascending)', () => {
    const { result } = mount({
      saved: { allowlist: [PHONE], contacts: { '+8613900000000': '阿九' } },
    });
    expect(result.current.rows.map((r) => r.handle)).toEqual([PHONE, '+8613900000000']);
  });

  it('host push updates the baseline and the rows follow (unedited)', () => {
    const { result, push } = mount({ saved: { allowlist: [PHONE] } });
    expect(result.current.rows).toEqual([{ handle: PHONE, value: '' }]);

    push({ contacts: { [PHONE]: '小陈' } });
    expect(result.current.rows).toEqual([{ handle: PHONE, value: '小陈' }]);
    expect(result.current.dirty).toBe(false);
  });
});

describe('useContacts · inline editing', () => {
  it('edits a name into a dirty draft (draft wins over the baseline)', () => {
    const { result, push } = mount({
      saved: { allowlist: [PHONE], contacts: { [PHONE]: '小陈' } },
    });

    act(() => result.current.setPeerName(PHONE, '陈工'));
    expect(result.current.names).toEqual({ [PHONE]: '陈工' });
    expect(result.current.dirty).toBe(true);

    // 宿主推送同字段不冲掉草稿（draft wins，同 useAllowlist 锁定语义）
    push({ contacts: { [PHONE]: '小陈' } });
    expect(result.current.names).toEqual({ [PHONE]: '陈工' });
  });

  it('clearing the input is dirty (empty = remove)', () => {
    const { result } = mount({ saved: { allowlist: [PHONE], contacts: { [PHONE]: '小陈' } } });
    act(() => result.current.setPeerName(PHONE, '  '));
    expect(result.current.names).toEqual({});
    expect(result.current.dirty).toBe(true);
  });
});
