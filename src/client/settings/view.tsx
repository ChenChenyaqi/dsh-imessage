// 设置卡片纯视图（无 hook：state 与回调全部由 controller 层注入）。
//
// 白名单按方案 A 渲染：条目 = Pill + 删除按钮；「添加号码」按钮按需展开
// 一行输入（平时没有输入框）；校验不过的错误文案直接显示在输入框下面。
//
// 组件选型（真机事实）：宿主共享的 primitives 只有 Button / Input /
// StateDot / Pill / Tooltip / Menu，没有表单字段组件。语言下拉用原生
// select，样式只用 DSH 设计令牌（--dsw-alias-*），不引第三方。

import { type CSSProperties, type ChangeEvent, type KeyboardEvent } from 'react';

import { Button, Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives';

import { LOCALE_OPTIONS, type SettingsCardState } from './card';

/** view 需要的词条（i18n 注入，真机来自 texts.ts）。 */
export interface SettingsCardText {
  readonly localeLabel: string;
  readonly localeHint: string;
  readonly allowlistLabel: string;
  readonly allowlistHint: string;
  readonly emptyWarn: string;
  readonly invalidWarn: string;
  readonly addNumber: string;
  readonly confirmAdd: string;
  readonly cancel: string;
  readonly invalidNumber: string;
  readonly duplicateNumber: string;
  readonly removeEntry: string;
  readonly chunkedLabel: string;
  readonly chunkedHint: string;
  readonly maxChunksLabel: string;
  readonly maxChunksErrorText: string;
  readonly delayFactorLabel: string;
  readonly delayFactorHint: string;
  readonly delayFactorErrorText: string;
  readonly save: string;
  readonly saving: string;
  readonly loading: string;
}

export interface SettingsCardViewProps {
  readonly state: SettingsCardState;
  readonly text: SettingsCardText;
  readonly onLocaleChange: (value: string) => void;
  readonly onBeginAdd: () => void;
  readonly onUpdateAddDraft: (value: string) => void;
  readonly onConfirmAdd: () => void;
  readonly onCancelAdd: () => void;
  readonly onRemoveEntry: (index: number) => void;
  readonly onChunkedChange: (value: boolean) => void;
  readonly onMaxChunksChange: (value: string) => void;
  readonly onDelayFactorChange: (value: string) => void;
  readonly onSave: () => void;
}

/** 字段外框：标签 + 控件 + 说明。 */
const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  marginBottom: '18px',
};

const labelStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  fontSize: '13px',
  fontWeight: 500,
};

const hintStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: '12px',
};

/** 原生 select 的共用样式。 */
const controlStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-layer-2)',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: '8px',
  padding: '8px 10px',
  fontSize: '13px',
  fontFamily: 'inherit',
  width: '100%',
  boxSizing: 'border-box',
};

const errorStyle: CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary)',
  fontSize: '12px',
  margin: 0,
};

const warnStyle: CSSProperties = {
  color: 'var(--dsw-alias-state-warn-primary)',
  fontSize: '12px',
};

/** chip 列表：自动换行的一行行条目。 */
const chipsStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
};

const chipStyle = (invalid: boolean): CSSProperties => ({
  color: invalid
    ? 'var(--dsw-alias-state-error-primary)'
    : 'var(--dsw-alias-label-primary)',
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

/**
 * 渲染设置卡片。
 * @param props - controller 状态、文案与七个回调。
 * @returns 元素树（未挂载）。
 */
export function SettingsCardView(props: SettingsCardViewProps) {
  if (!props.state.ready) return <p style={hintStyle}>{props.text.loading}</p>;

  const { state, text } = props;
  const hasInvalidEntry = state.entries.some((entry) => entry.key === null);

  return (
    <div style={{ maxWidth: '520px' }} data-dsh-imessage-card="">
      <label style={fieldStyle}>
        <span style={labelStyle}>{text.localeLabel}</span>
        <select
          value={state.locale.draft}
          style={controlStyle}
          onChange={(event: ChangeEvent<HTMLSelectElement>) => {
            props.onLocaleChange(event.target.value);
          }}
        >
          {/* 语言名用各自的语言自述（中文 / English），不随界面语言变 */}
          {LOCALE_OPTIONS.map((value) => (
            <option key={value} value={value}>{value === 'zh' ? '中文' : 'English'}</option>
          ))}
        </select>
        <span style={hintStyle}>{text.localeHint}</span>
      </label>

      <div style={fieldStyle}>
        <span style={labelStyle}>{text.allowlistLabel}</span>
        {state.entries.length === 0 && state.adding.active === false && (
          <p style={warnStyle}>{text.emptyWarn}</p>
        )}
        <div style={chipsStyle}>
          {state.entries.map((entry, index) => (
            <Pill key={entry.raw} style={chipStyle(entry.key === null)}>
              {entry.raw}
              <Button
                aria-label={text.removeEntry}
                variant="ghost"
                style={chipRemoveStyle}
                onClick={() => props.onRemoveEntry(index)}
              >
                ×
              </Button>
            </Pill>
          ))}
        </div>
        {hasInvalidEntry && <p style={errorStyle}>{text.invalidWarn}</p>}

        {state.adding.active ? (
          <div style={fieldStyle}>
            <div style={addRowStyle}>
              <Input
                value={state.adding.input}
                aria-invalid={state.adding.error !== null}
                placeholder={text.allowlistHint}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  props.onUpdateAddDraft(event.target.value);
                }}
                onKeyDown={(event: KeyboardEvent) => {
                  if (event.key === 'Enter') props.onConfirmAdd();
                  if (event.key === 'Escape') props.onCancelAdd();
                }}
              />
              <Button onClick={() => props.onConfirmAdd()}>{text.confirmAdd}</Button>
              <Button variant="ghost" onClick={() => props.onCancelAdd()}>{text.cancel}</Button>
            </div>
            {state.adding.error === 'invalid' && <p style={errorStyle}>{text.invalidNumber}</p>}
            {state.adding.error === 'duplicate' && <p style={errorStyle}>{text.duplicateNumber}</p>}
          </div>
        ) : (
          <div>
            <Button variant="ghost" onClick={() => props.onBeginAdd()}>{text.addNumber}</Button>
          </div>
        )}
        <span style={hintStyle}>{text.allowlistHint}</span>
      </div>

      <div style={fieldStyle}>
        <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* 原生 checkbox：primitives 没有 Switch；样式走令牌 */}
          <input
            type="checkbox"
            checked={state.chunked.draft}
            style={{ accentColor: 'var(--dsw-alias-label-primary)' }}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              props.onChunkedChange(event.target.checked);
            }}
          />
          {text.chunkedLabel}
        </label>
        <span style={hintStyle}>{text.chunkedHint}</span>
        {state.chunked.draft && (
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <label style={{ ...fieldStyle, flex: '1 1 120px', marginBottom: 0 }}>
              <span style={labelStyle}>{text.maxChunksLabel}</span>
              <Input
                type="number"
                min={1}
                max={50}
                step={1}
                value={state.maxChunks.draft}
                aria-invalid={state.maxChunksError}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  props.onMaxChunksChange(event.target.value);
                }}
              />
              {state.maxChunksError && <p style={errorStyle}>{text.maxChunksErrorText}</p>}
            </label>
            <label style={{ ...fieldStyle, flex: '1 1 120px', marginBottom: 0 }}>
              <span style={labelStyle}>{text.delayFactorLabel}</span>
              <Input
                type="number"
                min={0}
                max={5}
                step={0.1}
                value={state.delayFactor.draft}
                aria-invalid={state.delayFactorError}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  props.onDelayFactorChange(event.target.value);
                }}
              />
              <span style={hintStyle}>{text.delayFactorHint}</span>
              {state.delayFactorError && <p style={errorStyle}>{text.delayFactorErrorText}</p>}
            </label>
          </div>
        )}
      </div>

      {state.error !== null && <p style={errorStyle}>{state.error}</p>}

      <Button
        variant="primary"
        disabled={!state.canSave || state.saving}
        onClick={() => props.onSave()}
      >
        {state.saving ? text.saving : text.save}
      </Button>
    </div>
  );
}
