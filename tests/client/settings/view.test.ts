// 设置卡片组合视图规格（方案 D）：静态组合树 —— 根标记与五个域组件的布局。

// @vitest-environment jsdom
import { createElement } from 'react';

import { describe, expect, it } from 'vitest';

import { createRoot } from 'react-dom/client';

import { settingsMessages } from '@/client/i18n/text';
import { CardProvider } from '@/client/settings/card-context';
import { createDraftStore } from '@/client/settings/draft-store';
import { SettingsCardView } from '@/client/settings/view';
import { act } from '../../helpers/render-hook';

function renderView() {
  const container = document.createElement('div');
  const value = {
    store: createDraftStore(),
    saved: { locale: 'zh' as const, allowlist: [] as string[] },
    mutate: async () => true,
    messages: settingsMessages.zh,
  };
  const root = createRoot(container);
  act(() => {
    root.render(createElement(CardProvider, { value }, createElement(SettingsCardView)));
  });
  return {
    container,
    unmount() {
      act(() => root.unmount());
    },
  };
}

describe('settings card view · static composition', () => {
  it('keeps the card root marker for e2e targeting', () => {
    const view = renderView();

    expect(view.container.querySelector('[data-dsh-imessage-card]')).not.toBeNull();
    view.unmount();
  });

  it('renders the five field sections', () => {
    const view = renderView();

    // 语言/预设下拉 + 白名单添加按钮 + 分段开关 + 保存按钮
    expect(view.container.querySelectorAll('select')).toHaveLength(2);
    expect(view.container.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(view.container.querySelector('button')).not.toBeNull();
    view.unmount();
  });
});
