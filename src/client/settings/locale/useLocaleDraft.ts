// useLocaleDraft：语言草稿（override 模式；订阅卡片 context 的草稿 store）。

import { useCardContext } from '../card-context';
import { useDraftField } from '../useDraftField';
import { localeDraftView, type LocaleOption } from './logic';

export interface UseLocaleDraft {
  readonly draft: LocaleOption;
  readonly dirty: boolean;
  setDraft(value: LocaleOption): void;
}

/**
 * 语言草稿（在 LocaleSelect 内执行；未编辑跟随宿主推送，编辑后锁定）。
 * @returns 草稿值、脏标记与写入面。
 */
export function useLocaleDraft(): UseLocaleDraft {
  const { store, saved } = useCardContext();
  const override = useDraftField(store, 'locale');
  return {
    ...localeDraftView(override, saved.locale),
    setDraft: (value) => store.set('locale', value),
  };
}
