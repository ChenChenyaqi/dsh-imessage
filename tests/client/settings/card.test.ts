// 设置卡片纯逻辑规格（Step 2，测试先行）。
//
// controller 不碰 React：白名单文本 ↔ 数组、语言选项、dirty 判定、
// 校验、提交全在这里。网络/表单边界由注入的 FormWriter 扮演。

import { describe, expect, it } from 'vitest';

import {
  LOCALE_OPTIONS,
  beginSave,
  formatAllowlist,
  initialState,
  parseAllowlist,
  readAllowlist,
  readLocale,
  save,
  saveFailed,
  saveSucceeded,
  setAllowlistDraft,
  setLocaleDraft,
} from '@/client/settings/card';

const TEXT = { saveFailed: 'save failed' };
const PHONE = '+8613800000000';

/** 记录 mutate 调用的 fake 表单。 */
function makeForm(result: boolean | Error = true) {
  const calls: Array<readonly { op: string; path: readonly string[]; value?: unknown }[]> = [];
  return {
    calls,
    form: {
      async mutate(ops: readonly { op: string; path: readonly string[]; value?: unknown }[]) {
        calls.push(ops);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

/** 已保存基准（多数用例用它）。 */
const saved = { locale: 'zh' as const, allowlist: [PHONE] };

describe('settings card · allowlist text', () => {
  it('parses one entry per line, trimming and skipping blanks', () => {
    const entries = parseAllowlist(`  ${PHONE}  \n\n  +8613900000000\n`);

    expect(entries.map((entry) => entry.raw)).toEqual([PHONE, '+8613900000000']);
    expect(entries.every((entry) => entry.key !== null)).toBe(true);
  });

  it('marks unparseable entries instead of dropping them', () => {
    // 界面要能逐行标红，而不是静默吞掉用户的输入
    const entries = parseAllowlist(`${PHONE}\n123`);

    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({ raw: '123', key: null });
  });

  it('formats saved values back into one line per entry', () => {
    expect(formatAllowlist([PHONE, '+8613900000000'])).toBe(`${PHONE}\n+8613900000000`);
    expect(formatAllowlist([])).toBe('');
  });
});

describe('settings card · reading the host snapshot', () => {
  it('narrows an en locale and falls back to zh', () => {
    expect(readLocale({ value: { locale: 'en' } })).toBe('en');
    expect(readLocale({ value: { locale: 'fr' } })).toBe('zh');
    expect(readLocale({ value: {} })).toBe('zh');
    expect(readLocale({})).toBe('zh');
  });

  it('reads a string allowlist and ignores anything else', () => {
    expect(readAllowlist({ value: { allowlist: [PHONE, 42] } })).toEqual([PHONE]);
    expect(readAllowlist({ value: { allowlist: 'nope' } })).toEqual([]);
    expect(readAllowlist({})).toEqual([]);
  });
});

describe('settings card · initial state', () => {
  it('starts ready, clean, and unsavable', () => {
    const state = initialState({ value: { locale: 'zh', allowlist: [PHONE] } });

    expect(state.ready).toBe(true);
    expect(state.locale).toEqual({ draft: 'zh', dirty: false });
    expect(state.allowlist.draft).toBe(PHONE);
    expect(state.canSave).toBe(false);
    expect(state.saving).toBe(false);
    expect(state.error).toBeNull();
  });

  it('warns when the allowlist is empty (empty = deny everyone)', () => {
    const state = initialState({ value: { locale: 'zh', allowlist: [] } });

    expect(state.warning).toBe('empty');
  });

  it('offers exactly the locales the host schema accepts', () => {
    expect(LOCALE_OPTIONS).toEqual(['zh', 'en']);
  });
});

describe('settings card · drafts', () => {
  it('becomes savable after a real allowlist change', () => {
    const state = initialState({ value: { locale: 'zh', allowlist: [PHONE] } });

    const next = setAllowlistDraft(state, `${PHONE}\n+8613900000000`, saved);

    expect(next.allowlist.dirty).toBe(true);
    expect(next.canSave).toBe(true);
  });

  it('ignores whitespace-only edits', () => {
    // 只多加空行不该点亮保存按钮
    const state = initialState({ value: { locale: 'zh', allowlist: [PHONE] } });

    const next = setAllowlistDraft(state, `  ${PHONE}  \n\n`, saved);

    expect(next.allowlist.dirty).toBe(false);
    expect(next.canSave).toBe(false);
  });

  it('blocks saving while an entry is unparseable', () => {
    const state = initialState({ value: { locale: 'zh', allowlist: [PHONE] } });

    const next = setAllowlistDraft(state, `${PHONE}\nnot-a-number`, saved);

    expect(next.canSave).toBe(false);
    expect(next.entries.some((entry) => entry.key === null)).toBe(true);
  });

  it('tracks locale changes independently of the allowlist', () => {
    const state = initialState({ value: { locale: 'zh', allowlist: [PHONE] } });

    const next = setLocaleDraft(state, 'en', saved);

    expect(next.locale.dirty).toBe(true);
    expect(next.allowlist.dirty).toBe(false);
    expect(next.canSave).toBe(true);
  });
});

describe('settings card · saving', () => {
  it('writes locale and allowlist in one atomic mutation', async () => {
    const { form, calls } = makeForm(true);
    const state = setAllowlistDraft(
      initialState({ value: { locale: 'zh', allowlist: [PHONE] } }),
      `${PHONE}\n+8613900000000`,
      saved,
    );

    const next = await save(
      { form, texts: TEXT, readSnapshot: () => ({ value: { locale: 'zh', allowlist: [PHONE, '+8613900000000'] } }) },
      state,
      saved,
    );

    // 一次提交两个字段：避免"语言存了、白名单没存"的半保存
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      { op: 'set', path: ['locale'], value: 'zh' },
      { op: 'set', path: ['allowlist'], value: [PHONE, '+8613900000000'] },
    ]);
    // 成功后以新快照为准：dirty 归零、错误清空
    expect(next.allowlist.dirty).toBe(false);
    expect(next.error).toBeNull();
    expect(next.saving).toBe(false);
  });

  it('keeps the draft and reports an error when the host rejects', async () => {
    const { form } = makeForm(false);
    const state = setAllowlistDraft(
      initialState({ value: { locale: 'zh', allowlist: [PHONE] } }),
      '+8613900000000',
      saved,
    );

    const next = await save({ form, texts: TEXT, readSnapshot: () => ({}) }, state, saved);

    expect(next.error).toBe('save failed');
    expect(next.saving).toBe(false);
    expect(next.allowlist.draft).toBe('+8613900000000');
  });

  it('treats a thrown write as a failure instead of crashing', async () => {
    const { form } = makeForm(new Error('rpc down'));
    const state = setAllowlistDraft(
      initialState({ value: { locale: 'zh', allowlist: [PHONE] } }),
      '+8613900000000',
      saved,
    );

    const next = await save({ form, texts: TEXT, readSnapshot: () => ({}) }, state, saved);

    expect(next.error).toBe('save failed');
    expect(next.saving).toBe(false);
  });

  it('refuses to write while an entry is unparseable', async () => {
    const { form, calls } = makeForm(true);
    const state = setAllowlistDraft(
      initialState({ value: { locale: 'zh', allowlist: [PHONE] } }),
      'not-a-number',
      saved,
    );

    const next = await save({ form, texts: TEXT, readSnapshot: () => ({}) }, state, saved);

    // 入口自保：非法条目一个字节都不写出去
    expect(calls).toHaveLength(0);
    expect(next.error).toBeNull();
  });
});

describe('settings card · transitions', () => {
  it('disables saving while a write is in flight', () => {
    const state = setAllowlistDraft(
      initialState({ value: { locale: 'zh', allowlist: [PHONE] } }),
      '+8613900000000',
      saved,
    );

    const next = beginSave(state);

    expect(next.saving).toBe(true);
    expect(next.canSave).toBe(false);
  });

  it('resets to the host snapshot on success', () => {
    const next = saveSucceeded(initialState({ value: {} }), {
      value: { locale: 'en', allowlist: [PHONE] },
    });

    expect(next.locale.draft).toBe('en');
    expect(next.allowlist.draft).toBe(PHONE);
    expect(next.canSave).toBe(false);
  });

  it('recomputes savability after a failure so the user can retry', () => {
    const dirty = setAllowlistDraft(
      initialState({ value: { locale: 'zh', allowlist: [PHONE] } }),
      '+8613900000000',
      saved,
    );

    const next = saveFailed(beginSave(dirty), TEXT, saved);

    expect(next.error).toBe('save failed');
    expect(next.canSave).toBe(true);
  });
});
