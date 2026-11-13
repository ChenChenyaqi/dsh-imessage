// 客户端入口规格：只声明身份与依赖，接线交给 settings/mount。
//
// 这层不该有逻辑——有逻辑就说明职责又漏回入口了。

import { describe, expect, it, vi } from 'vitest';

import { apply, inject } from '@/client/index';

// 入口必须把挂载工作委托出去（否则又会变成上帝文件）
vi.mock('@/client/settings/mount', () => ({
  mountSettingsSection: vi.fn(),
}));

const { mountSettingsSection } = await import('@/client/settings/mount');

describe('client entry', () => {
  it('injects every client service the card needs', () => {
    expect(inject).toEqual(['slots', 'locale', 'configForms', 'remote', 'remote.agentPresets']);
  });

  it('delegates mounting to the settings package', () => {
    const ctx = { marker: 'ctx' };

    apply(ctx as never);

    expect(mountSettingsSection).toHaveBeenCalledWith(ctx);
  });
});
