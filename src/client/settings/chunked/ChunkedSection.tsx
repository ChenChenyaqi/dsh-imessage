// 分段回复字段（方案 D：hook 就地执行，词条从卡片 context 自取）：
// 开关 + 开启时的两个数字输入。

import { type ChangeEvent } from 'react';

import { Input } from '@deepseek-ai/dsh-client-ui-primitives';

import { useCardContext } from '../card-context';
import { errorStyle, fieldStyle, hintStyle, labelStyle } from '../styles';
import { useChunkedDrafts } from './useChunked';

/** 分段回复字段。 */
export function ChunkedSection() {
  const { messages } = useCardContext();
  const {
    chunked,
    maxChunks,
    delayFactor,
    maxChunksError,
    delayFactorError,
    setChunked,
    setMaxChunks,
    setDelayFactor,
  } = useChunkedDrafts();

  return (
    <div style={fieldStyle}>
      <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: '8px' }}>
        {/* 原生 checkbox：primitives 没有 Switch；样式走令牌 */}
        <input
          type="checkbox"
          checked={chunked}
          style={{ accentColor: 'var(--dsh-alias-label-primary)' }}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            setChunked(event.target.checked);
          }}
        />
        {messages.chunkedLabel}
      </label>
      <span style={hintStyle}>{messages.chunkedHint}</span>
      {chunked && (
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <label style={{ ...fieldStyle, flex: '1 1 120px', marginBottom: 0 }}>
            <span style={labelStyle}>{messages.maxChunksLabel}</span>
            <Input
              type="number"
              min={1}
              max={50}
              step={1}
              value={maxChunks}
              aria-invalid={maxChunksError}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                setMaxChunks(event.target.value);
              }}
            />
            {maxChunksError && <p style={errorStyle}>{messages.maxChunksErrorText}</p>}
          </label>
          <label style={{ ...fieldStyle, flex: '1 1 120px', marginBottom: 0 }}>
            <span style={labelStyle}>{messages.delayFactorLabel}</span>
            <Input
              type="number"
              min={0}
              max={5}
              step={0.1}
              value={delayFactor}
              aria-invalid={delayFactorError}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                setDelayFactor(event.target.value);
              }}
            />
            <span style={hintStyle}>{messages.delayFactorHint}</span>
            {delayFactorError && <p style={errorStyle}>{messages.delayFactorErrorText}</p>}
          </label>
        </div>
      )}
    </div>
  );
}
