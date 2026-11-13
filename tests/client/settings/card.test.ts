// 设置卡片纯逻辑规格（Step 2，测试先行）。
//
// controller 不碰 React：白名单条目数组、新增行校验、删除、dirty 判定、
// 提交全在这里。网络/表单边界由注入的 FormWriter 扮演。
//
// 白名单交互（方案 A）：平时没有输入框，只有「添加号码」按钮；点开才
// 出现一行输入；校验不过（格式错 / 重复）不允许加，也不允许保存。

import { describe, expect, it } from 'vitest';

import {
  LOCALE_OPTIONS,
  beginAdd,
  beginSave,
  cancelAdd,
  confirmAdd,
  formatAllowlist,
  initialState,
  parseAllowlist,
  readAllowlist,
  readLocale,
  removeEntry,
  save,
  saveFailed,
  saveSucceeded,
  setChunkedDraft,
  setDelayFactorDraft,
  setLocaleDraft,
  setMaxChunksDraft,
  updateAddDraft,
} from '@/client/settings/card';

const TEXT = { saveFailed: 'save failed' };
const PHONE = '+8613800000000';
const PHONE_2 = '+8613900000000';

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

describe('settings card · allowlist entries', () => {
  it('parses saved values into entries for chip rendering', () => {
    const entries = parseAllowlist([`  ${PHONE}  `, PHONE_2]);

    expect(entries.map((entry) => entry.raw)).toEqual([PHONE, PHONE_2]);
    expect(entries.every((entry) => entry.key !== null)).toBe(true);
  });

  it('marks unparseable entries instead of dropping them', () => {
    // 手改配置文件可能塞进非法条目：界面要能标红，而不是静默吞掉
    const entries = parseAllowlist([PHONE, '123']);

    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({ raw: '123', key: null });
  });

  it('formats saved values back into the host shape', () => {
    expect(formatAllowlist([PHONE, PHONE_2])).toEqual([PHONE, PHONE_2]);
  });
});

describe('settings card · reading the host snapshot', () => {
  it('narrows an en locale and falls back to zh', () => {
    expect(readLocale({ value: { locale: 'en' } })).toBe('en');
    expect(readLocale({ value: { locale: 'fr' } })).toBe('zh');
    expect(readLocale({})).toBe('zh');
  });

  it('reads a string allowlist and ignores anything else', () => {
    expect(readAllowlist({ value: { allowlist: [PHONE, 42, null] } })).toEqual([PHONE]);
    expect(readAllowlist({ value: { allowlist: 'nope' } })).toEqual([]);
  });
});

describe('settings card · initial state', () => {
  it('starts ready, clean, and unsavable', () => {
    const state = initialState({ value: { locale: 'zh', allowlist: [PHONE] } });

    expect(state.ready).toBe(true);
    expect(state.allowlist).toEqual({ draft: [PHONE], dirty: false });
    expect(state.adding).toEqual({ active: false, input: '', error: null });
    expect(state.canSave).toBe(false);
  });

  it('warns when the allowlist is empty (empty = deny everyone)', () => {
    const state = initialState({ value: {} });

    expect(state.warning).toBe('empty');
  });

  it('offers exactly the locales the host schema accepts', () => {
    expect(LOCALE_OPTIONS).toEqual(['zh', 'en']);
  });
});

describe('settings card · add entry', () => {
  it('opens an empty add row on demand', () => {
    const next = beginAdd(initialState({ value: { locale: 'zh', allowlist: [PHONE] } }));

    expect(next.adding).toEqual({ active: true, input: '', error: null });
  });

  it('validates the draft while typing', () => {
    const base = beginAdd(initialState({ value: { locale: 'zh', allowlist: [PHONE] } }));

    // 空输入不算错（用户还没开始写）
    expect(updateAddDraft(base, '').adding.error).toBeNull();
    expect(updateAddDraft(base, PHONE_2).adding.error).toBeNull();
    // 格式非法：裸号码、位数超界
    expect(updateAddDraft(base, '123').adding.error).toBe('invalid');
    expect(updateAddDraft(base, '+8612345678901234567890').adding.error).toBe('invalid');
    // 与已有条目重复（按归一化键比较，写法不同也算重）
    expect(updateAddDraft(base, ` ${PHONE} `).adding.error).toBe('duplicate');
  });

  it('blocks saving while an invalid draft is pending', () => {
    const state = setLocaleDraft(initialState({ value: { locale: 'zh', allowlist: [PHONE] } }), 'en', saved);
    // 语言已改、本可保存；新增行里有非法输入时必须拦住
    const invalid = updateAddDraft(beginAdd(state), 'not-a-number');

    expect(invalid.canSave).toBe(false);
    // 修好（或清空）后恢复可保存
    expect(updateAddDraft(invalid, '').canSave).toBe(true);
  });

  it('appends a valid number and closes the add row', () => {
    const next = confirmAdd(
      updateAddDraft(beginAdd(initialState({ value: { locale: 'zh', allowlist: [PHONE] } })), PHONE_2),
      saved,
    );

    expect(next.allowlist.draft).toEqual([PHONE, PHONE_2]);
    expect(next.allowlist.dirty).toBe(true);
    expect(next.canSave).toBe(true);
    expect(next.adding.active).toBe(false);
  });

  it('rejects an invalid number without touching the list', () => {
    const next = confirmAdd(
      updateAddDraft(beginAdd(initialState({ value: { locale: 'zh', allowlist: [PHONE] } })), 'not-a-number'),
      saved,
    );

    expect(next.allowlist.draft).toEqual([PHONE]);
    expect(next.allowlist.dirty).toBe(false);
    expect(next.canSave).toBe(false);
    expect(next.adding.error).toBe('invalid');
    // 行保持打开，输入保留，用户改完再试
    expect(next.adding.active).toBe(true);
    expect(next.adding.input).toBe('not-a-number');
  });

  it('rejects a duplicate number', () => {
    const next = confirmAdd(
      updateAddDraft(beginAdd(initialState({ value: { locale: 'zh', allowlist: [PHONE] } })), ` ${PHONE} `),
      saved,
    );

    expect(next.allowlist.draft).toEqual([PHONE]);
    expect(next.adding.error).toBe('duplicate');
    expect(next.canSave).toBe(false);
  });

  it('treats confirming an empty draft as cancel', () => {
    const next = confirmAdd(beginAdd(initialState({ value: { locale: 'zh', allowlist: [PHONE] } })), saved);

    expect(next.adding.active).toBe(false);
    expect(next.allowlist.draft).toEqual([PHONE]);
  });

  it('closes and clears the add row on cancel', () => {
    const next = cancelAdd(
      updateAddDraft(beginAdd(initialState({ value: { locale: 'zh', allowlist: [PHONE] } })), 'not-a-number'),
    );

    expect(next.adding).toEqual({ active: false, input: '', error: null });
  });

  it('tracks locale changes independently of the allowlist', () => {
    const next = setLocaleDraft(initialState({ value: { locale: 'zh', allowlist: [PHONE] } }), 'en', saved);

    expect(next.locale.dirty).toBe(true);
    expect(next.allowlist.dirty).toBe(false);
    expect(next.canSave).toBe(true);
  });
});

describe('settings card · remove entry', () => {
  it('removes the entry at the index and becomes savable', () => {
    const state = initialState({ value: { locale: 'zh', allowlist: [PHONE, PHONE_2] } });

    const next = removeEntry(state, 0, saved);

    expect(next.allowlist.draft).toEqual([PHONE_2]);
    expect(next.allowlist.dirty).toBe(true);
    expect(next.canSave).toBe(true);
  });

  it('removing the last entry warns but stays savable', () => {
    // 空白名单 = 全拒是合法但危险的状态：提示归提示，保存归保存
    const next = removeEntry(initialState({ value: { locale: 'zh', allowlist: [PHONE] } }), 0, saved);

    expect(next.allowlist.draft).toEqual([]);
    expect(next.warning).toBe('empty');
    expect(next.canSave).toBe(true);
  });

  it('ignores out-of-range indexes instead of crashing', () => {
    const state = initialState({ value: { locale: 'zh', allowlist: [PHONE] } });

    expect(removeEntry(state, 5, saved).allowlist.draft).toEqual([PHONE]);
    expect(removeEntry(state, -1, saved).allowlist.dirty).toBe(false);
  });

  it('does not resurrect a cancelled add row on host updates', () => {
    // 宿主热更推送（保存成功回调）后，新增行必须是收起状态
    const reopened = beginAdd(initialState({ value: { locale: 'zh', allowlist: [PHONE] } }));
    const saved2 = saveSucceeded(reopened, { value: { locale: 'zh', allowlist: [PHONE] } });

    expect(saved2.adding.active).toBe(false);
  });
});

describe('settings card · chunked replies', () => {
  it('defaults the style fields from the host snapshot', () => {
    const state = initialState({ value: { locale: 'zh', allowlist: [PHONE] } });

    expect(state.chunked).toEqual({ draft: false, dirty: false });
    expect(state.maxChunks.draft).toBe('8');
    expect(state.delayFactor.draft).toBe('1');
    expect(state.maxChunksError).toBe(false);
    expect(state.delayFactorError).toBe(false);
  });

  it('reads configured values back', () => {
    const state = initialState({
      value: { locale: 'zh', allowlist: [PHONE], chunkedReplies: true, maxChunks: 3, delayFactor: 0 },
    });

    expect(state.chunked.draft).toBe(true);
    expect(state.maxChunks.draft).toBe('3');
    expect(state.delayFactor.draft).toBe('0');
  });

  it('toggling on marks dirty and becomes savable', () => {
    const state = initialState({ value: { locale: 'zh', allowlist: [PHONE] } });

    const next = setChunkedDraft(state, true, saved);

    expect(next.chunked.dirty).toBe(true);
    expect(next.canSave).toBe(true);
  });

  it('rejects invalid maxChunks drafts while chunking is on', () => {
    // 1..50 的整数才合法：0 / 负数 / 小数 / 非数字都不行
    const base = setChunkedDraft(initialState({ value: { locale: 'zh', allowlist: [PHONE] } }), true, saved);
    for (const bad of ['0', '-1', '2.5', 'abc', '']) {
      expect(setMaxChunksDraft(base, bad, saved).maxChunksError).toBe(true);
    }
    // 合法边界
    expect(setMaxChunksDraft(base, '1', saved).maxChunksError).toBe(false);
    expect(setMaxChunksDraft(base, '50', saved).maxChunksError).toBe(false);
  });

  it('rejects invalid delayFactor drafts while chunking is on', () => {
    // 0..5 的数字（小数可以）；0 = 分段不延时
    const base = setChunkedDraft(initialState({ value: { locale: 'zh', allowlist: [PHONE] } }), true, saved);
    for (const bad of ['-0.1', '5.5', 'abc', '']) {
      expect(setDelayFactorDraft(base, bad, saved).delayFactorError).toBe(true);
    }
    expect(setDelayFactorDraft(base, '0', saved).delayFactorError).toBe(false);
    expect(setDelayFactorDraft(base, '2.5', saved).delayFactorError).toBe(false);
    expect(setDelayFactorDraft(base, '5', saved).delayFactorError).toBe(false);
  });

  it('blocks saving while a style field is invalid', () => {
    const base = setChunkedDraft(initialState({ value: { locale: 'zh', allowlist: [PHONE] } }), true, saved);
    const invalid = setMaxChunksDraft(base, 'abc', saved);

    expect(invalid.canSave).toBe(false);
    expect(setMaxChunksDraft(invalid, '8', saved).canSave).toBe(true);
  });

  it('clears style errors when chunking is toggled off', () => {
    // 开关关掉后子输入不可见，残留的校验错误必须清掉（否则保存被永久卡死）
    const base = setChunkedDraft(initialState({ value: { locale: 'zh', allowlist: [PHONE] } }), true, saved);
    const invalid = setMaxChunksDraft(base, 'abc', saved);

    const off = setChunkedDraft(invalid, false, saved);

    expect(off.maxChunksError).toBe(false);
    expect(off.delayFactorError).toBe(false);
    // 关回原值 = 不再 dirty
    expect(off.chunked.dirty).toBe(false);
    expect(off.canSave).toBe(false);
  });

  it('does not validate number fields while chunking is off', () => {
    // 关着的时候草稿里是什么都无所谓（输入框都不可见）
    const state = setMaxChunksDraft(initialState({ value: { locale: 'zh', allowlist: [PHONE] } }), 'abc', saved);

    expect(state.maxChunksError).toBe(false);
  });

  it('save writes all three style fields in one mutation', async () => {
    const { form, calls } = makeForm(true);
    const state = setDelayFactorDraft(
      setMaxChunksDraft(
        setChunkedDraft(initialState({ value: { locale: 'zh', allowlist: [PHONE] } }), true, saved),
        '5',
        saved,
      ),
      '0',
      saved,
    );

    await save(
      { form, texts: TEXT, readSnapshot: () => ({}) },
      state,
      saved,
    );

    expect(calls[0]).toContainEqual({ op: 'set', path: ['chunkedReplies'], value: true });
    expect(calls[0]).toContainEqual({ op: 'set', path: ['maxChunks'], value: 5 });
    expect(calls[0]).toContainEqual({ op: 'set', path: ['delayFactor'], value: 0 });
  });

  it('refuses to write while a style field is invalid', async () => {
    const { form, calls } = makeForm(true);
    const state = setMaxChunksDraft(
      setChunkedDraft(initialState({ value: { locale: 'zh', allowlist: [PHONE] } }), true, saved),
      'abc',
      saved,
    );

    await save({ form, texts: TEXT, readSnapshot: () => ({}) }, state, saved);

    expect(calls).toHaveLength(0);
  });
});

describe('settings card · saving', () => {
  it('writes locale and allowlist in one atomic mutation', async () => {
    const { form, calls } = makeForm(true);
    const state = confirmAdd(
      updateAddDraft(beginAdd(initialState({ value: { locale: 'zh', allowlist: [PHONE] } })), PHONE_2),
      saved,
    );

    const next = await save(
      { form, texts: TEXT, readSnapshot: () => ({ value: { locale: 'zh', allowlist: [PHONE, PHONE_2] } }) },
      state,
      saved,
    );

    // 一次提交两个字段：避免"语言存了、白名单没存"的半保存
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      { op: 'set', path: ['locale'], value: 'zh' },
      { op: 'set', path: ['allowlist'], value: [PHONE, PHONE_2] },
      { op: 'set', path: ['chunkedReplies'], value: false },
      { op: 'set', path: ['maxChunks'], value: 8 },
      { op: 'set', path: ['delayFactor'], value: 1 },
    ]);
    // 成功后以新快照为准：dirty 归零、错误清空
    expect(next.allowlist.dirty).toBe(false);
    expect(next.error).toBeNull();
    expect(next.saving).toBe(false);
  });

  it('keeps the draft and reports an error when the host rejects', async () => {
    const { form } = makeForm(false);
    const state = removeEntry(initialState({ value: { locale: 'zh', allowlist: [PHONE, PHONE_2] } }), 0, saved);

    const next = await save({ form, texts: TEXT, readSnapshot: () => ({}) }, state, saved);

    expect(next.error).toBe('save failed');
    expect(next.saving).toBe(false);
    expect(next.allowlist.draft).toEqual([PHONE_2]);
  });

  it('treats a thrown write as a failure instead of crashing', async () => {
    const { form } = makeForm(new Error('rpc down'));
    const state = removeEntry(initialState({ value: { locale: 'zh', allowlist: [PHONE, PHONE_2] } }), 0, saved);

    const next = await save({ form, texts: TEXT, readSnapshot: () => ({}) }, state, saved);

    expect(next.error).toBe('save failed');
    expect(next.saving).toBe(false);
  });

  it('refuses to write while an add draft is invalid', async () => {
    const { form, calls } = makeForm(true);
    const state = updateAddDraft(beginAdd(initialState({ value: { locale: 'zh', allowlist: [PHONE] } })), 'not-a-number');

    const next = await save({ form, texts: TEXT, readSnapshot: () => ({}) }, state, saved);

    // 入口自保：校验不过的输入一个字节都不写出去
    expect(calls).toHaveLength(0);
    expect(next.error).toBeNull();
  });
});

describe('settings card · transitions', () => {
  it('disables saving while a write is in flight', () => {
    const state = removeEntry(initialState({ value: { locale: 'zh', allowlist: [PHONE, PHONE_2] } }), 0, saved);

    const next = beginSave(state);

    expect(next.saving).toBe(true);
    expect(next.canSave).toBe(false);
  });

  it('resets to the host snapshot on success', () => {
    const next = saveSucceeded(initialState({ value: {} }), {
      value: { locale: 'en', allowlist: [PHONE] },
    });

    expect(next.locale.draft).toBe('en');
    expect(next.allowlist.draft).toEqual([PHONE]);
    expect(next.canSave).toBe(false);
  });

  it('recomputes savability after a failure so the user can retry', () => {
    const dirty = removeEntry(initialState({ value: { locale: 'zh', allowlist: [PHONE, PHONE_2] } }), 0, saved);

    const next = saveFailed(beginSave(dirty), TEXT, saved);

    expect(next.error).toBe('save failed');
    expect(next.canSave).toBe(true);
  });
});
