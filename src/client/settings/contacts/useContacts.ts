// useContacts：称呼草稿（M7 α 回退定案：基准 = saved.contacts，宿主推送
// 自动跟随；无 RPC、无独立拉取）。
//
// 行内编辑 = store.peerNames 覆盖（draft wins：宿主推送同字段不冲掉
// 未保存的编辑）。行集派生自白名单草稿 ∪ 基准（logic.peerRows）。

import { useCardContext } from '../card-context';
import { useDraftField } from '../useDraftField';
import { contactsDraftView, type ContactsDraftView } from './logic';

/** useContacts 的返回面。 */
export interface UseContacts extends ContactsDraftView {
  setPeerName(handle: string, value: string): void;
}

/**
 * 称呼草稿与行集（在 ContactsSection 内执行）。
 * @returns 草稿视图与行内编辑动作。
 */
export function useContacts(): UseContacts {
  const { store, saved } = useCardContext();
  const override = useDraftField(store, 'peerNames');
  const allowlistOverride = useDraftField(store, 'allowlist');
  const allowlistDraft = allowlistOverride ?? saved.allowlist;

  return {
    ...contactsDraftView(override, saved.contacts ?? {}, allowlistDraft),
    setPeerName(handle: string, value: string) {
      store.set('peerNames', { ...(store.getSnapshot().peerNames ?? {}), [handle]: value });
    },
  };
}
