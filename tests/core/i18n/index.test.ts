import { describe, expect, it } from 'vitest';

import { LOCALES, makeT, messageKeys } from '@/core/i18n';

describe('makeT · lookup', () => {
  it('translates a key in the bound locale', () => {
    expect(makeT('zh')('common.error')).toBe('出错了，请稍后再试');
    expect(makeT('en')('common.error')).toBe('Something went wrong, please try later');
  });

  it('serves every locale in LOCALES', () => {
    for (const locale of LOCALES) {
      expect(typeof makeT(locale)('common.error')).toBe('string');
    }
  });
});

describe('makeT · interpolation', () => {
  it('fills {placeholder} values', () => {
    expect(makeT('zh')('common.unknownCommand', { command: '/foo' })).toBe(
      '不认识的命令：/foo',
    );
    expect(makeT('en')('common.unknownCommand', { command: '/foo' })).toBe(
      'Unknown command: /foo',
    );
  });

  it('accepts numbers and ignores extra params', () => {
    expect(makeT('en')('common.unknownCommand', { command: 42, unused: 'x' })).toBe(
      'Unknown command: 42',
    );
  });

  it('keeps placeholders that have no matching param', () => {
    expect(makeT('en')('common.unknownCommand', {})).toBe('Unknown command: {command}');
  });
});

describe('makeT · fallback chain', () => {
  it('returns the key itself when both locales miss', () => {
    expect(makeT('zh')('nope.nope')).toBe('nope.nope');
    expect(makeT('en')('nope.nope')).toBe('nope.nope');
  });
});

describe('dictionary integrity', () => {
  it('keeps zh and en key sets in sync (no silent missing translations)', () => {
    const keys = messageKeys();
    expect(keys.zh).toEqual(keys.en);
  });

  it('exposes a non-empty dictionary', () => {
    expect(messageKeys().zh.length).toBeGreaterThan(0);
  });
});
