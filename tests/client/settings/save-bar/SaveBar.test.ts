// 保存条规格（方案 D：jsdom 渲染；hook 就地执行，点击触发真保存链路）。

// @vitest-environment jsdom
import { createElement } from 'react';

import { describe, expect, it, vi } from 'vitest';

import { SaveBar } from '@/client/settings/save-bar/SaveBar';
import type { FieldOp } from '@/client/settings/useCardForm';
import { act, fireClick, renderCard } from '../../../helpers/render-card';

const PHONE = '+8613800000000';

describe('save bar', () => {
  it('disables the button when nothing changed', () => {
    const view = renderCard(createElement(SaveBar));

    expect((view.container.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    view.unmount();
  });

  it('enables the button once a field is edited and saves on click', async () => {
    const mutate = vi.fn(async () => true);
    const view = renderCard(createElement(SaveBar), {
      mutate: mutate as unknown as (ops: readonly FieldOp[]) => Promise<boolean>,
    });
    act(() => {
      view.store.set('allowlist', [PHONE]);
    });

    const button = view.container.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireClick(button);
    await act(async () => {
      await Promise.resolve();
    });

    expect(mutate).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('shows the saving text while the mutation is in flight', async () => {
    let release: (() => void) | undefined;
    const view = renderCard(createElement(SaveBar), {
      mutate: (() => new Promise<boolean>((resolve) => (release = () => resolve(true)))) as never,
    });
    act(() => {
      view.store.set('locale', 'en');
    });
    fireClick(view.container.querySelector('button')!);

    expect(view.container.textContent).toContain('保存中…');

    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    expect(view.container.textContent).toContain('保存');
    view.unmount();
  });

  it('shows the failure text when the mutation is rejected', async () => {
    const view = renderCard(createElement(SaveBar), { mutate: async () => false });
    act(() => {
      view.store.set('locale', 'en');
    });
    fireClick(view.container.querySelector('button')!);
    await act(async () => {
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('保存失败，请重试');
    view.unmount();
  });
});
