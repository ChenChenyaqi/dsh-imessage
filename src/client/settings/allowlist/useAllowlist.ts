// useAllowlist：白名单草稿 + 新增行（override 模式，订阅卡片 context）。
//
// 未编辑（store 无覆盖）→ draft 直接取 saved，宿主推送自动跟随；
// 编辑过 → 覆盖值持有用户草稿，宿主推送同字段不冲掉（draft wins，
// 锁定语义见 useAllowlist.test 的 same-field push 用例）。
//
// 对齐 core 的事实：条目原样保存（宿主 config 是 string[]），只做空白清洗。
// dirty/invalid 判定在 logic.allowlistDraftView（与保存聚合单点共用）。

import {
  validateAdd,
  allowlistDraftView,
  addEntryPending,
  type AddEntryState,
  type AllowlistEntry,
  type AllowlistWarning,
} from './logic';
import { useCardContext } from '../card-context';
import { useDraftField } from '../useDraftField';

/** 收起态的新增行（复位用）。 */
const ADDING_CLOSED: AddEntryState = { active: false, input: '', error: null };

/** useAllowlist 的返回面。 */
export interface UseAllowlist {
  readonly draft: readonly string[];
  /** 解析后的条目（含非法条目，供界面逐个标注）。 */
  readonly entries: readonly AllowlistEntry[];
  readonly adding: AddEntryState;
  readonly dirty: boolean;
  /** 空白名单提示（"能保存但危险"：空 = 全拒）。 */
  readonly warning: AllowlistWarning;
  readonly hasInvalid: boolean;
  /** 新增行有未修正的错误输入（拦保存）。 */
  readonly addPending: boolean;
  beginAdd(): void;
  updateAddDraft(value: string): void;
  confirmAdd(): void;
  cancelAdd(): void;
  removeEntry(index: number): void;
}

/**
 * 白名单草稿状态（在 AllowlistSection 内执行）。
 * @returns 草稿、派生旗标与编辑动作。
 */
export function useAllowlist(): UseAllowlist {
  const { store, saved } = useCardContext();
  const override = useDraftField(store, 'allowlist');
  const adding = useDraftField(store, 'adding') ?? ADDING_CLOSED;

  const view = allowlistDraftView(override, saved.allowlist);
  const entries = view.entries;

  return {
    ...view,
    adding,
    warning: entries.length === 0 ? 'empty' : null,
    addPending: addEntryPending(adding),
    beginAdd() {
      store.set('adding', { active: true, input: '', error: null });
    },
    updateAddDraft(value) {
      if (!adding.active) return;
      store.set('adding', { ...adding, input: value, error: validateAdd(value, entries) });
    },
    confirmAdd() {
      if (!adding.active) return;
      const trimmed = adding.input.trim();
      if (!trimmed) {
        // 空输入 = 收起（同取消）
        store.set('adding', ADDING_CLOSED);
        return;
      }
      const error = validateAdd(adding.input, entries);
      if (error !== null) {
        // 输入保留、行保持打开：用户改完再确认
        store.set('adding', { ...adding, error });
        return;
      }
      store.set('allowlist', [...view.draft, trimmed]);
      store.set('adding', ADDING_CLOSED);
    },
    cancelAdd() {
      store.set('adding', ADDING_CLOSED);
    },
    removeEntry(index) {
      if (index < 0 || index >= view.draft.length) return;
      store.set(
        'allowlist',
        view.draft.filter((_, position) => position !== index),
      );
    },
  };
}
