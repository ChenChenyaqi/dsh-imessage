// 预设下拉（方案 D：hook 就地执行，词条从卡片 context 自取）：
// roster 选项 + 生效值兜底。
// data-field="preset" 是 e2e 的 DOM 契约，不许丢。

import { type ChangeEvent } from 'react';

import { useCardContext } from '../card-context';
import { controlStyle, errorStyle, fieldStyle, hintStyle, labelStyle } from '../styles';
import { effectivePreset, presetChoices } from './logic';
import { usePreset } from './usePreset';

/** 预设下拉字段。 */
export function PresetSelect() {
  const { messages } = useCardContext();
  const { draft, options, presetError, setDraft } = usePreset();

  return (
    <label style={fieldStyle}>
      <span style={labelStyle}>{messages.presetLabel}</span>
      <select
        data-field="preset"
        value={effectivePreset(draft, options)}
        style={controlStyle}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => {
          setDraft(event.target.value);
        }}
      >
        {presetChoices(draft, options).map((option) => (
          <option key={option.id} value={option.id}>
            {option.isDefault ? `${option.label} · 默认` : option.label}
          </option>
        ))}
      </select>
      <span style={hintStyle}>{messages.presetHint}</span>
      {presetError && <p style={errorStyle}>{messages.presetErrorText}</p>}
    </label>
  );
}
