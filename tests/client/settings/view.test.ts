// 设置卡片组件规格（Step 3，测试先行）。
//
// 组件刻意做成无 hook 纯函数（state 由 controller 提供）：测试可以直接
// 调用它拿到 React 元素树，遍历断言 props 与事件转发，不需要 jsdom。
//
// 组件选型依据真机事实（2026-11-12）：宿主共享的
// `@deepseek-ai/dsh-client-ui-primitives`（0.0.1-rc.1）只导出
// Button / Input（单行）/ StateDot / Pill / Tooltip / Menu——**没有**
// ConfigField / Switch / SegmentedControl。所以两个字段用原生
// select / textarea + DSH 令牌（--dsw-alias-*），动作按钮用 primitives.

import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Button } from '@deepseek-ai/dsh-client-ui-primitives';

import { SettingsCardView } from '@/client/settings/view';
import {
  initialState,
  setAllowlistDraft,
  type SettingsCardState,
} from '@/client/settings/card';

const PHONE = '+8613800000000';
const saved = { locale: 'zh' as const, allowlist: [PHONE] };

/** 组件文案注入（真机里来自 i18n）。 */
const text = {
  localeLabel: 'Reply language',
  allowlistLabel: 'Allowed contacts',
  allowlistHint: 'One phone number per line',
  emptyWarn: 'Empty allowlist rejects everyone',
  invalidWarn: 'Some entries are not valid phone numbers',
  save: 'Save',
  saving: 'Saving…',
  loading: 'Loading…',
};

type AnyElement = ReactElement<Record<string, unknown>>;

/** 深度遍历元素树（字符串子节点忽略）。 */
function collect(node: ReactNode, out: AnyElement[] = []): AnyElement[] {
  if (Array.isArray(node)) {
    for (const child of node) collect(child as ReactNode, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const element = node as AnyElement;
  out.push(element);
  const children = element.props['children'];
  if (children !== undefined) collect(children as ReactNode, out);
  return out;
}

/** 按原生标签或组件身份找元素。 */
function find(tree: ReactNode, tag: string | unknown): AnyElement[] {
  return collect(tree).filter((element) => element.type === tag);
}

/** 树里所有字符串子节点拼起来（断言可见文案）。 */
function textOf(tree: ReactNode): string {
  return collect(tree)
    .flatMap((element) => {
      const children = element.props['children'];
      return typeof children === 'string' ? [children] : [];
    })
    .join(' ');
}

function makeProps(state: SettingsCardState, overrides: Record<string, unknown> = {}) {
  return {
    state,
    text,
    onLocaleChange: vi.fn(),
    onAllowlistChange: vi.fn(),
    onSave: vi.fn(),
    ...overrides,
  };
}

/** 已改动的可保存状态。 */
function dirtyState(): SettingsCardState {
  return setAllowlistDraft(
    initialState({ value: { locale: 'zh', allowlist: [PHONE] } }),
    `${PHONE}\n+8613900000000`,
    saved,
  );
}

describe('settings card view · locale field', () => {
  it('renders a select limited to the schema locales', () => {
    const tree = SettingsCardView(makeProps(initialState({ value: { locale: 'zh', allowlist: [PHONE] } })));

    const [select] = find(tree, 'select');
    expect(select?.props['value']).toBe('zh');
    // 值域必须与 Config schema 的 zh/en 一致
    const options = find(select, 'option').map((option) => option.props['value']);
    expect(options).toEqual(['zh', 'en']);
  });

  it('forwards locale edits', () => {
    const props = makeProps(initialState({ value: { locale: 'zh', allowlist: [PHONE] } }));
    const tree = SettingsCardView(props);

    (find(tree, 'select')[0]?.props['onChange'] as (event: { target: { value: string } }) => void)({
      target: { value: 'en' },
    });

    expect(props.onLocaleChange).toHaveBeenCalledWith('en');
  });
});

describe('settings card view · allowlist field', () => {
  it('renders the draft as free text (one entry per line)', () => {
    const state = setAllowlistDraft(
      initialState({ value: { locale: 'zh', allowlist: [PHONE] } }),
      `${PHONE}\n+8613900000000`,
      saved,
    );
    const tree = SettingsCardView(makeProps(state));

    const [textarea] = find(tree, 'textarea');
    expect(textarea?.props['value']).toBe(`${PHONE}\n+8613900000000`);
  });

  it('shows the per-line hint', () => {
    const tree = SettingsCardView(makeProps(initialState({ value: { locale: 'zh', allowlist: [PHONE] } })));

    expect(textOf(tree)).toContain(text.allowlistHint);
  });

  it('forwards allowlist edits', () => {
    const props = makeProps(initialState({ value: { locale: 'zh', allowlist: [PHONE] } }));
    const tree = SettingsCardView(props);

    (find(tree, 'textarea')[0]?.props['onChange'] as (event: { target: { value: string } }) => void)({
      target: { value: '+8613900000000' },
    });

    expect(props.onAllowlistChange).toHaveBeenCalledWith('+8613900000000');
  });
});

describe('settings card view · feedback', () => {
  it('warns that an empty allowlist rejects everyone', () => {
    const tree = SettingsCardView(makeProps(initialState({ value: { locale: 'zh', allowlist: [] } })));

    expect(textOf(tree)).toContain(text.emptyWarn);
  });

  it('marks unparseable entries inline', () => {
    // 非法行必须可见，否则用户不知道保存按钮为什么灰着
    const state = setAllowlistDraft(
      initialState({ value: { locale: 'zh', allowlist: [PHONE] } }),
      'nope',
      saved,
    );
    const tree = SettingsCardView(makeProps(state));

    expect(textOf(tree)).toContain(text.invalidWarn);
    expect(find(tree, 'textarea')[0]?.props['aria-invalid']).toBe(true);
  });

  it('shows the save error without losing the draft', () => {
    const state = { ...dirtyState(), error: 'save failed' };
    const tree = SettingsCardView(makeProps(state));

    expect(textOf(tree)).toContain('save failed');
  });

  it('shows only the loading text before the host snapshot arrives', () => {
    const loading: SettingsCardState = { ...initialState({}), ready: false };
    const tree = SettingsCardView(makeProps(loading));

    expect(textOf(tree)).toContain(text.loading);
    expect(find(tree, 'select')).toHaveLength(0);
    expect(find(tree, 'textarea')).toHaveLength(0);
  });
});

describe('settings card view · save action', () => {
  it('disables the button when nothing changed', () => {
    const tree = SettingsCardView(makeProps(initialState({ value: { locale: 'zh', allowlist: [PHONE] } })));

    const [button] = find(tree, Button);
    expect(button?.props['disabled']).toBe(true);
    expect(button?.props['children']).toBe(text.save);
  });

  it('enables the button after a change and forwards the click', () => {
    const props = makeProps(dirtyState());
    const tree = SettingsCardView(props);

    const [button] = find(tree, Button);
    expect(button?.props['disabled']).toBe(false);
    (button?.props['onClick'] as () => void)();
    expect(props.onSave).toHaveBeenCalledTimes(1);
  });

  it('labels the in-flight state and blocks a second click', () => {
    const state = { ...dirtyState(), saving: true, canSave: false };
    const tree = SettingsCardView(makeProps(state));

    const [button] = find(tree, Button);
    expect(button?.props['children']).toBe(text.saving);
    expect(button?.props['disabled']).toBe(true);
  });
});
