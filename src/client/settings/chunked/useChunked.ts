// useChunkedDrafts：分段回复三值草稿（开关 + 最大分段数 + 延时系数）。
//
// 方案 D：三字段各自覆盖（store 独立键），未编辑的字段跟随宿主推送；
// dirty/报错判定在 logic.chunkedDraftView（与保存聚合单点共用），
// 子字段只在开关开启时参与（关闭时子输入不可见，错误随之清零）。

import { useCardContext } from '../card-context';
import { useDraftField } from '../useDraftField';
import { chunkedDraftView, type ChunkedDraftView } from './logic';

/** useChunkedDrafts 的返回面。 */
export type UseChunkedDrafts = ChunkedDraftView & {
  setChunked(value: boolean): void;
  setMaxChunks(value: string): void;
  setDelayFactor(value: string): void;
};

/**
 * 分段回复草稿状态（在 ChunkedSection 内执行）。
 * @returns 三值草稿、派生旗标与编辑动作。
 */
export function useChunkedDrafts(): UseChunkedDrafts {
  const { store, saved } = useCardContext();
  const chunkedOverride = useDraftField(store, 'chunked');
  const maxChunksOverride = useDraftField(store, 'maxChunks');
  const delayFactorOverride = useDraftField(store, 'delayFactor');

  const view = chunkedDraftView(
    {
      chunked: chunkedOverride,
      maxChunks: maxChunksOverride,
      delayFactor: delayFactorOverride,
    },
    saved,
  );

  return {
    ...view,
    setChunked(value) {
      store.set('chunked', value);
    },
    setMaxChunks(value) {
      store.set('maxChunks', value);
    },
    setDelayFactor(value) {
      store.set('delayFactor', value);
    },
  };
}
