// 设置卡片共享样式令牌（DSH 设计令牌 --dsw-alias-*，不引第三方）。
// 字段级的私有样式（chip 列表、新增行等）留在各自组件目录内。

import { type CSSProperties } from 'react';

/** 字段外框：标签 + 控件 + 说明。 */
export const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  marginBottom: '18px',
};

export const labelStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  fontSize: '13px',
  fontWeight: 500,
};

export const hintStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: '12px',
};

/** 原生 select 的共用样式。 */
export const controlStyle: CSSProperties = {
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

export const errorStyle: CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary)',
  fontSize: '12px',
  margin: 0,
};

export const warnStyle: CSSProperties = {
  color: 'var(--dsw-alias-state-warn-primary)',
  fontSize: '12px',
};
