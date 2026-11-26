// useCardForm：订阅宿主表单（configForms），产出已保存基准与原子写面。
//
// controller 的「订阅 + savedNow」职责归位于此；saved 用 useSyncExternalStore
// 派生 —— 宿主推送自动重算，未编辑的域草稿自动跟随。

import { useMemo, useSyncExternalStore } from 'react';

import { readAllowlist } from './allowlist/logic';
import type { FormSnapshot } from './form';
import { sanitizePeerNames } from './contacts/logic';
import { readChunked, readDelayFactor, readMaxChunks } from './chunked/logic';
import { readLocale, type LocaleOption } from './locale/logic';
import { readPreset } from './preset/logic';

/** 宿主表单（ConfigForm 的最小面：读快照、订阅、原子写）。 */
export interface CardForm {
  getSnapshot(): { value?: Readonly<Record<string, unknown>> | undefined };
  subscribe(listener: () => void): () => void;
  mutate(ops: readonly FieldOp[]): Promise<boolean>;
}

/** 一次字段写入（对齐 SettingsPathOp）。 */
export interface FieldOp {
  readonly op: 'set' | 'unset';
  readonly path: readonly string[];
  readonly value?: unknown;
}

/** 已保存基准（dirty 比较 + 未编辑字段写回的兜底值）。 */
export interface SavedBaseline {
  readonly locale: LocaleOption;
  readonly allowlist: readonly string[];
  readonly chunkedReplies?: boolean;
  readonly maxChunks?: number;
  readonly delayFactor?: number;
  /** 未设置 = undefined（不造默认；preset 域用 effectivePreset 解析意图）。 */
  readonly agentPreset?: string;
  /** M7 称呼表（键 = 归一化号码；未设置 = undefined → {}）。 */
  readonly contacts?: Readonly<Record<string, string>>;
}

/** useCardForm 的返回面。 */
export interface UseCardForm {
  readonly saved: SavedBaseline;
  mutate(ops: readonly FieldOp[]): Promise<boolean>;
}

/** 读宿主快照里的称呼表（形状守卫：非 string-map → 空表，同 allowlist）。 */
function readContacts(snapshot: FormSnapshot): Readonly<Record<string, string>> {
  return sanitizePeerNames((snapshot.value?.['contacts'] ?? {}) as Record<string, string>);
}

/**
 * 订阅宿主表单。
 * @param form - 宿主表单面（configForms.get(entryId)）。
 * @returns saved 基准与 mutate 面。
 */
export function useCardForm(form: CardForm): UseCardForm {
  // 不能直接传方法引用：宿主 ConfigForm 的方法是 class 原型方法，
  // 脱离对象调用会丢 this（内部读 this.store，实测炸空白卡片；
  // rc2/rc3 同样如此——不是版本差异，是调用约定）。
  // 箭头包裹让契约不依赖宿主实现是否预绑定。
  const snapshot = useSyncExternalStore(
    (listener) => form.subscribe(listener),
    () => form.getSnapshot(),
  );
  const saved = useMemo<SavedBaseline>(
    () => ({
      locale: readLocale(snapshot),
      allowlist: readAllowlist(snapshot),
      chunkedReplies: readChunked(snapshot),
      maxChunks: readMaxChunks(snapshot),
      delayFactor: readDelayFactor(snapshot),
      agentPreset: readPreset(snapshot) || undefined,
      contacts: readContacts(snapshot),
    }),
    [snapshot],
  );
  // mutate 同样不能传方法引用（原型方法丢 this，同 getSnapshot 的坑）
  return { saved, mutate: (ops) => form.mutate(ops) };
}
