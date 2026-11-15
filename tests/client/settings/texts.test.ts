// 界面词条规格：两种语言必须成对，缺一个就会回退串味。
//
// 文案只覆盖设置卡片自己的界面文字；产品名 iMessage 不翻译。

import { describe, expect, it } from 'vitest';

import { settingsMessages, settingsTexts } from '@/client/settings/texts';

describe('settings texts · dictionaries', () => {
  it('carries the same keys in every locale', () => {
    expect(Object.keys(settingsMessages.zh).sort()).toEqual(
      Object.keys(settingsMessages.en).sort(),
    );
  });

  it('has no empty string in either locale', () => {
    for (const [locale, table] of Object.entries(settingsMessages)) {
      for (const [key, value] of Object.entries(table)) {
        expect(`${locale}.${key}=${value}`).not.toMatch(/=$/u);
      }
    }
  });
});

describe('settings texts · lookup', () => {
  it('serves the requested locale', () => {
    expect(settingsTexts('zh').save).toBe('保存');
    expect(settingsTexts('en').save).toBe('Save');
  });

  it('falls back to zh for unknown or missing locales', () => {
    // 与 core i18n / apply 的收窄方向一致：只认 'en'，其余一律 zh
    expect(settingsTexts('fr').save).toBe('保存');
    expect(settingsTexts(undefined).save).toBe('保存');
  });

  it('returns a detached copy (callers may not mutate the dictionary)', () => {
    const texts = settingsTexts('en');

    texts.save = 'mutated';

    expect(settingsMessages.en.save).toBe('Save');
  });
});
