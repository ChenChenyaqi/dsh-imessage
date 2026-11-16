// 语言域纯函数规格（从 card.test 迁移；测试先行）。

import { describe, expect, it } from 'vitest';

import { LOCALE_OPTIONS, readLocale } from '@/client/settings/locale/logic';

describe('locale logic', () => {
  it('narrows an en locale and falls back to zh', () => {
    expect(readLocale({ value: { locale: 'en' } })).toBe('en');
    expect(readLocale({ value: { locale: 'fr' } })).toBe('zh');
    expect(readLocale({})).toBe('zh');
  });

  it('offers exactly the locales the host schema accepts', () => {
    expect(LOCALE_OPTIONS).toEqual(['zh', 'en']);
  });
});
