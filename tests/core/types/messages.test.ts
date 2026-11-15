import { describe, expect, it } from 'vitest';

import { isNormalizedMessage, makeNormalizedMessage } from '@/core/types/messages';

const base = {
  guid: 'guid-1',
  rowId: 42,
  date: 1730000000000,
  fromMe: false,
  text: '在吗',
  conversationKey: '+8613800000000',
};

describe('makeNormalizedMessage', () => {
  it('builds and freezes with minimal fields', () => {
    const msg = makeNormalizedMessage(base);
    expect(msg.guid).toBe('guid-1');
    expect(Object.isFrozen(msg)).toBe(true);
  });

  it('keeps optional quotedText', () => {
    const msg = makeNormalizedMessage({ ...base, quotedText: '引用原文' });
    expect(msg.quotedText).toBe('引用原文');
  });

  it.each([
    ['missing guid', { ...base, guid: '' }],
    ['non-integer rowId', { ...base, rowId: 1.5 }],
    ['non-boolean fromMe', { ...base, fromMe: 'no' }],
    ['non-string text', { ...base, text: 123 }],
    ['missing conversationKey', { ...base, conversationKey: '' }],
    ['wrong-typed quotedText', { ...base, quotedText: 7 }],
  ])('throws on invalid field: %s', (_name, bad) => {
    // @ts-expect-error 故意传入非法数据测试工厂的守卫
    expect(() => makeNormalizedMessage(bad)).toThrow(TypeError);
  });
});

describe('isNormalizedMessage', () => {
  it('accepts a valid message', () => {
    expect(isNormalizedMessage(makeNormalizedMessage(base))).toBe(true);
  });

  it('rejects null, arrays and missing fields', () => {
    expect(isNormalizedMessage(null)).toBe(false);
    expect(isNormalizedMessage([])).toBe(false);
    expect(isNormalizedMessage({ ...base, guid: undefined })).toBe(false);
  });
});
