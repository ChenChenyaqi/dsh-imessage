// 界面词条规格：两种语言必须成对，缺一个就会回退串味。
//
// 文案只覆盖设置卡片自己的界面文字；产品名 iMessage 不翻译。

import { describe, expect, it } from 'vitest';

import { settingsMessages } from '@/client/i18n/text';

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
