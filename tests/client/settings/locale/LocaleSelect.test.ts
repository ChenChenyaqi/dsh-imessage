// 语言下拉规格（方案 D：jsdom 渲染断言；词条与状态从卡片 context 自取）。

// @vitest-environment jsdom
import { createElement } from 'react';

import { describe, expect, it } from 'vitest';

import { LocaleSelect } from '@/client/settings/locale/LocaleSelect';
import { fireChange, renderCard } from '../../../helpers/render-card';

describe('locale select', () => {
  it('renders the label, hint, and the two schema locales', () => {
    const view = renderCard(createElement(LocaleSelect));

    const select = view.container.querySelector('select');
    expect(select).not.toBeNull();
    expect(view.container.textContent).toContain('系统提示语言');
    // hint 必须在场：曾让用户误以为能控制大模型回复语言
    expect(view.container.textContent).toContain('不改变 AI 回复的语言');
    expect(Array.from(view.container.querySelectorAll('option')).map((o) => o.value)).toEqual([
      'zh',
      'en',
    ]);
    view.unmount();
  });

  it('follows the saved baseline and forwards edits into the draft store', () => {
    const view = renderCard(createElement(LocaleSelect), { saved: { locale: 'en' } });
    const select = view.container.querySelector('select')!;

    expect((select as HTMLSelectElement).value).toBe('en');

    fireChange(select, 'zh');
    expect(view.store.getSnapshot().locale).toBe('zh');

    view.unmount();
  });
});
