// 预设域纯函数规格（从 card.test 的 preset 段迁移；测试先行）。
//
// effectivePreset / derivePresetDirty 签名已收窄为域参数（不再接大 state）。

import { describe, expect, it } from 'vitest';

import {
  derivePresetDirty,
  effectivePreset,
  presetChoices,
  presetDraftView,
  presetOptions,
  readPreset,
  validPresetDraft,
} from '@/client/settings/preset/logic';

describe('preset logic · effective value', () => {
  it('prefers the explicit choice, then builtin default when installed, then host default', () => {
    const roster = presetOptions([{ id: 'standard', isDefault: true }, { id: 'dafeiyu' }]);

    // 用户显式选择永远赢
    expect(effectivePreset('plain', roster)).toBe('plain');
    // 未设置 + 内置默认已安装 → 默认选中它
    expect(effectivePreset('', roster)).toBe('dafeiyu');
    // 未设置 + 内置默认未安装 → 宿主默认
    expect(effectivePreset('', presetOptions([{ id: 'standard', isDefault: true }]))).toBe(
      'standard',
    );
    // 无 roster：空（视图退化为当前值兜底）
    expect(effectivePreset('', [])).toBe('');
  });

  it('display default alone is not dirty; only an explicit edit counts', () => {
    // 未设置 + roster 到达（显示默认）→ 不点亮保存
    expect(derivePresetDirty('', '')).toBe(false);
    // 显式选择 → dirty
    expect(derivePresetDirty('plain', '')).toBe(true);
  });

  it('validates the preset id shape (DSH agent-preset id fact)', () => {
    for (const bad of ['Dafeiyu', 'has space', 'dafeiyu!', '-lead']) {
      expect(validPresetDraft(bad)).toBe(false);
    }
    expect(validPresetDraft('plain-2')).toBe(true);
    // 空串同样不匹配（首字符必填）；「空 = 回默认不算错」是状态机层特判
    expect(validPresetDraft('')).toBe(false);
  });
});

describe('preset logic · draft view (hook 与保存聚合共用)', () => {
  it('uses the saved preset when unedited and marks an explicit edit dirty', () => {
    // 未编辑：取已保存值，不 dirty
    expect(presetDraftView(undefined, 'ptc')).toEqual({
      draft: 'ptc',
      dirty: false,
      presetError: false,
    });
    // 编辑过：覆盖值，dirty
    expect(presetDraftView('plain', 'ptc').dirty).toBe(true);
    // 非空非法 id → 拦保存
    expect(presetDraftView('Not Valid', undefined).presetError).toBe(true);
  });
});

describe('preset logic · snapshot reads', () => {
  it('reads a trimmed preset id and tolerates non-string values', () => {
    expect(readPreset({ value: { agentPreset: '  ptc  ' } })).toBe('ptc');
    expect(readPreset({ value: { agentPreset: 42 } })).toBe('');
    expect(readPreset({})).toBe('');
  });
});

describe('preset logic · roster options', () => {
  it('turns a roster into options carrying the default marker', () => {
    const options = presetOptions([{ id: 'standard', isDefault: true }]);

    expect(options).toEqual([{ id: 'standard', label: 'standard', isDefault: true, broken: false }]);
  });

  it('localizes shipped preset ids through the builtin name map', () => {
    const options = presetOptions([{ id: 'dafeiyu' }], { dafeiyu: '大肥鱼' });

    expect(options[0]!.label).toBe('大肥鱼');
  });

  it('drops broken presets entirely (dropdown lists only installed and enabled ones)', () => {
    const options = presetOptions([{ id: 'bad', broken: 'activation failed' }]);

    expect(options).toHaveLength(0);
  });

  it('keeps a non-empty effective value selectable even when it is not in the roster', () => {
    // 已保存的预设被卸载：生效值兜底头插，不丢显示
    const choices = presetChoices('ghosted', presetOptions([{ id: 'standard' }]));

    expect(choices.map((option) => option.id)).toEqual(['ghosted', 'standard']);
  });

  it('does not fabricate a choice for an empty effective value', () => {
    expect(presetChoices('', presetOptions([{ id: 'standard' }]))).toHaveLength(1);
  });

  it('dedupes roster rows by id', () => {
    const options = presetOptions([{ id: 'standard' }, { id: 'standard', name: 'dup' }]);

    expect(options).toHaveLength(1);
  });
});
