// 白名单域纯函数（从 card.ts 归位；零 React、零宿主依赖）。
//
// 对齐 core 的事实：条目原样保存（宿主 config 是 string[]，归一化交给
// core 的 makePolicy），这里只做空白清洗，不做手机号格式化。

import { normalizePhone } from '@/core/types/phone';

import type { FormSnapshot } from '../form';

/** 空白名单提示的严重度（界面据此选颜色）。 */
export type AllowlistWarning = 'empty' | null;

/** 新增行校验错误的机器码（view 负责翻译成文案）。 */
export type AddEntryError = 'invalid' | 'duplicate' | null;

/** 一条白名单条目的解析结果。 */
export interface AllowlistEntry {
  /** 去空白后的原始写法（保存时原样写回）。 */
  readonly raw: string;
  /** 归一化键；null = 非法条目（手改配置文件才可能出现，界面标红）。 */
  readonly key: string | null;
}

/** 把条目数组解析成 chip 渲染用的条目（去空白、跳过空串）。 */
export function parseAllowlist(values: readonly string[]): readonly AllowlistEntry[] {
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((raw) => ({ raw, key: normalizePhone(raw) }));
}

/** 条目清洗（保存与 dirty 比较共用的口径：只 trim、不丢条目）。 */
export function formatAllowlist(values: readonly string[]): readonly string[] {
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

/** 从宿主快照里读白名单（非数组回退空）。 */
export function readAllowlist(snapshot: FormSnapshot): readonly string[] {
  const value = snapshot.value?.['allowlist'];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/** 新增行的状态（收起时 active=false 且无残留）。 */
export interface AddEntryState {
  readonly active: boolean;
  readonly input: string;
  readonly error: AddEntryError;
}

/** 校验新增输入：空 = 还没开始写（不算错）；非法 / 重复报机器码。 */
export function validateAdd(input: string, entries: readonly AllowlistEntry[]): AddEntryError {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const key = normalizePhone(trimmed);
  if (key === null) return 'invalid';
  return entries.some((entry) => entry.key === key) ? 'duplicate' : null;
}

/** 域草稿视图：override + saved 基准 → 界面/保存聚合共用的派生面。 */
export interface AllowlistDraftView {
  readonly draft: readonly string[];
  readonly entries: readonly AllowlistEntry[];
  readonly dirty: boolean;
  readonly hasInvalid: boolean;
}

/**
 * 派生白名单草稿视图（域 hook 与 useSave 聚合共用，判定逻辑单点维护）。
 * @param override - 草稿覆盖值（undefined = 未编辑）。
 * @param saved - 已保存基准。
 * @returns 草稿、解析条目与旗标。
 */
export function allowlistDraftView(
  override: readonly string[] | undefined,
  saved: readonly string[],
): AllowlistDraftView {
  const draft = override ?? formatAllowlist(saved);
  const entries = parseAllowlist(draft);
  return {
    draft,
    entries,
    // 按「清洗后的条目序列」比较：只改空白不算改动
    dirty: formatAllowlist(draft).join('\n') !== formatAllowlist(saved).join('\n'),
    hasInvalid: entries.some((entry) => entry.key === null),
  };
}

/** 新增行是否拦保存（展开且有未修正错误）。 */
export function addEntryPending(adding: AddEntryState | undefined): boolean {
  return adding !== undefined && adding.active && adding.error !== null;
}
