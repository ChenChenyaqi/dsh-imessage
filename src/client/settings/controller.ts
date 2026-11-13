// 卡片控制器：宿主表单 ↔ 视图之间的粘合层（零 React，可在 node 里单测）。
//
// 职责：
// - 订阅宿主表单快照，把值转成卡片状态
// - 维护「用户草稿」与「已保存基准」，重算 dirty / canSave
// - 保存时一次原子写入两个字段
//
// 与 card.ts 的分工：card.ts 只做纯变换（值 → 新状态），本文件只做
// 时序与订阅（何时读、何时写、何时通知）。

import {
  beginAdd,
  beginSave,
  cancelAdd,
  confirmAdd,
  initialState,
  readAllowlist,
  readLocale,
  removeEntry,
  save,
  setLocaleDraft,
  updateAddDraft,
  withDerived,
  type CardTexts,
  type FieldOp,
  type SettingsCardState,
} from './card';

/** 宿主表单（ConfigForm 的最小面：读快照、订阅、原子写）。 */
export interface CardForm {
  getSnapshot(): { value?: Readonly<Record<string, unknown>> | undefined };
  subscribe(listener: () => void): () => void;
  mutate(ops: readonly FieldOp[]): Promise<boolean>;
}

/** 卡片控制器。 */
export interface CardController {
  /** 写入的宿主命名空间（= 我们的 entry id，不是菜单 id）。 */
  readonly namespace: string;
  /** 供 useSyncExternalStore 读取（同值同引用，避免无意义重渲染）。 */
  getSnapshot(): SettingsCardState;
  subscribe(listener: () => void): () => void;
  setLocaleDraft(value: string): void;
  beginAdd(): void;
  updateAddDraft(value: string): void;
  confirmAdd(): void;
  cancelAdd(): void;
  removeEntry(index: number): void;
  /** 丢弃草稿回到宿主已保存值（视图卸载时调用：关页 = 不保存）。 */
  reset(): void;
  save(): Promise<void>;
  dispose(): void;
}

/**
 * 由宿主表单构造控制器。
 * @param deps.namespace - 写入的 entry id。
 * @param deps.form - 宿主表单面。
 * @param deps.texts - 文案（保存失败提示）。
 * @returns 控制器实例。
 */
export function createCardController(deps: {
  readonly namespace: string;
  readonly form: CardForm;
  readonly texts: CardTexts;
}): CardController {
  let state = initialState(deps.form.getSnapshot());
  let disposed = false;
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of listeners) listener();
  };

  /** 已保存基准（dirty 比较用）。 */
  const savedNow = () => {
    const snapshot = deps.form.getSnapshot();
    return { locale: readLocale(snapshot), allowlist: readAllowlist(snapshot) };
  };

  // 宿主推来新值：重算 dirty，但保留用户正在编辑的草稿（不冲掉输入）
  const unsubscribe = deps.form.subscribe(() => {
    const saved = savedNow();
    const next = initialState(deps.form.getSnapshot());
    state = withDerived(
      {
        ...next,
        locale: state.locale.dirty ? state.locale : next.locale,
        allowlist: state.allowlist.dirty ? state.allowlist : next.allowlist,
        adding: state.adding,
        saving: state.saving,
        error: state.error,
      },
      saved,
    );
    emit();
  });

  return {
    namespace: deps.namespace,
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setLocaleDraft(value) {
      state = setLocaleDraft(state, value, savedNow());
      emit();
    },
    beginAdd() {
      state = beginAdd(state);
      emit();
    },
    updateAddDraft(value) {
      state = updateAddDraft(state, value);
      emit();
    },
    confirmAdd() {
      state = confirmAdd(state, savedNow());
      emit();
    },
    cancelAdd() {
      state = cancelAdd(state);
      emit();
    },
    removeEntry(index) {
      state = removeEntry(state, index, savedNow());
      emit();
    },
    reset() {
      state = initialState(deps.form.getSnapshot());
      emit();
    },
    async save() {
      if (!state.canSave) return;
      state = beginSave(state);
      emit();
      state = await save(
        {
          form: { mutate: (ops) => deps.form.mutate(ops) },
          texts: deps.texts,
          readSnapshot: () => deps.form.getSnapshot(),
        },
        state,
        savedNow(),
      );
      emit();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      listeners.clear();
    },
  };
}
