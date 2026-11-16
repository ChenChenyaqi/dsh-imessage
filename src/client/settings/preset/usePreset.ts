// usePreset：预设草稿 + remote roster 拉取（官方 Agent presets 页同款通道）。
//
// roster 是 remote 状态：拉取一次写进草稿 store 的 presetOptions 键
// （保存聚合直接读，不靠组件间传递）；服务缺失/调用失败 = 空列表，
// 下拉退化为当前值兜底（PresetSelect 的 presetChoices 兜底）。
// 草稿本身走 store 的 agentPreset 键（override 模式）。

import { useEffect, useRef } from 'react';

import { useCardContext } from '../card-context';
import { useDraftField } from '../useDraftField';
import { presetDraftView, presetOptions, type PresetOption } from './logic';

/** usePreset 的返回面。 */
export interface UsePreset {
  readonly draft: string;
  readonly dirty: boolean;
  readonly presetError: boolean;
  /** roster 加载后的下拉选项（不含当前值兜底：那是渲染期行为）。 */
  readonly options: readonly PresetOption[];
  setDraft(value: string): void;
}

/**
 * 预设草稿与 roster（在 PresetSelect 内执行）。
 * @returns 草稿、旗标与选项。
 */
export function usePreset(): UsePreset {
  const { store, saved, remote, messages } = useCardContext();
  const override = useDraftField(store, 'agentPreset');
  const options = useDraftField(store, 'presetOptions') ?? [];

  // 显示名词典随渲染更新（effect 不依赖它：词典变化不该重拉 roster）
  const namesRef = useRef(messages.presetNames);
  namesRef.current = messages.presetNames;

  // roster 拉取一次（remote 引用稳定：来自 ctx，fiber 生命周期内不变）
  useEffect(() => {
    if (!remote) return;
    let cancelled = false;
    void (async () => {
      const result = await remote.list();
      if (cancelled || !result.ok) return;
      store.set('presetOptions', presetOptions(result.value.presets, namesRef.current));
    })();
    return () => {
      cancelled = true;
    };
  }, [remote, store]);

  return {
    ...presetDraftView(override, saved.agentPreset),
    options,
    setDraft(value) {
      store.set('agentPreset', value);
    },
  };
}
