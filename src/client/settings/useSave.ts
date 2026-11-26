// useSave：canSave 聚合 + 全量覆盖式原子写 + 失败收敛（方案 D：context 自取）。
//
// 保存永远是全量覆盖：一次 mutate 写全部字段（避免半保存）；生效预设为空
// 时省略 agentPreset op（留给宿主默认）。保存成功后不主动清草稿 —— 宿主
// 写入回流推送新基准，override 与新基准相等自然收敛为 clean。
//
// canSave 是 store 的派生布尔（useSyncExternalStore 订阅，primitive 引用
// 稳定）：任一域 dirty 且无拦保存信号。各域判定在域 logic 单点维护。

import { useState, useSyncExternalStore } from 'react';

import { addEntryPending, allowlistDraftView, formatAllowlist } from './allowlist/logic';
import { contactsDraftView } from './contacts/logic';
import {
  chunkedDraftView,
  DEFAULT_DELAY_FACTOR,
  DEFAULT_MAX_CHUNKS,
  validDelayFactorDraft,
  validMaxChunksDraft,
} from './chunked/logic';
import { localeDraftView } from './locale/logic';
import { effectivePreset, presetDraftView, type PresetOption } from './preset/logic';
import type { DraftOverrides, DraftStore } from './draft-store';
import { useCardContext } from './card-context';
import type { FieldOp, SavedBaseline } from './useCardForm';

/** 保存聚合的各域草稿面（派生自 store 覆盖值 + saved 基准）。 */
export interface UseSaveFields {
  readonly locale: { readonly draft: string; readonly dirty: boolean };
  readonly allowlist: {
    readonly draft: readonly string[];
    readonly dirty: boolean;
    readonly hasInvalid: boolean;
    readonly addPending: boolean;
  };
  readonly chunked: {
    readonly draft: boolean;
    readonly dirty: boolean;
    readonly maxChunksError: boolean;
    readonly delayFactorError: boolean;
  };
  readonly maxChunks: { readonly draft: string };
  readonly delayFactor: { readonly draft: string };
  readonly preset: {
    readonly draft: string;
    readonly dirty: boolean;
    readonly presetError: boolean;
  };
  readonly contacts: {
    readonly names: Readonly<Record<string, string>>;
    readonly dirty: boolean;
  };
  readonly presetOptions: readonly PresetOption[];
}

/** 派生保存聚合面（纯函数：store 覆盖值 + saved 基准 → 各域草稿与旗标）。 */
export function deriveSaveFields(overrides: DraftOverrides, saved: SavedBaseline): UseSaveFields {
  const allowlist = allowlistDraftView(overrides.allowlist, saved.allowlist);
  const chunked = chunkedDraftView(overrides, saved);
  return {
    locale: localeDraftView(overrides.locale, saved.locale),
    allowlist: {
      ...allowlist,
      addPending: addEntryPending(overrides.adding),
    },
    chunked: {
      draft: chunked.chunked,
      dirty: chunked.dirty,
      maxChunksError: chunked.maxChunksError,
      delayFactorError: chunked.delayFactorError,
    },
    maxChunks: { draft: chunked.maxChunks },
    delayFactor: { draft: chunked.delayFactor },
    preset: presetDraftView(overrides.agentPreset, saved.agentPreset),
    contacts: contactsDraftView(
      overrides.peerNames,
      saved.contacts ?? {},
      overrides.allowlist ?? saved.allowlist,
    ),
    presetOptions: overrides.presetOptions ?? [],
  };
}

/** canSave 判定（纯函数）：任一域 dirty 且无拦保存信号。 */
export function canSaveOf(fields: UseSaveFields): boolean {
  const anyDirty =
    fields.locale.dirty ||
    fields.allowlist.dirty ||
    fields.chunked.dirty ||
    fields.preset.dirty ||
    fields.contacts.dirty;
  const guarded =
    fields.allowlist.hasInvalid ||
    fields.allowlist.addPending ||
    fields.chunked.maxChunksError ||
    fields.chunked.delayFactorError ||
    fields.preset.presetError;
  return anyDirty && !guarded;
}

/** useSave 的返回面。 */
export interface UseSave {
  readonly canSave: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  save(): Promise<void>;
}

/**
 * 构造一次保存的完整 op 列表（纯函数，供 useSave 与测试使用）。
 * 全量覆盖：语言 + 白名单 + 分段三件套 + 条件性 agentPreset。
 */
export function buildSaveOps(fields: UseSaveFields, saved: SavedBaseline): readonly FieldOp[] {
  const locale = fields.locale.draft === 'en' ? 'en' : 'zh';
  // 开关关闭时草稿可能残留不可解析文本：回退已保存值（界面本就不显示）
  const maxChunks = validMaxChunksDraft(fields.maxChunks.draft)
    ? Number.parseInt(fields.maxChunks.draft.trim(), 10)
    : (saved.maxChunks ?? DEFAULT_MAX_CHUNKS);
  const delayFactor = validDelayFactorDraft(fields.delayFactor.draft)
    ? Number.parseFloat(fields.delayFactor.draft.trim())
    : (saved.delayFactor ?? DEFAULT_DELAY_FACTOR);
  const agentPreset = effectivePreset(fields.preset.draft, fields.presetOptions);
  // fields.contacts.names 已是清洗后的草稿（空值剔除）；整字段覆盖写
  const contacts = fields.contacts.names;
  const ops: FieldOp[] = [
    { op: 'set', path: ['locale'], value: locale },
    {
      op: 'set',
      path: ['allowlist'],
      value: formatAllowlist(fields.allowlist.draft),
    },
    { op: 'set', path: ['chunkedReplies'], value: fields.chunked.draft },
    { op: 'set', path: ['maxChunks'], value: maxChunks },
    { op: 'set', path: ['delayFactor'], value: delayFactor },
  ];
  // 生效预设为空（无 roster 且未设置）→ 不写，留给宿主默认
  if (agentPreset !== '') {
    ops.push({ op: 'set', path: ['agentPreset'], value: agentPreset });
  }
  // M7 称呼表（整字段覆盖；与 allowlist 同纪律，clean 时也写回基准）
  ops.push({ op: 'set', path: ['contacts'], value: contacts });
  return ops;
}

function canSaveFromStore(store: DraftStore, saved: SavedBaseline): boolean {
  return canSaveOf(deriveSaveFields(store.getSnapshot(), saved));
}

/**
 * 保存聚合（在 SaveBar 内执行）：订阅 store 派生 canSave，保存走全量覆盖。
 * @returns canSave、进行中状态、错误文案与保存动作。
 */
export function useSave(): UseSave {
  const { store, saved, mutate, messages } = useCardContext();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = useSyncExternalStore(store.subscribe, () => canSaveFromStore(store, saved));

  return {
    canSave,
    saving,
    error,
    async save() {
      if (!canSave || saving) return;
      const fields = deriveSaveFields(store.getSnapshot(), saved);
      setSaving(true);
      setError(null);
      try {
        const ok = await mutate(buildSaveOps(fields, saved));
        // 被拒（RPC 校验失败等）：保留草稿可重试
        if (!ok) setError(messages.saveFailed);
      } catch {
        setError(messages.saveFailed);
      } finally {
        setSaving(false);
      }
    },
  };
}
