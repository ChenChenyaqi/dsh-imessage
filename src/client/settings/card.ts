// 设置卡片状态机（纯逻辑，零 React、零宿主依赖）。
//
// 只做「值 ↔ 状态」的纯变换：白名单文本 ↔ 数组、语言选项、校验、dirty
// 判定、保存失败收敛。controller（订阅宿主/发写入）在 controller.ts。
//
// 刻意不碰 React：组件只做渲染与事件转发，所有判断都在这里单测。
// 对齐 core 的事实：
// - 白名单条目原样保存（宿主 config 是 `string[]`，归一化交给 core 的
//   makePolicy），所以这里不做手机号格式化，只做「行 → 条目」的清洗；
// - 空白名单 = 全拒（makePolicy 语义），必须在界面上显式提示；
// - 「保存」永远是全量覆盖式提交：一次 set 两个字段，避免半保存。

import { normalizePhone } from '@/core/types/phone';

/** 空白名单提示的严重度（界面据此选颜色）。 */
export type AllowlistWarning = 'empty' | null;

/** 一个字段的编辑状态。 */
export interface FieldState {
  /** 用户当前的输入（白名单是文本块，语言是单值）。 */
  readonly draft: string;
  /** 与已保存值相比是否有改动。 */
  readonly dirty: boolean;
}

/** 卡片整体状态。 */
export interface SettingsCardState {
  /** 是否已经拿到宿主快照（false = loading）。 */
  readonly ready: boolean;
  /** 语言草稿。 */
  readonly locale: FieldState;
  /** 白名单草稿（每行一个条目）。 */
  readonly allowlist: FieldState;
  /** 提交中（禁用按钮，避免重复写）。 */
  readonly saving: boolean;
  /** 最近一次提交失败的原因（成功后清空）。 */
  readonly error: string | null;
  /** 空白名单提示（与 error 独立：它是"能保存但危险"的状态）。 */
  readonly warning: AllowlistWarning;
  /** 解析出的条目（含非法行，供界面逐行标注）。 */
  readonly entries: readonly AllowlistEntry[];
  /** 是否能保存（无改动 / 保存中 / 有非法行时不可）。 */
  readonly canSave: boolean;
}

/** 一条白名单输入的解析结果。 */
export interface AllowlistEntry {
  /** 去空白后的原始写法（保存时原样写回）。 */
  readonly raw: string;
  /** 归一化键；null = 非法条目（保存前必须修掉）。 */
  readonly key: string | null;
}

/** 宿主表单快照（ConfigForm 的最小面，测试注入 fake）。 */
export interface FormSnapshot {
  readonly value?: Readonly<Record<string, unknown>> | undefined;
  readonly writable?: boolean | undefined;
}

/** 一次字段写入（对齐 SettingsPathOp）。 */
export interface FieldOp {
  readonly op: 'set' | 'unset';
  readonly path: readonly string[];
  readonly value?: unknown;
}

/** 宿主表单写入面（ConfigForm 的最小面）。 */
export interface FormWriter {
  /** 原子写入多个字段：要么全成，要么按宿主的版本冲突语义失败。 */
  mutate(ops: readonly FieldOp[]): Promise<boolean>;
}

/** 文案来源（i18n 注入，controller 不硬编码语言）。 */
export interface CardTexts {
  readonly saveFailed: string;
}

/** 语言选项（与 Config schema 的 zh/en 一致）。 */
export const LOCALE_OPTIONS = ['zh', 'en'] as const;
export type LocaleOption = (typeof LOCALE_OPTIONS)[number];

/** 把多行文本解析成条目（保留空行以外的原始写法）。 */
export function parseAllowlist(text: string): readonly AllowlistEntry[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((raw) => ({ raw, key: normalizePhone(raw) }));
}

/** 数组 → 文本（宿主值回填到输入框）。 */
export function formatAllowlist(values: readonly string[]): string {
  return values.join('\n');
}

/** 从宿主快照里读语言（非法值回退 zh，与 apply 的收窄一致）。 */
export function readLocale(snapshot: FormSnapshot): LocaleOption {
  const value = snapshot.value?.['locale'];
  return value === 'en' ? 'en' : 'zh';
}

/** 从宿主快照里读白名单（非数组回退空）。 */
export function readAllowlist(snapshot: FormSnapshot): readonly string[] {
  const value = snapshot.value?.['allowlist'];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/** 用宿主快照构造初始状态。 */
export function initialState(snapshot: FormSnapshot): SettingsCardState {
  const locale = readLocale(snapshot);
  const allowlist = readAllowlist(snapshot);
  const text = formatAllowlist(allowlist);
  return {
    ready: true,
    locale: { draft: locale, dirty: false },
    allowlist: { draft: text, dirty: false },
    saving: false,
    error: null,
    warning: allowlist.length === 0 ? 'empty' : null,
    entries: parseAllowlist(text),
    canSave: false,
  };
}

/** 重算派生字段（draft 变化后调用）。 */
function derive(state: SettingsCardState, saved: {
  locale: LocaleOption;
  allowlist: readonly string[];
}): SettingsCardState {
  const entries = parseAllowlist(state.allowlist.draft);
  const localeDirty = state.locale.draft !== saved.locale;
  // 白名单按「解析后的条目序列」比较：只改空行不算改动
  const allowlistDirty = formatAllowlist(entries.map((entry) => entry.raw))
    !== formatAllowlist(saved.allowlist);
  const hasInvalid = entries.some((entry) => entry.key === null);
  return {
    ...state,
    entries,
    locale: { ...state.locale, dirty: localeDirty },
    allowlist: { ...state.allowlist, dirty: allowlistDirty },
    warning: entries.length === 0 ? 'empty' : null,
    canSave: !state.saving && !hasInvalid && (localeDirty || allowlistDirty),
  };
}

/** 用已保存基准重算派生字段（宿主快照变化后调用）。 */
export function withDerived(
  state: SettingsCardState,
  saved: { locale: LocaleOption; allowlist: readonly string[] },
): SettingsCardState {
  return derive(state, saved);
}

/** 改语言草稿。 */
export function setLocaleDraft(
  state: SettingsCardState,
  draft: string,
  saved: { locale: LocaleOption; allowlist: readonly string[] },
): SettingsCardState {
  return derive({ ...state, locale: { draft, dirty: false } }, saved);
}

/** 改白名单草稿。 */
export function setAllowlistDraft(
  state: SettingsCardState,
  draft: string,
  saved: { locale: LocaleOption; allowlist: readonly string[] },
): SettingsCardState {
  return derive({ ...state, allowlist: { draft, dirty: false } }, saved);
}

/** 提交中标记（禁用按钮）。 */
export function beginSave(state: SettingsCardState): SettingsCardState {
  return { ...state, saving: true, error: null, canSave: false };
}

/** 提交成功：草稿成为新基准。 */
export function saveSucceeded(
  state: SettingsCardState,
  snapshot: FormSnapshot,
): SettingsCardState {
  return initialState(snapshot);
}

/** 提交失败：保留草稿（用户不用重输），展示错误。 */
export function saveFailed(
  state: SettingsCardState,
  texts: CardTexts,
  saved: { locale: LocaleOption; allowlist: readonly string[] },
): SettingsCardState {
  return derive(
    { ...state, saving: false, error: texts.saveFailed },
    saved,
  );
}

/**
 * 执行一次保存（全量覆盖：语言 + 白名单一起写）。
 * @param deps - 表单写入面、文案、以及成功后的快照来源。
 * @param state - 当前状态。
 * @param saved - 已保存的基准值（用于重算 dirty）。
 * @returns 保存后的状态（成功/失败都已收敛，不抛）。
 */
export async function save(
  deps: {
    readonly form: FormWriter;
    readonly texts: CardTexts;
    readonly readSnapshot: () => FormSnapshot;
  },
  state: SettingsCardState,
  saved: { locale: LocaleOption; allowlist: readonly string[] },
): Promise<SettingsCardState> {
  const entries = parseAllowlist(state.allowlist.draft);
  // 非法条目不该走到这里（canSave 已拦），但写入口也要自保
  if (entries.some((entry) => entry.key === null)) return state;
  const saving = beginSave(state);
  const locale: LocaleOption = state.locale.draft === 'en' ? 'en' : 'zh';
  // 数组字段整体覆盖：顺序即用户输入顺序；两个字段一次写（原子）
  const ops: readonly FieldOp[] = [
    { op: 'set', path: ['locale'], value: locale },
    { op: 'set', path: ['allowlist'], value: entries.map((entry) => entry.raw) },
  ];
  try {
    if (!await deps.form.mutate(ops)) {
      return saveFailed(saving, deps.texts, saved);
    }
    return saveSucceeded(saving, deps.readSnapshot());
  } catch {
    return saveFailed(saving, deps.texts, saved);
  }
}
