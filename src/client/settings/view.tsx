// 设置卡片视图（Step 3）：纯渲染，零 hook、零副作用。
//
// 为什么无 hook：state 由 settings-card.ts 的 controller 提供，组件只做
// 「state + 回调 → 元素树」。这样单测能直接调用组件遍历元素树断言，
// 不需要 jsdom；渲染细节交由真机无障碍树验收。
//
// 组件选型（真机事实）：宿主共享的 primitives 只有 Button / Input / StateDot
// / Pill / Tooltip / Menu，没有表单字段组件。因此两个字段用原生
// select / textarea，样式只用 DSH 设计令牌（--dsw-alias-*），不引第三方
// CSS，也不进 lightningcss 流程（客户端 bundle 只带 JS）。

import type { CSSProperties, ChangeEvent } from 'react';

import { Button } from '@deepseek-ai/dsh-client-ui-primitives';

import { LOCALE_OPTIONS, type SettingsCardState } from './card';

/** 视图文案（由入口从 i18n 渲染后注入，视图不硬编码语言）。 */
export interface SettingsCardText {
  readonly localeLabel: string;
  readonly allowlistLabel: string;
  readonly allowlistHint: string;
  readonly emptyWarn: string;
  readonly invalidWarn: string;
  readonly save: string;
  readonly saving: string;
  readonly loading: string;
}

export interface SettingsCardViewProps {
  readonly state: SettingsCardState;
  readonly text: SettingsCardText;
  readonly onLocaleChange: (value: string) => void;
  readonly onAllowlistChange: (value: string) => void;
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

/** 原生控件的共用样式。 */
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
};

/**
 * 渲染设置卡片。
 * @param props - controller 状态、文案与三个回调。
 * @returns 元素树（未挂载）。
 */
export function SettingsCardView(props: SettingsCardViewProps) {
  if (!props.state.ready) return <p style={hintStyle}>{props.text.loading}</p>;

  const invalid = props.state.entries.some((entry) => entry.key === null);
  const { state, text } = props;

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
      </label>

      <label style={fieldStyle}>
        <span style={labelStyle}>{text.allowlistLabel}</span>
        <textarea
          value={state.allowlist.draft}
          rows={4}
          spellCheck={false}
          aria-invalid={invalid}
          style={{
            ...controlStyle,
            resize: 'vertical',
            minHeight: '84px',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            ...(invalid ? { borderColor: 'var(--dsw-alias-state-error-primary)' } : {}),
          }}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
            props.onAllowlistChange(event.target.value);
          }}
        />
        <span style={hintStyle}>{text.allowlistHint}</span>
        {state.warning === 'empty'
          ? <span style={{ ...hintStyle, color: 'var(--dsw-alias-state-warn-primary)' }}>{text.emptyWarn}</span>
          : null}
        {invalid ? <span style={errorStyle}>{text.invalidWarn}</span> : null}
      </label>

      {state.error === null
        ? null
        : <p role="status" style={{ ...errorStyle, marginBottom: '12px' }}>{state.error}</p>}

      <Button
        variant="primary"
        size="sm"
        disabled={!state.canSave || state.saving}
        onClick={() => {
          props.onSave();
        }}
      >
        {state.saving ? text.saving : text.save}
      </Button>
    </div>
  );
}
