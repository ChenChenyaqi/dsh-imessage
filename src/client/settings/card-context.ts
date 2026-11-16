// 卡片级 context：宿主基准、原子写面、草稿 store 与界面词条。
// 子组件的域 hook 从这里自取（hooks 下沉，无 props drilling）。

import { createContext, useContext } from 'react';

import { settingsMessages } from '../i18n/text';
import type { PresetRemote } from './preset/logic';
import type { DraftStore } from './draft-store';
import type { FieldOp, SavedBaseline } from './useCardForm';

export interface CardContextValue {
  readonly store: DraftStore;
  readonly saved: SavedBaseline;
  mutate(ops: readonly FieldOp[]): Promise<boolean>;
  readonly messages: (typeof settingsMessages)['zh' | 'en'];
  /** Agent presets 的 remote 通道（preset 域下拉拉取用；缺失 = 空降级）。 */
  readonly remote?: PresetRemote;
}

const CardContext = createContext<CardContextValue | null>(null);

export const CardProvider = CardContext.Provider;

/**
 * 取卡片 context（必须在 CardProvider 内使用）。
 * @returns context 值。
 */
export function useCardContext(): CardContextValue {
  const value = useContext(CardContext);
  if (value === null) throw new Error('useCardContext requires CardProvider');
  return value;
}
