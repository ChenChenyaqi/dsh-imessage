// 白名单字段（方案 D：hook 就地执行，词条从卡片 context 自取）：
// chips 列表 + 按需展开的新增行。
//
// 白名单交互（方案 A）：平时只有「添加号码」按钮；点开才出现一行输入；
// 校验不过（格式错 / 重复）不允许加入列表，也不允许保存。

import { type CSSProperties, type KeyboardEvent } from 'react';

import { Button, Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives';

import { useCardContext } from '../card-context';
import { errorStyle, fieldStyle, hintStyle, labelStyle, warnStyle } from '../styles';
import { useAllowlist } from './useAllowlist';

/** chip 列表：自动换行的一行行条目。 */
const chipsStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
};

const chipStyle = (invalid: boolean): CSSProperties => ({
  color: invalid ? 'var(--dsh-alias-state-error-primary)' : 'var(--dsh-alias-label-primary)',
});

/** chip 内的删除小按钮（无文字，只有 × 与 aria-label）。 */
const chipRemoveStyle: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  padding: '0 0 0 4px',
  cursor: 'pointer',
  fontSize: '12px',
  lineHeight: 1,
};

/** 新增行：输入 + 确认/取消。 */
const addRowStyle: CSSProperties = {
  display: 'flex',
  gap: '6px',
  alignItems: 'center',
};

/** 白名单字段。 */
export function AllowlistSection() {
  const { messages } = useCardContext();
  const { entries, adding, hasInvalid } = useAllowlist();

  return (
    <div style={fieldStyle}>
      <span style={labelStyle}>{messages.allowlistLabel}</span>
      {/* 空白名单 = 全拒（makePolicy 语义），必须在界面上显式提示 */}
      {entries.length === 0 && adding.active === false && (
        <p style={warnStyle}>{messages.emptyWarn}</p>
      )}
      <div style={chipsStyle}>
        {entries.map((entry, index) => (
          <Pill key={`${index}:${entry.raw}`} style={chipStyle(entry.key === null)}>
            {entry.raw}
            <RemoveChipButton index={index} />
          </Pill>
        ))}
      </div>
      {hasInvalid && <p style={errorStyle}>{messages.invalidWarn}</p>}

      {adding.active ? <AddEntryRow /> : <BeginAddButton />}
      <span style={hintStyle}>{messages.allowlistHint}</span>
    </div>
  );
}

/** chip 内的删除按钮（单独小组件：要从 hook 拿 removeEntry）。 */
function RemoveChipButton(props: { readonly index: number }) {
  const { messages } = useCardContext();
  const { removeEntry } = useAllowlist();
  return (
    <Button
      aria-label={messages.removeEntry}
      variant="ghost"
      style={chipRemoveStyle}
      onClick={() => removeEntry(props.index)}
    >
      ×
    </Button>
  );
}

/** 「添加号码」按钮（收起态）。 */
function BeginAddButton() {
  const { messages } = useCardContext();
  const { beginAdd } = useAllowlist();
  return (
    <div>
      <Button variant="ghost" onClick={() => beginAdd()}>
        {messages.addNumber}
      </Button>
    </div>
  );
}

/** 新增行：输入 + 确认/取消（展开态）。 */
function AddEntryRow() {
  const { messages } = useCardContext();
  const { adding, updateAddDraft, confirmAdd, cancelAdd } = useAllowlist();

  return (
    <div style={fieldStyle}>
      <div style={addRowStyle}>
        <Input
          value={adding.input}
          aria-invalid={adding.error !== null}
          placeholder={messages.allowlistHint}
          onChange={(event) => {
            updateAddDraft(event.target.value);
          }}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === 'Enter') confirmAdd();
            if (event.key === 'Escape') cancelAdd();
          }}
        />
        <Button onClick={() => confirmAdd()}>{messages.confirmAdd}</Button>
        <Button variant="ghost" onClick={() => cancelAdd()}>
          {messages.cancel}
        </Button>
      </div>
      {adding.error === 'invalid' && <p style={errorStyle}>{messages.invalidNumber}</p>}
      {adding.error === 'duplicate' && <p style={errorStyle}>{messages.duplicateNumber}</p>}
    </div>
  );
}
