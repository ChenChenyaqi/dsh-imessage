// 预设域纯函数（从 card.ts 归位；签名已收窄为域参数，不再接大 state）。

import { DEFAULT_PRESET_ID } from '@/core/types/config';

import type { FormSnapshot } from '../form';

/** 下拉里的一条预设选项。 */
export interface PresetOption {
  readonly id: string;
  readonly label: string;
  readonly isDefault: boolean;
  readonly broken: boolean;
}

/** roster 行的最小面（ctx.remote.agentPresets.list() 的返回行）。 */
export interface PresetRosterRow {
  readonly id: string;
  readonly name?: string;
  readonly isDefault?: boolean;
  readonly broken?: string;
}

/** remote.agentPresets 的最小面（host.d.ts 的 HostRemoteAgentPresets 结构兼容）。 */
export interface PresetRemote {
  list(): Promise<
    | { ok: true; value: { presets: readonly PresetRosterRow[] } }
    | { ok: false; error?: unknown }
  >;
}

/**
 * roster → 下拉选项：只保留已安装且启用的（broken 整行丢弃）、去重。
 * 生效值不在 roster 时的兜底行由 presetChoices 在渲染期补
 * （它依赖 options 本身，映射期做不了）。
 */
export function presetOptions(
  roster: readonly PresetRosterRow[],
  builtinNames: Readonly<Record<string, string>> = {},
): readonly PresetOption[] {
  const options: PresetOption[] = [];
  const seen = new Set<string>();
  for (const row of roster) {
    if (!row.id || row.broken !== undefined || seen.has(row.id)) continue;
    seen.add(row.id);
    const label = builtinNames[row.id] ?? row.name ?? row.id;
    options.push({
      id: row.id,
      label,
      isDefault: row.isDefault === true,
      broken: false,
    });
  }
  return options;
}

/**
 * 下拉选项全集：roster 选项 + 生效值兜底（已保存的预设被卸载、或生效值
 * 来自显示默认时，下拉仍能选中当前值，不丢显示）。
 */
export function presetChoices(
  draft: string,
  options: readonly PresetOption[],
): readonly PresetOption[] {
  const effective = effectivePreset(draft, options);
  if (!effective || options.some((option) => option.id === effective)) {
    return options;
  }
  return [{ id: effective, label: effective, isDefault: false, broken: false }, ...options];
}

/**
 * 生效预设：显式选择 > 内置默认（已安装且启用）> 宿主默认 > 空。
 * 「未设置 ≠ 选了内置默认」：区分二者才能做到"装了才默认选中、
 * 用户先选了别的就不抢"。
 */
export function effectivePreset(draft: string, options: readonly PresetOption[]): string {
  const explicit = draft.trim();
  if (explicit) return explicit;
  if (options.some((option) => option.id === DEFAULT_PRESET_ID)) return DEFAULT_PRESET_ID;
  return options.find((option) => option.isDefault)?.id ?? '';
}

/** 预设 dirty 判定：只有用户显式编辑算改动（显示默认不点亮保存）。 */
export function derivePresetDirty(draft: string, savedAgentPreset: string | undefined): boolean {
  return draft.trim() !== (savedAgentPreset ?? '').trim();
}

/** 预设草稿视图（域 hook 与保存聚合单点共用）。 */
export function presetDraftView(
  override: string | undefined,
  savedAgentPreset: string | undefined,
): { draft: string; dirty: boolean; presetError: boolean } {
  const draft = override ?? savedAgentPreset ?? '';
  return {
    draft,
    dirty: derivePresetDirty(draft, savedAgentPreset),
    // 空 = 回默认（不算错）；非空必须匹配 DSH 预设 id 形状
    presetError: draft.trim() !== '' && !validPresetDraft(draft),
  };
}

/** 预设 id 校验：DSH agent-preset 目录 id 事实（空 = 回默认内置预设）。 */
export function validPresetDraft(text: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(text.trim());
}

/** 从宿主快照里读 agent 预设（未设置 = 空，由 effectivePreset 解析意图）。 */
export function readPreset(snapshot: FormSnapshot): string {
  const value = snapshot.value?.['agentPreset'];
  return typeof value === 'string' ? value.trim() : '';
}
