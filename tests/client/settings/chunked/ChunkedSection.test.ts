// 分段回复字段规格（方案 D：jsdom 渲染；事件直接写入草稿 store）。

// @vitest-environment jsdom
import { createElement } from 'react';

import { describe, expect, it } from 'vitest';

import { ChunkedSection } from '@/client/settings/chunked/ChunkedSection';
import { fireClick, fireInput, renderCard } from '../../../helpers/render-card';

function section(saved: { chunkedReplies?: boolean; maxChunks?: number; delayFactor?: number }) {
  return renderCard(createElement(ChunkedSection), { saved });
}

/** 取第 n 个数字输入（max chunks = 0，delay factor = 1）。 */
function numberInput(view: ReturnType<typeof section>, index: 0 | 1): HTMLInputElement {
  return view.container.querySelectorAll('input[type="number"]')[index] as HTMLInputElement;
}

describe('chunked section', () => {
  it('renders the toggle with its hint and no number inputs when off', () => {
    const view = section({ chunkedReplies: false });

    expect(view.container.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(view.container.textContent).toContain('关闭则整段一条直接发送');
    expect(view.container.querySelectorAll('input[type="number"]')).toHaveLength(0);
    view.unmount();
  });

  it('forwards toggle changes into the draft store', () => {
    const view = section({ chunkedReplies: false });

    fireClick(view.container.querySelector('input[type="checkbox"]')!);
    expect(view.store.getSnapshot().chunked).toBe(true);
    view.unmount();
  });

  it('shows both number inputs with saved values when on', () => {
    const view = section({ chunkedReplies: true, maxChunks: 12, delayFactor: 2 });

    expect((numberInput(view, 0) as HTMLInputElement).value).toBe('12');
    expect((numberInput(view, 1) as HTMLInputElement).value).toBe('2');
    // label 关联是 e2e 契约（getByLabel 'Max chunks' / 'Delay factor'）
    expect(view.container.textContent).toContain('最大分段数');
    expect(view.container.textContent).toContain('延时系数');
    view.unmount();
  });

  it('forwards number input edits into the draft store', () => {
    const view = section({ chunkedReplies: true, maxChunks: 8 });

    fireInput(numberInput(view, 0), '12');
    fireInput(numberInput(view, 1), '0.5');
    expect(view.store.getSnapshot()).toMatchObject({ maxChunks: '12', delayFactor: '0.5' });
    view.unmount();
  });

  it('shows red validation under the max chunks input and marks it aria-invalid', () => {
    const view = section({ chunkedReplies: true });

    fireInput(numberInput(view, 0), 'garbage');

    expect(view.container.textContent).toContain('需为 1–50 的整数');
    expect(numberInput(view, 0).getAttribute('aria-invalid')).toBe('true');
    view.unmount();
  });

  it('shows the delay factor validation message for a bad factor', () => {
    const view = section({ chunkedReplies: true });

    fireInput(numberInput(view, 1), '99');

    expect(view.container.textContent).toContain('需为 0–5 的数字');
    view.unmount();
  });
});
