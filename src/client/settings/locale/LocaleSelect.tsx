// 语言下拉（方案 D：hook 就地执行，词条从卡片 context 自取）。
//
// 语言名用各自的语言自述（中文 / English），不随界面语言变。

import { type ChangeEvent } from 'react';

import { useCardContext } from '../card-context';
import { controlStyle, fieldStyle, hintStyle, labelStyle } from '../styles';
import { LOCALE_OPTIONS } from './logic';
import { useLocaleDraft } from './useLocaleDraft';

/** 语言选择字段。 */
export function LocaleSelect() {
  const { messages } = useCardContext();
  const { draft, setDraft } = useLocaleDraft();

  return (
    <label style={fieldStyle}>
      <span style={labelStyle}>{messages.localeLabel}</span>
      <select
        value={draft}
        style={controlStyle}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => {
          setDraft(event.target.value as (typeof LOCALE_OPTIONS)[number]);
        }}
      >
        {LOCALE_OPTIONS.map((value) => (
          <option key={value} value={value}>
            {value === 'zh' ? '中文' : 'English'}
          </option>
        ))}
      </select>
      {/* hint 必须在场：标签「回复语言」曾让用户误以为能控制大模型的语言 */}
      <span style={hintStyle}>{messages.localeHint}</span>
    </label>
  );
}
