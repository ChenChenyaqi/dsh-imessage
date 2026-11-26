// 表单级草稿 override store（方案 D）：字段未编辑 = undefined（跟随 saved
// 基准），编辑过 = 覆盖值（dirty 草稿赢）。
//
// 纯 TS、无 React：快照不可变且引用缓存（useSyncExternalStore 契约），
// set 只在值真正变化时通知。订阅是广播制，细粒度过滤由 React 的
// getSnapshot 引用比较完成 —— 不需要 selector 基建。

import type { AddEntryState } from './allowlist/logic';
import type { PeerNamesDraft } from './contacts/logic';
import type { PresetOption } from './preset/logic';

/** 各字段的草稿覆盖值（undefined = 未编辑）。 */
export interface DraftOverrides {
  readonly locale?: string;
  /** 白名单条目序列（formatAllowlist 形状；条目原样保存，只清洗空白）。 */
  readonly allowlist?: readonly string[];
  readonly chunked?: boolean;
  readonly maxChunks?: string;
  readonly delayFactor?: string;
  /** Agent 预设 id（未设置 = undefined）。 */
  readonly agentPreset?: string;
  /** remote roster 拉取后的下拉选项（remote 态，preset 域写入，保存聚合读）。 */
  readonly presetOptions?: readonly PresetOption[];
  /** 白名单添加行（收起 = undefined）。 */
  readonly adding?: AddEntryState;
  /** M7 称呼草稿（键 → 用户输入；未编辑 = undefined 跟随基准）。 */
  readonly peerNames?: PeerNamesDraft;
}

export interface DraftStore {
  getSnapshot(): DraftOverrides;
  subscribe(listener: () => void): () => void;
  set<K extends keyof DraftOverrides>(key: K, value: DraftOverrides[K]): void;
}

/**
 * 创建草稿 store（每张卡片一个，随宿主组件生命周期销毁）。
 * @returns store 面。
 */
export function createDraftStore(): DraftStore {
  let snapshot: DraftOverrides = {};
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(key, value) {
      if (snapshot[key] === value) return;
      snapshot = { ...snapshot, [key]: value };
      for (const listener of listeners) listener();
    },
  };
}
