// 预设下拉规格（方案 D：jsdom 渲染；roster 走 remote，草稿走 store）。

// @vitest-environment jsdom
import { createElement } from 'react';

import { describe, expect, it } from 'vitest';

import type { PresetRosterRow } from '@/client/settings/preset/logic';
import { PresetSelect } from '@/client/settings/preset/PresetSelect';
import type { PresetRemote } from '@/client/settings/preset/logic';
import { act, fireChange, renderCard } from '../../../helpers/render-card';

const ROSTER: readonly PresetRosterRow[] = [
  { id: 'dafeiyu', name: '大肥鱼' },
  { id: 'standard', isDefault: true },
  { id: 'bad', broken: 'activation failed' },
];

const remoteOf = (presets: readonly PresetRosterRow[]): PresetRemote => ({
  list: async () => ({ ok: true, value: { presets } }),
});

/** 渲染并等 roster 拉取落地。 */
async function section(options: { savedAgentPreset?: string; presets?: readonly PresetRosterRow[] }) {
  const view = renderCard(createElement(PresetSelect), {
    saved: options.savedAgentPreset ? { agentPreset: options.savedAgentPreset } : {},
    remote: remoteOf(options.presets ?? ROSTER),
  });
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

/** 取预设下拉与选项值列表。 */
function selectOf(view: { readonly container: HTMLElement }): {
  select: HTMLSelectElement;
  values: readonly string[];
} {
  const select = view.container.querySelector('select[data-field="preset"]') as HTMLSelectElement;
  expect(select).not.toBeNull();
  return {
    select,
    values: Array.from(select.querySelectorAll('option')).map((option) => option.value),
  };
}

describe('preset select', () => {
  it('lists installed and enabled presets only (broken rows dropped)', async () => {
    const view = await section({});

    // broken 的 bad 不出现；数据精准来自已安装且启用的预设
    const { values } = selectOf(view);
    expect(values).toEqual(['dafeiyu', 'standard']);
    expect(view.container.textContent).toContain('大肥鱼');
    view.unmount();
  });

  it('selects dafeiyu by default when it is installed and nothing was chosen', async () => {
    // 产品默认优先：dafeiyu 装了就默认选中，其次才是宿主 isDefault
    const view = await section({});

    expect(selectOf(view).select.value).toBe('dafeiyu');
    view.unmount();
  });

  it('falls back to the host default row when dafeiyu is not installed', async () => {
    const view = await section({ presets: [{ id: 'standard', isDefault: true }] });

    expect(selectOf(view).select.value).toBe('standard');
    view.unmount();
  });

  it('never steals an explicit choice back to the default', async () => {
    const view = await section({ savedAgentPreset: 'standard' });

    expect(selectOf(view).select.value).toBe('standard');
    view.unmount();
  });

  it('keeps the current value as a fallback option when the roster lacks it', async () => {
    // 已保存的预设被卸载：当前值仍可见可选（保存/切换不丢显示）
    const view = await section({ savedAgentPreset: 'ghosted-preset' });

    const { select, values } = selectOf(view);
    expect(values).toEqual(['ghosted-preset', 'dafeiyu', 'standard']);
    expect(select.value).toBe('ghosted-preset');
    view.unmount();
  });

  it('forwards preset selection into the draft store', async () => {
    const view = await section({});

    // 真 select 只能选存在的 option：从默认 dafeiyu 切到 standard
    fireChange(selectOf(view).select, 'standard');
    expect(view.store.getSnapshot().agentPreset).toBe('standard');
    view.unmount();
  });

  it('shows the red validation message for a malformed id', async () => {
    const view = await section({});
    act(() => {
      view.store.set('agentPreset', 'Not Valid');
    });

    expect(view.container.textContent).toContain('预设 id 只能是小写字母、数字和中划线');
    view.unmount();
  });
});
