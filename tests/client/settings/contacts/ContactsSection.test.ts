// ContactsSection 渲染规格：行集（号码 + 输入框）、空态、编辑回调。

// @vitest-environment jsdom
import { createElement } from 'react';

import { describe, expect, it } from 'vitest';

import { ContactsSection } from '@/client/settings/contacts/ContactsSection';
import { fireChange, renderCard } from '../../../helpers/render-card';

const MESSAGES = (await import('@/client/i18n/text')).settingsMessages.zh;
const PHONE = '+8613800000000';

describe('ContactsSection', () => {
  it('renders one input row per allowlisted number with the saved value', () => {
    const view = renderCard(createElement(ContactsSection), {
      saved: { allowlist: [PHONE], contacts: { [PHONE]: '小陈' } },
    });

    const input = view.container.querySelector('input');
    expect(input).not.toBeNull();
    expect((input as HTMLInputElement).value).toBe('小陈');
    expect(view.container.textContent).toContain(PHONE);
    expect(view.container.textContent).toContain(MESSAGES.contactsLabel);
  });

  it('shows the empty hint when there are no rows', () => {
    const view = renderCard(createElement(ContactsSection), { saved: { allowlist: [] } });

    expect(view.container.textContent).toContain(MESSAGES.contactsEmpty);
    expect(view.container.querySelector('input')).toBeNull();
  });

  it('edits bubble into the draft store (dirty follows)', () => {
    const view = renderCard(createElement(ContactsSection), {
      saved: { allowlist: [PHONE], contacts: {} },
    });

    const input = view.container.querySelector('input') as HTMLInputElement;
    fireChange(input, '小陈');
    expect((view.container.querySelector('input') as HTMLInputElement).value).toBe('小陈');
    // 草稿落进 store（保存聚合据此判 dirty）
    expect(view.store.getSnapshot().peerNames).toEqual({ [PHONE]: '小陈' });
  });
});
