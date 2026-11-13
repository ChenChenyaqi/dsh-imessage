// 设置卡片状态机（纯逻辑，零 React、零宿主依赖）。
//
// 只做「值 ↔ 状态」的纯变换：白名单条目数组、新增行校验、删除、dirty
// 判定、保存失败收敛。controller（订阅宿主/发写入）在 controller.ts。
//
// 刻意不碰 React：组件只做渲染与事件转发，所有判断都在这里单测。
// 对齐 core 的事实：
// - 白名单条目原样保存（宿主 config 是 `string[]`，归一化交给 core 的
//   makePolicy），所以这里不做手机号格式化，只做空白清洗；
// - 空白名单 = 全拒（makePolicy 语义），必须在界面上显式提示；
// - 「保存」永远是全量覆盖式提交：一次 set 两个字段，避免半保存。
//
// 白名单交互（方案 A）：平时只有「添加号码」按钮；点开才出现一行输入；
// 校验不过（格式错 / 重复）不允许加入列表，也不允许保存。

import { normalizePhone } from '@/core/types/phone';

/** 空白名单提示的严重度（界面据此选颜色）。 */
export type AllowlistWarning = 'empty' | null;

/** 新增行校验错误的机器码（view 负责翻译成文案）。 */
export type AddEntryError = 'invalid' | 'duplicate' | null;

/** 语言字段的编辑状态。 */
export interface FieldState {
  /** 用户当前的选择。 */
  readonly draft: string;
  /** 与已保存值相比是否有改动。 */
  readonly dirty: boolean;
}

/** 白名单字段的编辑状态（条目数组，不再是一坨文本）。 */
export interface AllowlistFieldState {
  /** 条目原文（去空白后保存）。 */
  readonly draft: readonly string[];
  /** 与已保存值相比是否有改动。 */
  readonly dirty: boolean;
}

/** 布尔字段（分段开关）的编辑状态。 */
export interface ChunkedFieldState {
  readonly draft: boolean;
  readonly dirty: boolean;
}

/** 新增行的状态（收起时 active=false 且无残留）。 */
export interface AddEntryState {
  readonly active: boolean;
  readonly input: string;
  readonly error: AddEntryError;
}

/** 卡片整体状态。 */
export interface SettingsCardState {
  /** 是否已经拿到宿主快照（false = loading）。 */
  readonly ready: boolean;
  /** 语言草稿。 */
  readonly locale: FieldState;
  /** 白名单草稿（每条一个条目）。 */
  readonly allowlist: AllowlistFieldState;
  /** 新增行状态。 */
  readonly adding: AddEntryState;
  /** 分段回复开关草稿。 */
  readonly chunked: ChunkedFieldState;
  /** 最大分段数草稿（输入框字符串；1..50 整数）。 */
  readonly maxChunks: FieldState;
  /** 延时系数草稿（输入框字符串；0..5，0 = 不延时）。 */
  readonly delayFactor: FieldState;
  /** 最大分段数草稿非法（仅开关开启时才可能为 true）。 */
  readonly maxChunksError: boolean;
  /** 延时系数草稿非法（仅开关开启时才可能为 true）。 */
  readonly delayFactorError: boolean;
  /** 提交中（禁用按钮，避免重复写）。 */
  readonly saving: boolean;
  /** 最近一次提交失败的原因（成功后清空）。 */
  readonly error: string | null;
  /** 空白名单提示（与 error 独立：它是"能保存但危险"的状态）。 */
  readonly warning: AllowlistWarning;
  /** 解析出的条目（含非法条目，供界面逐个标注）。 */
  readonly entries: readonly AllowlistEntry[];
  /** 是否能保存（无改动 / 保存中 / 非法条目 / 新增行未通过校验时不可）。 */
  readonly canSave: boolean;
}

/** 一条白名单条目的解析结果。 */
export interface AllowlistEntry {
  /** 去空白后的原始写法（保存时原样写回）。 */
  readonly raw: string;
  /** 归一化键；null = 非法条目（手改配置文件才可能出现，界面标红）。 */
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

/** 从宿主快照里读语言（非法值回退 zh，与 apply 的收窄一致）。 */
export function readLocale(snapshot: FormSnapshot): LocaleOption {
  const value = snapshot.value?.['locale'];
  return value === 'en' ? 'en' : 'zh';
}

/** 从宿主快照里读分段开关（缺省 false）。 */
export function readChunked(snapshot: FormSnapshot): boolean {
  return snapshot.value?.['chunkedReplies'] === true;
}

/** 从宿主快照里读最大分段数（非法回退默认 8）。 */
export function readMaxChunks(snapshot: FormSnapshot): number {
  const value = snapshot.value?.['maxChunks'];
  return typeof value === 'number' && Number.isFinite(value) ? value : 8;
}

/** 从宿主快照里读延时系数（非法回退默认 1）。 */
export function readDelayFactor(snapshot: FormSnapshot): number {
  const value = snapshot.value?.['delayFactor'];
  return typeof value === 'number' && Number.isFinite(value) ? value : 1;
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

/** 从宿主快照里读白名单（非数组回退空）。 */
export function readAllowlist(snapshot: FormSnapshot): readonly string[] {
  const value = snapshot.value?.['allowlist'];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/** 校验新增输入：空 = 还没开始写（不算错）；非法 / 重复报机器码。 */
function validateAdd(input: string, entries: readonly AllowlistEntry[]): AddEntryError {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const key = normalizePhone(trimmed);
  if (key === null) return 'invalid';
  return entries.some((entry) => entry.key === key) ? 'duplicate' : null;
}

/** 收起态的新增行（复位用）。 */
const ADDING_CLOSED: AddEntryState = { active: false, input: '', error: null };

/** 用宿主快照构造初始状态。 */
export function initialState(snapshot: FormSnapshot): SettingsCardState {
  const locale = readLocale(snapshot);
  const allowlist = formatAllowlist(readAllowlist(snapshot));
  return {
    ready: true,
    locale: { draft: locale, dirty: false },
    allowlist: { draft: allowlist, dirty: false },
    adding: ADDING_CLOSED,
    chunked: { draft: readChunked(snapshot), dirty: false },
    maxChunks: { draft: String(readMaxChunks(snapshot)), dirty: false },
    delayFactor: { draft: String(readDelayFactor(snapshot)), dirty: false },
    maxChunksError: false,
    delayFactorError: false,
    saving: false,
    error: null,
    warning: allowlist.length === 0 ? 'empty' : null,
    entries: parseAllowlist(allowlist),
    canSave: false,
  };
}

/** 重算派生字段（草稿或基准变化后调用）。 */
function derive(state: SettingsCardState, saved: {
  locale: LocaleOption;
  allowlist: readonly string[];
  chunkedReplies?: boolean;
  maxChunks?: number;
  delayFactor?: number;
}): SettingsCardState {
  const entries = parseAllowlist(state.allowlist.draft);
  const localeDirty = state.locale.draft !== saved.locale;
  // 白名单按「清洗后的条目序列」比较：只改空白不算改动
  const allowlistDirty = formatAllowlist(state.allowlist.draft).join('\n')
    !== formatAllowlist(saved.allowlist).join('\n');
  const hasInvalid = entries.some((entry) => entry.key === null);
  // 新增行里有未修正的错误输入：用户还没收尾，先拦住保存
  const addPending = state.adding.active && state.adding.error !== null;
  // 风格校验只在开关开启时做（关闭时子输入不可见）
  const maxChunksError = state.chunked.draft && !validMaxChunksDraft(state.maxChunks.draft);
  const delayFactorError = state.chunked.draft && !validDelayFactorDraft(state.delayFactor.draft);
  const savedNow2 = saved as { chunkedReplies?: boolean; maxChunks?: number; delayFactor?: number };
  // 子字段只在开关开启时参与 dirty 判定：关闭时输入不可见，残留草稿不算改动
  const styleDirty = state.chunked.draft !== (savedNow2.chunkedReplies ?? false)
    || (state.chunked.draft
      && (state.maxChunks.draft !== String(savedNow2.maxChunks ?? 8)
        || state.delayFactor.draft !== String(savedNow2.delayFactor ?? 1)));
  return {
    ...state,
    entries,
    locale: { ...state.locale, dirty: localeDirty },
    allowlist: { ...state.allowlist, dirty: allowlistDirty },
    chunked: { ...state.chunked, dirty: state.chunked.draft !== (savedNow2.chunkedReplies ?? false) },
    maxChunks: { ...state.maxChunks, dirty: state.chunked.draft && state.maxChunks.draft !== String(savedNow2.maxChunks ?? 8) },
    delayFactor: { ...state.delayFactor, dirty: state.chunked.draft && state.delayFactor.draft !== String(savedNow2.delayFactor ?? 1) },
    maxChunksError,
    delayFactorError,
    warning: entries.length === 0 ? 'empty' : null,
    canSave: !state.saving && !hasInvalid && !addPending && !maxChunksError && !delayFactorError
      && (localeDirty || allowlistDirty || styleDirty),
  };
}

/** 用已保存基准重算派生字段（宿主快照变化后调用）。 */
export function withDerived(
  state: SettingsCardState,
  saved: SavedBaseline,
): SettingsCardState {
  return derive(state, saved);
}

/** 改语言草稿。 */
/** 已保存基准（含风格字段；controller 从宿主快照取）。 */
export interface SavedBaseline {
  readonly locale: LocaleOption;
  readonly allowlist: readonly string[];
  readonly chunkedReplies?: boolean;
  readonly maxChunks?: number;
  readonly delayFactor?: number;
}

export function setLocaleDraft(
  state: SettingsCardState,
  draft: string,
  saved: SavedBaseline,
): SettingsCardState {
  return derive({ ...state, locale: { draft, dirty: false } }, saved);
}

/** 只换新增行、不动 dirty 判定（打开/输入/取消都不该冲掉已有改动）。 */
function withAdding(state: SettingsCardState, adding: AddEntryState): SettingsCardState {
  const addPending = adding.active && adding.error !== null;
  const hasInvalid = state.entries.some((entry) => entry.key === null);
  return {
    ...state,
    adding,
    canSave: !state.saving && !hasInvalid && !addPending
      && (state.locale.dirty || state.allowlist.dirty),
  };
}

/** 打开新增行（空输入、无错误）。 */
export function beginAdd(state: SettingsCardState): SettingsCardState {
  return withAdding(state, { active: true, input: '', error: null });
}

/** 新增行输入变化：实时校验（错误码进状态，文案由 view 翻译）。 */
export function updateAddDraft(state: SettingsCardState, input: string): SettingsCardState {
  if (!state.adding.active) return state;
  return withAdding(state, { active: true, input, error: validateAdd(input, state.entries) });
}

/** 确认新增：合法则入列并收起；非法/重复/空输入则原地反馈。 */
export function confirmAdd(
  state: SettingsCardState,
  saved: SavedBaseline,
): SettingsCardState {
  if (!state.adding.active) return state;
  const trimmed = state.adding.input.trim();
  if (!trimmed) return derive({ ...state, adding: ADDING_CLOSED }, saved);
  const error = validateAdd(state.adding.input, state.entries);
  if (error !== null) {
    // 输入保留、行保持打开：用户改完再确认
    return derive({ ...state, adding: { active: true, input: state.adding.input, error } }, saved);
  }
  return derive(
    {
      ...state,
      allowlist: { ...state.allowlist, draft: [...state.allowlist.draft, trimmed] },
      adding: ADDING_CLOSED,
    },
    saved,
  );
}

/** 取消新增：收起并清空（错误也一并清掉）。 */
export function cancelAdd(state: SettingsCardState): SettingsCardState {
  if (!state.adding.active) return state;
  return withAdding(state, ADDING_CLOSED);
}

/** 改分段开关（关掉时子输入的校验错误随之清零）。 */
export function setChunkedDraft(state: SettingsCardState, draft: boolean, saved: SavedBaseline): SettingsCardState {
  return derive({ ...state, chunked: { draft, dirty: false } }, saved);
}

/** 改最大分段数草稿。 */
export function setMaxChunksDraft(state: SettingsCardState, draft: string, saved: SavedBaseline): SettingsCardState {
  return derive({ ...state, maxChunks: { draft, dirty: false } }, saved);
}

/** 改延时系数草稿。 */
export function setDelayFactorDraft(state: SettingsCardState, draft: string, saved: SavedBaseline): SettingsCardState {
  return derive({ ...state, delayFactor: { draft, dirty: false } }, saved);
}

/** 删除第 index 个条目（越界忽略）。 */
export function removeEntry(
  state: SettingsCardState,
  index: number,
  saved: SavedBaseline,
): SettingsCardState {
  if (index < 0 || index >= state.allowlist.draft.length) return state;
  const draft = state.allowlist.draft.filter((_, position) => position !== index);
  return derive({ ...state, allowlist: { ...state.allowlist, draft } }, saved);
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
  saved: SavedBaseline,
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
  saved: SavedBaseline,
): Promise<SettingsCardState> {
  const entries = parseAllowlist(state.allowlist.draft);
  // 非法条目 / 未修正的新增输入不该走到这里（canSave 已拦），写入口自保
  if (entries.some((entry) => entry.key === null)) return state;
  if (state.adding.active && state.adding.error !== null) return state;
  if (state.chunked.draft && (state.maxChunksError || state.delayFactorError)) return state;
  const saving = beginSave(state);
  const locale: LocaleOption = state.locale.draft === 'en' ? 'en' : 'zh';
  // 开关关闭时草稿可能残留不可解析文本：回退已保存值（界面本就不显示）
  const maxChunks = validMaxChunksDraft(state.maxChunks.draft)
    ? Number.parseInt(state.maxChunks.draft.trim(), 10)
    : (saved.maxChunks ?? 8);
  const delayFactor = validDelayFactorDraft(state.delayFactor.draft)
    ? Number.parseFloat(state.delayFactor.draft.trim())
    : (saved.delayFactor ?? 1);
  // 数组字段整体覆盖：顺序即用户操作顺序；全部字段一次写（原子）
  const ops: readonly FieldOp[] = [
    { op: 'set', path: ['locale'], value: locale },
    { op: 'set', path: ['allowlist'], value: entries.map((entry) => entry.raw) },
    { op: 'set', path: ['chunkedReplies'], value: state.chunked.draft },
    { op: 'set', path: ['maxChunks'], value: maxChunks },
    { op: 'set', path: ['delayFactor'], value: delayFactor },
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
