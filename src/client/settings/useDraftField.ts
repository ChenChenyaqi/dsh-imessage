// 域 hook 订阅草稿切片：细粒度过滤靠 useSyncExternalStore 的引用比较
// （值未变的字段不触发重渲染），无 selector 基建。

import { useSyncExternalStore } from 'react';

import type { DraftOverrides, DraftStore } from './draft-store';

/**
 * 订阅单个草稿字段。
 * @param store - 草稿 store。
 * @param key - 字段名。
 * @returns 覆盖值（undefined = 未编辑）。
 */
export function useDraftField<K extends keyof DraftOverrides>(
  store: DraftStore,
  key: K,
): DraftOverrides[K] {
  return useSyncExternalStore(store.subscribe, () => store.getSnapshot()[key]);
}
