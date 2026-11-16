// 语言域纯函数（从 card.ts 归位）。

import type { FormSnapshot } from '../form';

/** 语言选项（与 Config schema 的 zh/en 一致）。 */
export const LOCALE_OPTIONS = ['zh', 'en'] as const;

export type LocaleOption = (typeof LOCALE_OPTIONS)[number];

/** 从宿主快照里读语言（非法值回退 zh，与 apply 的收窄一致）。 */
export function readLocale(snapshot: FormSnapshot): LocaleOption {
  const value = snapshot.value?.['locale'];
  return value === 'en' ? 'en' : 'zh';
}

/**
 * 语言草稿视图（域 hook 与保存聚合单点共用）：覆盖值收窄到合法选项，
 * 非法/垃圾串回退已保存值（保存路径与显示路径行为一致，不靠收口兜底）。
 */
export function localeDraftView(
  override: string | undefined,
  saved: LocaleOption,
): { draft: LocaleOption; dirty: boolean } {
  const draft = LOCALE_OPTIONS.find((option) => option === override) ?? saved;
  return { draft, dirty: draft !== saved };
}
