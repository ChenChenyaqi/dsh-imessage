// 设置卡片组件规格（Step 3，测试先行）。
//
// 组件刻意做成无 hook 纯函数（state 由 controller 提供）：测试可以直接
// 调用它拿到 React 元素树，遍历断言 props 与事件转发，不需要 jsdom。
//
// 组件选型依据真机事实（2026-11-12）：宿主共享的
// `@deepseek-ai/dsh-client-ui-primitives`（0.0.1-rc.1）只导出
// Button / Input（单行）/ StateDot / Pill / Tooltip / Menu——**没有**
// ConfigField / Switch / SegmentedControl。白名单按方案 A 渲染：
// 条目 = Pill + 删除按钮；新增行按需展开（平时没有输入框）。

import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Button, Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives';

import { SettingsCardView } from '@/client/settings/view';
import {
  beginAdd,
  initialState,
  removeEntry,
  setChunkedDraft,
  setDelayFactorDraft,
  setLocaleDraft,
  presetOptions,
  setMaxChunksDraft,
  setPresetDraft,
  updateAddDraft,
  type SettingsCardState,
} from '@/client/settings/card';

const PHONE = '+8613800000000';
const PHONE_2 = '+8613900000000';
const saved = { locale: 'zh' as const, allowlist: [PHONE] };

/** 组件文案注入（真机里来自 i18n）。 */
const text = {
  localeLabel: 'System message language',
  localeHint: 'Only sets the language of system notices; AI replies are unaffected.',
  allowlistLabel: 'Allowed contacts',
  allowlistHint: 'Phone numbers with country code',
  emptyWarn: 'Empty allowlist rejects everyone',
  invalidWarn: 'Some entries are not valid phone numbers',
  addNumber: 'Add number',
  invalidNumber: 'Not a valid phone number (needs country code, e.g. +8613800000000)',
  duplicateNumber: 'This number is already in the list',
  removeEntry: 'Remove',
  chunkedLabel: 'Chunked replies',
  chunkedHint: 'On: split into bubbles with human pacing. Off: send as one message.',
  maxChunksLabel: 'Max chunks',
  maxChunksErrorText: 'Must be an integer between 1 and 50',
  delayFactorLabel: 'Delay factor',
  delayFactorHint: '0 = chunks without delay',
  delayFactorErrorText: 'Must be a number between 0 and 5 (0 = no delay)',
  presetLabel: 'Agent preset',
  presetHint: 'Persona composition; applies to new sessions only',
  presetErrorText: 'Preset ids use lowercase letters, digits, and dashes',
  confirmAdd: 'Add',
  cancel: 'Cancel',
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

/** 递归抽字符串子节点（数组 children 里的字符串也要，chip 文案在数组里）。 */
function stringsOf(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const child of node) stringsOf(child, out);
  return out;
}

/** 树里所有字符串子节点拼起来（断言可见文案）。 */
function textOf(tree: ReactNode): string {
  return collect(tree)
    .flatMap((element) => stringsOf(element.props['children']))
    .join(' ');
}

function makeProps(state: SettingsCardState, overrides: Record<string, unknown> = {}) {
  return {
    state,
    text,
    onLocaleChange: vi.fn(),
    onBeginAdd: vi.fn(),
    onUpdateAddDraft: vi.fn(),
    onConfirmAdd: vi.fn(),
    onCancelAdd: vi.fn(),
    onRemoveEntry: vi.fn(),
    onChunkedChange: vi.fn(),
    onMaxChunksChange: vi.fn(),
    onDelayFactorChange: vi.fn(),
    onPresetChange: vi.fn(),
    onSave: vi.fn(),
    ...overrides,
  };
}

/** 展开新增行并输入文案的状态。 */
function addingState(input: string): SettingsCardState {
  return updateAddDraft(
    beginAdd(initialState({ value: { locale: 'zh', allowlist: [PHONE] } })),
    input,
  );
}

/** 已改动的可保存状态。 */
function dirtyState(): SettingsCardState {
  return removeEntry(
    initialState({ value: { locale: 'zh', allowlist: [PHONE, PHONE_2] } }),
    0,
    saved,
  );
}

describe('settings card view · locale field', () => {
  it('explains that the setting does not change AI reply language', () => {
    // 标签「回复语言」曾让用户误以为能控制大模型的语言：hint 必须在场
    const tree = SettingsCardView(makeProps(initialState({ value: { locale: 'zh', allowlist: [PHONE] } })));

    expect(textOf(tree)).toContain(text.localeHint);
  });

  it('renders a select limited to the schema locales', () => {
    const tree = SettingsCardView(makeProps(initialState({ value: { locale: 'zh', allowlist: [PHONE] } })));

    // 语言下拉的选项（预设下拉是另一个 select，另有专项用例）
    const locale = find(tree, 'select')[0];
    expect(locale).toBeDefined();
    const options = collect(locale!.props['children'] as never).filter((n) => n.type === 'option');
    expect(options.map((option) => option.props['value'])).toEqual(['zh', 'en']);
  });

  it('forwards locale edits', () => {
    const onLocaleChange = vi.fn();
    const tree = SettingsCardView(makeProps(initialState({ value: { locale: 'zh', allowlist: [PHONE] } }), { onLocaleChange }));

    const select = find(tree, 'select')[0];
    expect(select).toBeDefined();
    (select!.props['onChange'] as (event: { target: { value: string } }) => void)({ target: { value: 'en' } });

    expect(onLocaleChange).toHaveBeenCalledWith('en');
  });
});

describe('settings card view · allowlist chips', () => {
  it('renders every entry as a chip with a remove button, and no textarea', () => {
    // 方案 A 的核心：平时没有输入框
    const tree = SettingsCardView(makeProps(initialState({ value: { locale: 'zh', allowlist: [PHONE, PHONE_2] } })));

    expect(find(tree, 'textarea')).toHaveLength(0);
    const pills = find(tree, Pill);
    expect(textOf(pills[0])).toContain(PHONE);
    expect(textOf(pills[1])).toContain(PHONE_2);
    // 每个条目一个删除按钮（aria-label 供无障碍/测试定位）
    const removes = find(tree, Button).filter((button) => button.props['aria-label'] === 'Remove');
    expect(removes).toHaveLength(2);
  });

  it('forwards remove clicks per entry index', () => {
    const onRemoveEntry = vi.fn();
    const tree = SettingsCardView(makeProps(initialState({ value: { locale: 'zh', allowlist: [PHONE, PHONE_2] } }), { onRemoveEntry }));

    const removes = find(tree, Button).filter((button) => button.props['aria-label'] === 'Remove');
    (removes[1]!.props['onClick'] as () => void)();

    expect(onRemoveEntry).toHaveBeenCalledWith(1);
  });

  it('marks hand-edited invalid entries with the error color token', () => {
    // 配置文件被手改塞进非法条目时：chip 标红，仍可删除
    const state = { ...initialState({ value: { locale: 'zh', allowlist: ['123'] } }) };
    const tree = SettingsCardView(makeProps(state));
    const pill = find(tree, Pill)[0];
    expect(pill).toBeDefined();

    expect(String((pill!.props['style'] as { color?: string } | undefined)?.color ?? '')).toContain('state-error');
  });

  it('shows the per-field hint', () => {
    const tree = SettingsCardView(makeProps(initialState({ value: { locale: 'zh', allowlist: [PHONE] } })));

    expect(textOf(tree)).toContain(text.allowlistHint);
  });
});

describe('settings card view · add row', () => {
  it('shows only an add button when closed (no allowlist input field)', () => {
    const tree = SettingsCardView(makeProps(initialState({ value: { locale: 'zh', allowlist: [PHONE] } })));

    // 预设字段是常驻文本输入；白名单的添加行输入不存在
    expect(find(tree, Input).filter((input) => input.props['placeholder'] === text.allowlistHint)).toHaveLength(0);
    const add = find(tree, Button).find((button) => textOf(button) === text.addNumber);
    expect(add).toBeDefined();
  });

  it('forwards add button clicks to open the row', () => {
    const onBeginAdd = vi.fn();
    const tree = SettingsCardView(makeProps(initialState({ value: { locale: 'zh', allowlist: [PHONE] } }), { onBeginAdd }));

    const add = find(tree, Button).find((button) => textOf(button) === text.addNumber);
    expect(add).toBeDefined();
    (add!.props['onClick'] as () => void)();

    expect(onBeginAdd).toHaveBeenCalledOnce();
  });

  it('renders input, confirm and cancel while open, and hides the add button', () => {
    const tree = SettingsCardView(makeProps(addingState(PHONE_2)));

    const inputs = find(tree, Input).filter((input) => input.props["placeholder"] === text.allowlistHint);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.props["value"]).toBe(PHONE_2);
    expect(find(tree, Button).find((button) => textOf(button) === text.confirmAdd)).toBeDefined();
    expect(find(tree, Button).find((button) => textOf(button) === text.cancel)).toBeDefined();
    expect(find(tree, Button).find((button) => textOf(button) === text.addNumber)).toBeUndefined();
  });

  it('forwards typing, confirm and cancel', () => {
    const onUpdateAddDraft = vi.fn();
    const onConfirmAdd = vi.fn();
    const onCancelAdd = vi.fn();
    const tree = SettingsCardView(makeProps(addingState(PHONE_2), { onUpdateAddDraft, onConfirmAdd, onCancelAdd }));

    const input = find(tree, Input).find((i) => i.props['placeholder'] === text.allowlistHint);
    expect(input).toBeDefined();
    (input!.props['onChange'] as (event: { target: { value: string } }) => void)({ target: { value: 'x' } });
    expect(onUpdateAddDraft).toHaveBeenCalledWith('x');

    const confirm = find(tree, Button).find((button) => textOf(button) === text.confirmAdd);
    expect(confirm).toBeDefined();
    (confirm!.props['onClick'] as () => void)();
    expect(onConfirmAdd).toHaveBeenCalledOnce();

    const cancel = find(tree, Button).find((button) => textOf(button) === text.cancel);
    expect(cancel).toBeDefined();
    (cancel!.props['onClick'] as () => void)();
    expect(onCancelAdd).toHaveBeenCalledOnce();
  });

  it('confirms on Enter and cancels on Escape inside the input', () => {
    const onConfirmAdd = vi.fn();
    const onCancelAdd = vi.fn();
    const tree = SettingsCardView(makeProps(addingState(PHONE_2), { onConfirmAdd, onCancelAdd }));

    const input = find(tree, Input).find((i) => i.props['placeholder'] === text.allowlistHint);
    expect(input).toBeDefined();
    const keydown = input!.props['onKeyDown'] as (event: { key: string }) => void;
    keydown({ key: 'Enter' });
    expect(onConfirmAdd).toHaveBeenCalledOnce();
    keydown({ key: 'Escape' });
    expect(onCancelAdd).toHaveBeenCalledOnce();
  });

  it('shows the red validation message under the input for an invalid draft', () => {
    const tree = SettingsCardView(makeProps(addingState('not-a-number')));

    expect(textOf(tree)).toContain(text.invalidNumber);
    // 错误文案用错误色令牌（与 empty warn 的警示色区分）
    const errorNode = find(tree, 'p').find((node) => textOf(node) === text.invalidNumber);
    expect(errorNode).toBeDefined();
    expect(String((errorNode!.props['style'] as { color?: string } | undefined)?.color ?? '')).toContain('state-error');
  });

  it('shows the duplicate message for a duplicate draft', () => {
    const tree = SettingsCardView(makeProps(addingState(` ${PHONE} `)));

    expect(textOf(tree)).toContain(text.duplicateNumber);
  });

  it('shows no validation message for a valid draft', () => {
    const tree = SettingsCardView(makeProps(addingState(PHONE_2)));

    expect(textOf(tree)).not.toContain(text.invalidNumber);
    expect(textOf(tree)).not.toContain(text.duplicateNumber);
  });
});

/** 开启分段且已改动的状态。 */
function chunkedState(): SettingsCardState {
  return setChunkedDraft(initialState({ value: { locale: 'zh', allowlist: [PHONE] } }), true, saved);
}

describe('settings card view · chunked replies', () => {
  it('renders the toggle with its hint and no number inputs when off', () => {
    const tree = SettingsCardView(makeProps(initialState({ value: { locale: 'zh', allowlist: [PHONE] } })));

    const checkbox = find(tree, 'input')[0];
    expect(checkbox?.props['type']).toBe('checkbox');
    expect(checkbox?.props['checked']).toBe(false);
    expect(textOf(tree)).toContain(text.chunkedHint);
    // 子配置项不出现（收起）
    expect(textOf(tree)).not.toContain(text.maxChunksLabel);
    expect(textOf(tree)).not.toContain(text.delayFactorLabel);
  });

  it('forwards toggle changes', () => {
    const onChunkedChange = vi.fn();
    const tree = SettingsCardView(makeProps(initialState({ value: { locale: 'zh', allowlist: [PHONE] } }), { onChunkedChange }));

    const checkbox = find(tree, 'input').find((input) => input.props['type'] === 'checkbox');
    (checkbox!.props['onChange'] as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });

    expect(onChunkedChange).toHaveBeenCalledWith(true);
  });

  it('shows both number inputs with values when on', () => {
    const tree = SettingsCardView(makeProps(chunkedState()));

    expect(textOf(tree)).toContain(text.maxChunksLabel);
    expect(textOf(tree)).toContain(text.delayFactorLabel);
    const numbers = find(tree, Input).filter((input) => input.props['type'] === 'number');
    expect(numbers.map((input) => input.props['value'])).toEqual(['8', '1']);
  });

  it('forwards number input edits', () => {
    const onMaxChunksChange = vi.fn();
    const onDelayFactorChange = vi.fn();
    const tree = SettingsCardView(makeProps(chunkedState(), { onMaxChunksChange, onDelayFactorChange }));

    const numbers = find(tree, Input).filter((input) => input.props['type'] === 'number');
    (numbers[0]!.props['onChange'] as (event: { target: { value: string } }) => void)({ target: { value: '5' } });
    expect(onMaxChunksChange).toHaveBeenCalledWith('5');
    (numbers[1]!.props['onChange'] as (event: { target: { value: string } }) => void)({ target: { value: '0' } });
    expect(onDelayFactorChange).toHaveBeenCalledWith('0');
  });

  it('shows red validation under the number inputs and disables saving', () => {
    const state = setMaxChunksDraft(chunkedState(), 'abc', saved);
    const tree = SettingsCardView(makeProps(state));

    expect(textOf(tree)).toContain(text.maxChunksErrorText);
    const saveButton = find(tree, Button).find((button) => textOf(button) === text.save);
    expect(saveButton?.props['disabled']).toBe(true);
  });

  it('shows the delay factor validation message for a bad factor', () => {
    const state = setDelayFactorDraft(chunkedState(), '9', saved);
    const tree = SettingsCardView(makeProps(state));

    expect(textOf(tree)).toContain(text.delayFactorErrorText);
  });

  it('hides validation messages when the toggle is off', () => {
    // 开关关掉 = 子输入不可见 = 校验错误也不该出现
    const state = setChunkedDraft(setMaxChunksDraft(chunkedState(), 'abc', saved), false, saved);
    const tree = SettingsCardView(makeProps(state));

    expect(textOf(tree)).not.toContain(text.maxChunksErrorText);
  });
});

/** 预设已改动的状态。 */
function presetState(draft: string): SettingsCardState {
  return setPresetDraft(initialState({ value: { locale: 'zh', allowlist: [PHONE] } }), draft, saved);
}

describe('settings card view · agent preset', () => {
  /** 带 roster 的 props（模拟 remote 加载完成）。 */
  function rosterProps(draft: string, overrides: Record<string, unknown> = {}) {
    const state = setPresetDraft(initialState({ value: { locale: 'zh', allowlist: [PHONE] } }), draft, saved);
    return makeProps(
      { ...state, presetOptions: presetOptions([
        { id: 'dafeiyu', name: '大肥鱼' },
        { id: 'standard', isDefault: true },
        { id: 'bad', broken: 'activation failed' },
      ], draft) },
      overrides,
    );
  }

  /** 取预设下拉与选项。 */
  function presetSelect(tree: ReturnType<typeof SettingsCardView>) {
    const select = find(tree, 'select').find((node) => String(node.props['data-field'] ?? '') === 'preset');
    const options = collect(select!.props['children'] as never).filter((n) => n.type === 'option');
    return { select: select!, options };
  }

  it('lists installed and enabled presets only (broken rows dropped)', () => {
    // draft 用 roster 内的值，纯看列表内容
    const { options } = presetSelect(SettingsCardView(rosterProps('dafeiyu')));

    // broken 的 bad 不出现；数据精准来自已安装且启用的预设
    expect(options.map((option) => option.props['value'])).toEqual(['dafeiyu', 'standard']);
    expect(textOf(options[0])).toContain('大肥鱼');
  });

  it('selects dafeiyu by default when it is installed and nothing was chosen', () => {
    // 未设置（draft 空）+ dafeiyu 已安装 → 默认选中（不必落盘）
    const { select } = presetSelect(SettingsCardView(rosterProps('')));

    expect(select.props['value']).toBe('dafeiyu');
  });

  it('never steals an explicit choice back to dafeiyu', () => {
    // 用户先选了别的：即使 dafeiyu 在列表里也不抢
    const { select } = presetSelect(SettingsCardView(rosterProps('standard')));

    expect(select.props['value']).toBe('standard');
  });

  it('falls back to the host default row when dafeiyu is not installed', () => {
    const state = { ...initialState({ value: { locale: 'zh', allowlist: [PHONE] } }),
      presetOptions: presetOptions([{ id: 'standard', isDefault: true }], '') };
    const { select } = presetSelect(SettingsCardView(makeProps(state)));

    expect(select.props['value']).toBe('standard');
  });

  it('keeps the current value as a fallback option when the roster lacks it', () => {
    // 已保存的预设被卸载：当前值仍可见可选（保存/切换不丢显示）
    const { select, options } = presetSelect(SettingsCardView(rosterProps('ghosted-preset')));

    expect(options.map((option) => option.props['value'])).toEqual(
      ['ghosted-preset', 'dafeiyu', 'standard'],
    );
    expect(select.props['value']).toBe('ghosted-preset');
  });

  it('forwards preset selection', () => {
    const onPresetChange = vi.fn();
    const { select } = presetSelect(SettingsCardView(rosterProps('standard', { onPresetChange })));

    (select.props['onChange'] as (event: { target: { value: string } }) => void)({ target: { value: 'plain' } });

    expect(onPresetChange).toHaveBeenCalledWith('plain');
  });

  it('shows the red validation message for a malformed id and disables saving', () => {
    const tree = SettingsCardView(makeProps(presetState('Not Valid')));

    expect(textOf(tree)).toContain(text.presetErrorText);
    const saveButton = find(tree, Button).find((button) => textOf(button) === text.save);
    expect(saveButton?.props['disabled']).toBe(true);
  });
});

describe('settings card view · feedback', () => {
  it('warns that an empty allowlist rejects everyone', () => {
    const tree = SettingsCardView(makeProps(initialState({ value: {} })));

    expect(textOf(tree)).toContain(text.emptyWarn);
  });

  it('shows the save error without losing the draft', () => {
    const state = { ...dirtyState(), error: 'boom' };
    const tree = SettingsCardView(makeProps(state));

    expect(textOf(tree)).toContain('boom');
  });

  it('shows only the loading text before the host snapshot arrives', () => {
    const tree = SettingsCardView(makeProps({ ...initialState({}), ready: false }));

    expect(textOf(tree)).toContain(text.loading);
    expect(find(tree, 'select')).toHaveLength(0);
  });
});

describe('settings card view · save action', () => {
  it('disables the button when nothing changed', () => {
    const tree = SettingsCardView(makeProps(initialState({ value: { locale: 'zh', allowlist: [PHONE] } })));

    const saveButton = find(tree, Button).find((button) => textOf(button) === text.save);
    expect(saveButton?.props['disabled']).toBe(true);
  });

  it('enables the button after a change and forwards the click', () => {
    const onSave = vi.fn();
    const tree = SettingsCardView(makeProps(dirtyState(), { onSave }));

    const saveButton = find(tree, Button).find((button) => textOf(button) === text.save);
    expect(saveButton?.props['disabled']).toBe(false);
    (saveButton?.props['onClick'] as () => void)();

    expect(onSave).toHaveBeenCalledOnce();
  });

  it('disables the button while an invalid add draft is pending', () => {
    // 状态机拦了 canSave，视图只需忠实反映
    const tree = SettingsCardView(makeProps(addingState('not-a-number')));

    const saveButton = find(tree, Button).find((button) => textOf(button) === text.save);
    expect(saveButton?.props['disabled']).toBe(true);
  });

  it('labels the in-flight state and blocks a second click', () => {
    const state = { ...setLocaleDraft(initialState({ value: { locale: 'zh', allowlist: [PHONE] } }), 'en', saved), saving: true };
    const tree = SettingsCardView(makeProps(state));

    const saveButton = find(tree, Button).find((button) => textOf(button) === text.saving);
    expect(saveButton?.props['disabled']).toBe(true);
  });
});
