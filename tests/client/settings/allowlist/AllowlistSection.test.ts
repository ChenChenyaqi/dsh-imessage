// 白名单字段规格（方案 D：jsdom 渲染；事件直接写入草稿 store）。

// @vitest-environment jsdom
import { createElement } from 'react';

import { describe, expect, it } from 'vitest';

import { AllowlistSection } from '@/client/settings/allowlist/AllowlistSection';
import { fireClick, fireInput, fireKeydown, renderCard } from '../../../helpers/render-card';

const PHONE = '+8613800000000';
const PHONE_2 = '+8613900000000';

function section(saved: readonly string[] = []) {
  return renderCard(createElement(AllowlistSection), { saved: { allowlist: saved } });
}

/** 按文案找按钮（展开态按钮顺序不固定，按文字最稳）。 */
function buttonByText(view: { readonly container: HTMLElement }, text: string): HTMLButtonElement {
  const found = Array.from(view.container.querySelectorAll('button')).find(
    (button) => button.textContent === text,
  );
  if (!found) throw new Error(`button not found: ${text}`);
  return found as HTMLButtonElement;
}

/** 打开新增行并输入。 */
function openAddRow(view: ReturnType<typeof section>, input: string): HTMLInputElement {
  fireClick(buttonByText(view, '添加号码'));
  const field = view.container.querySelector('input') as HTMLInputElement;
  fireInput(field, input);
  return field;
}

describe('allowlist section · chips', () => {
  it('renders every entry as a chip with a remove button, and no textarea', () => {
    const view = section([PHONE]);

    expect(view.container.querySelectorAll('button[aria-label="删除"]')).toHaveLength(1);
    expect(view.container.querySelector('textarea')).toBeNull();
    view.unmount();
  });

  it('removes the entry when its chip remove button is clicked', () => {
    const view = section([PHONE, PHONE_2]);

    fireClick(view.container.querySelectorAll('button[aria-label="删除"]')[0] as HTMLButtonElement);
    expect(view.store.getSnapshot().allowlist).toEqual([PHONE_2]);
    view.unmount();
  });

  it('renders hand-edited invalid entries as chips with the unparseable warning', () => {
    // 事实：Pill 不透传 style，chip 的错误色在真机本就不生效（现状），
    // 无效条目的可见反馈是下方的 invalidWarn 警示行
    const view = section(['not-a-phone']);

    expect(view.container.textContent).toContain('not-a-phone');
    expect(view.container.textContent).toContain('存在无法识别的号码');
    view.unmount();
  });

  it('warns that an empty allowlist rejects everyone', () => {
    const view = section([]);

    expect(view.container.textContent).toContain('白名单为空');
    view.unmount();
  });

  it('shows the per-field hint', () => {
    const view = section([PHONE]);

    expect(view.container.textContent).toContain('手机号需含区号');
    view.unmount();
  });
});

describe('allowlist section · add row', () => {
  it('shows only an add button when closed (no allowlist input field)', () => {
    const view = section([PHONE]);

    expect(view.container.querySelector('input')).toBeNull();
    expect(view.container.textContent).toContain('添加号码');
    view.unmount();
  });

  it('renders input, confirm and cancel while open, and hides the add button', () => {
    const view = section([]);
    fireClick(view.container.querySelector('button')!);

    expect(view.container.querySelector('input')).not.toBeNull();
    expect(view.container.textContent).toContain('添加');
    expect(view.container.textContent).not.toContain('添加号码');
    view.unmount();
  });

  it('confirms a valid number into the draft store and closes the row', () => {
    const view = section([PHONE]);
    openAddRow(view, PHONE_2);
    fireClick(buttonByText(view, '添加'));

    expect(view.store.getSnapshot().allowlist).toEqual([PHONE, PHONE_2]);
    expect(view.container.querySelector('input')).toBeNull();
    view.unmount();
  });

  it('discards the row on cancel', () => {
    const view = section([]);
    openAddRow(view, PHONE);
    fireClick(buttonByText(view, '取消'));

    expect(view.store.getSnapshot().allowlist).toBeUndefined();
    expect(view.container.querySelector('input')).toBeNull();
    view.unmount();
  });

  it('shows the red validation message under the input for an invalid draft', () => {
    const view = section([]);
    openAddRow(view, 'not-a-number');

    expect(view.container.textContent).toContain('无法识别的号码');
    view.unmount();
  });

  it('shows the duplicate message for a duplicate draft', () => {
    const view = section([PHONE]);
    openAddRow(view, PHONE);

    expect(view.container.textContent).toContain('该号码已在列表中');
    view.unmount();
  });

  it('shows no validation message for a valid draft', () => {
    const view = section([]);
    openAddRow(view, PHONE_2);

    expect(view.container.textContent).not.toContain('无法识别的号码');
    view.unmount();
  });

  it('confirms on Enter and cancels on Escape inside the input', () => {
    const view = section([PHONE]);
    const field = openAddRow(view, PHONE_2);

    fireKeydown(field, 'Enter');
    expect(view.store.getSnapshot().allowlist).toEqual([PHONE, PHONE_2]);

    const field2 = openAddRow(view, '');
    fireKeydown(field2, 'Escape');
    expect(view.container.querySelector('input')).toBeNull();
    view.unmount();
  });
});
