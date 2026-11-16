// 分段回复域纯函数（从 card.ts 归位）。

import type { FormSnapshot } from '../form';

/** 宿主缺省时的产品默认值（读取/草稿/保存兜底共用同一事实）。 */
export const DEFAULT_MAX_CHUNKS = 8;
export const DEFAULT_DELAY_FACTOR = 1;

/** 从宿主快照里读分段开关（缺省 false）。 */
export function readChunked(snapshot: FormSnapshot): boolean {
  return snapshot.value?.['chunkedReplies'] === true;
}

/** 从宿主快照里读最大分段数（非法回退默认 8）。 */
export function readMaxChunks(snapshot: FormSnapshot): number {
  const value = snapshot.value?.['maxChunks'];
  return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_MAX_CHUNKS;
}

/** 从宿主快照里读延时系数（非法回退默认 1）。 */
export function readDelayFactor(snapshot: FormSnapshot): number {
  const value = snapshot.value?.['delayFactor'];
  return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_DELAY_FACTOR;
}

/** 最大分段数校验：1..50 的整数。 */
export function validMaxChunksDraft(text: string): boolean {
  if (!/^\d+$/.test(text.trim())) return false;
  const value = Number.parseInt(text.trim(), 10);
  return value >= 1 && value <= 50;
}

/** 延时系数校验：0..5 的数字（小数可，0 = 不延时）。 */
export function validDelayFactorDraft(text: string): boolean {
  if (!/^\d+(\.\d+)?$/.test(text.trim())) return false;
  const value = Number.parseFloat(text.trim());
  return value >= 0 && value <= 5;
}

/** 三值覆盖（草稿 store 的 chunked/maxChunks/delayFactor 键）。 */
export interface ChunkedOverrides {
  readonly chunked?: boolean;
  readonly maxChunks?: string;
  readonly delayFactor?: string;
}

/** 域草稿视图：域 hook 与保存聚合共用的派生面。 */
export interface ChunkedDraftView {
  readonly chunked: boolean;
  readonly maxChunks: string;
  readonly delayFactor: string;
  readonly dirty: boolean;
  readonly maxChunksError: boolean;
  readonly delayFactorError: boolean;
}

/**
 * 派生分段回复草稿视图（判定逻辑单点维护）。
 * 子字段只在开关开启时参与 dirty/报错：关闭时输入不可见。
 * @param overrides - 草稿覆盖值（未编辑字段 undefined）。
 * @param saved - 已保存基准（缺省 = off/8/1）。
 * @returns 三值草稿与旗标。
 */
export function chunkedDraftView(
  overrides: ChunkedOverrides,
  saved: { chunkedReplies?: boolean; maxChunks?: number; delayFactor?: number },
): ChunkedDraftView {
  const base = {
    chunked: saved.chunkedReplies ?? false,
    maxChunks: String(saved.maxChunks ?? DEFAULT_MAX_CHUNKS),
    delayFactor: String(saved.delayFactor ?? DEFAULT_DELAY_FACTOR),
  };
  const chunked = overrides.chunked ?? base.chunked;
  const maxChunks = overrides.maxChunks ?? base.maxChunks;
  const delayFactor = overrides.delayFactor ?? base.delayFactor;
  return {
    chunked,
    maxChunks,
    delayFactor,
    dirty:
      chunked !== base.chunked ||
      (chunked && (maxChunks !== base.maxChunks || delayFactor !== base.delayFactor)),
    maxChunksError: chunked && !validMaxChunksDraft(maxChunks),
    delayFactorError: chunked && !validDelayFactorDraft(delayFactor),
  };
}
