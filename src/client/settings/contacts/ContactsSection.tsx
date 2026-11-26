// 称呼字段（M7）：白名单号码行内称呼编辑。
//
// 行集 = 白名单草稿（归一化后的键）∪ 称呼基准（手编文件键不丢）；
// 空输入 = 清除该号码称呼。保存走 SaveBar（与 config 域一次按钮，
// RPC 写 contacts.json + 热更重发在 useSave 聚合里）。

import { type ChangeEvent, type CSSProperties } from 'react';

import { Input } from '@deepseek-ai/dsh-client-ui-primitives';

import { useCardContext } from '../card-context';
import { fieldStyle, hintStyle, labelStyle } from '../styles';
import { useContacts } from './useContacts';

const rowStyle: CSSProperties = {
  display: 'flex',
  gap: '6px',
  alignItems: 'center',
  marginBottom: '6px',
};

const handleStyle: CSSProperties = {
  minWidth: '140px',
  fontSize: '13px',
  color: 'var(--dsh-alias-label-secondary)',
};

/** 称呼字段。 */
export function ContactsSection() {
  const { messages } = useCardContext();
  const { rows, setPeerName } = useContacts();

  return (
    <div style={fieldStyle}>
      <span style={labelStyle}>{messages.contactsLabel}</span>
      {rows.length === 0 ? (
        <span style={hintStyle}>{messages.contactsEmpty}</span>
      ) : (
        rows.map((row) => (
          <div key={row.handle} style={rowStyle}>
            <span style={handleStyle}>{row.handle}</span>
            <Input
              aria-label={messages.contactsInputLabel.replace('{number}', row.handle)}
              value={row.value}
              placeholder={messages.contactsPlaceholder}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setPeerName(row.handle, event.target.value)
              }
            />
          </div>
        ))
      )}
      <span style={hintStyle}>{messages.contactsHint}</span>
    </div>
  );
}
