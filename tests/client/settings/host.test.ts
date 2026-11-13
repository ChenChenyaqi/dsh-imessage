// @vitest-environment jsdom
//
// 卡片挂载测试（Step 5）：真渲染 hook 组件，验证接线而不只是纯函数。
//
// 覆盖点（前面的测试都到不了）：
// - useSyncExternalStore 订阅 controller（宿主推快照 → 界面跟着变）
// - 语言切换触发重渲染（我们自己的词条跟着换）
// - 输入 → 保存 → 写到宿主表单（真 DOM 事件路径）

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { ENTRY_ID, SECTION_ID } from '@/client/settings/ids';
import { mountSettingsSection } from '@/client/settings/mount';

const PHONE = '+8613800000000';

/** 可推快照的 fake 宿主表单。 */
function makeForm(initial: { locale?: string; allowlist?: string[] } = {}) {
  let value: Record<string, unknown> = {
    locale: initial.locale ?? 'zh',
    allowlist: initial.allowlist ?? [],
  };
  let revision = 1;
  const listeners = new Set<() => void>();
  const writes: Array<readonly { op: string; path: readonly string[]; value?: unknown }[]> = [];
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  return {
    writes,
    form: {
      getSnapshot: () => ({ value, revision, writable: true }),
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async mutate(ops: readonly { op: string; path: readonly string[]; value?: unknown }[]) {
        writes.push(ops);
        for (const op of ops) {
          if (op.op === 'set' && op.path.length === 1) {
            value = { ...value, [op.path[0] as string]: op.value };
          }
        }
        revision += 1;
        notify();
        return true;
      },
    },
    push(next: { locale?: string; allowlist?: string[] }) {
      value = {
        locale: next.locale ?? value['locale'],
        allowlist: next.allowlist ?? value['allowlist'],
      };
      revision += 1;
      notify();
    },
    notify,
  };
}

/** 最小 fake ctx：槽位立即就绪、locale 可切换。 */
function makeCtx(options: { locale?: string; allowlist?: string[] } = {}) {
  const fake = makeForm(options);
  let localeId = options.locale ?? 'zh';
  const localeListeners = new Set<() => void>();
  const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = [];
  const ctx = {
    slots: {
      register(registrationOptions: Record<string, unknown>, component: unknown) {
        registrations.push({ options: registrationOptions, component });
        return () => undefined;
      },
      inject(_key: string, callback: () => () => void) {
        callback();
        return () => undefined;
      },
    },
    locale: {
      register: () => () => undefined,
      getSnapshot: () => ({ active: localeId, revision: 1 }),
      subscribe(listener: () => void) {
        localeListeners.add(listener);
        return () => {
          localeListeners.delete(listener);
        };
      },
    },
    configForms: { get: () => fake.form },
    effect: (fn: () => () => unknown) => {
      fn();
    },
  };
  return {
    ctx,
    form: fake,
    registrations,
    setLocale(next: string) {
      localeId = next;
      for (const listener of localeListeners) listener();
    },
  };
}

/** 挂载卡片并返回容器与卸载函数。 */
function mount(options: { locale?: string; allowlist?: string[] } = {}) {
  const env = makeCtx(options);
  act(() => {
    mountSettingsSection(env.ctx as never);
  });
  const component = env.registrations[0]?.component as (props: Record<string, never>) => JSX.Element;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(component({}));
  });
  return {
    ...env,
    container,
    unmount: () => act(() => root.unmount()),
    /** 只卸载视图（controller 存活）：模拟用户关掉设置页。 */
    unmountView: () => act(() => root.unmount()),
    /** 重新挂载视图：模拟用户重新打开设置页，返回新容器。 */
    remountView: () => {
      const next = document.createElement('div');
      document.body.append(next);
      const nextRoot = createRoot(next);
      act(() => {
        nextRoot.render(component({}));
      });
      return next;
    },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

/** 按可见文字找按钮（chip 的删除按钮是纯 ×，不能按位置猜）。 */
function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button'))
    .find((item) => item.textContent?.trim() === label);
  if (!button) throw new Error(`button not found: ${label}`);
  return button as HTMLButtonElement;
}

/** 走「添加号码」流输入一个号码（打开 → 输入 → 确认）。 */
async function addNumber(app: ReturnType<typeof mount>, input: string): Promise<void> {
  await act(async () => {
    findButton(app.container, '添加号码').click();
  });
  await act(async () => {
    const field = app.container.querySelector('input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(field, input);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    findButton(app.container, '添加').click();
  });
}

describe('settings card · mounted', () => {
  it('renders the saved allowlist as chips (no textarea)', () => {
    const app = mount({ allowlist: [PHONE] });

    expect(app.container.textContent).toContain(PHONE);
    expect(app.container.querySelector('textarea')).toBeNull();
    expect(Array.from(app.container.querySelectorAll('option'), (option) => option.value))
      .toEqual(['zh', 'en']);
    app.unmount();
  });

  it('registers the menu under the profile entry namespace', () => {
    const app = mount();

    // 菜单 id 与配置命名空间是两件事（真机踩过的坑）
    expect(app.registrations[0]?.options['id']).toBe(SECTION_ID);
    expect(ENTRY_ID).not.toBe(SECTION_ID);
    app.unmount();
  });

  it('writes both fields when the user adds a number and saves', async () => {
    const app = mount({ allowlist: [PHONE] });

    await addNumber(app, '+8613900000000');

    const save = findButton(app.container, '保存');
    expect(save.disabled).toBe(false);

    await act(async () => {
      save.click();
    });

    expect(app.form.writes).toEqual([[
      { op: 'set', path: ['locale'], value: 'zh' },
      { op: 'set', path: ['allowlist'], value: [PHONE, '+8613900000000'] },
      { op: 'set', path: ['chunkedReplies'], value: false },
      { op: 'set', path: ['maxChunks'], value: 8 },
      { op: 'set', path: ['delayFactor'], value: 1 },
    ]]);
    app.unmount();
  });

  it('re-renders when the host pushes a new snapshot', async () => {
    const app = mount({ allowlist: [PHONE] });

    await act(async () => {
      app.form.push({ allowlist: ['+8613900000000'] });
    });

    expect(app.container.textContent).toContain('+8613900000000');
    app.unmount();
  });

  it('switches our own copy when the interface language changes', async () => {
    const app = mount({ locale: 'zh', allowlist: [PHONE] });
    expect(app.container.textContent).toContain('系统提示语言');

    await act(async () => {
      app.setLocale('en');
    });

    expect(app.container.textContent).toContain('System message language');
    app.unmount();
  });

  it('writes the picked locale when the user changes the language field', async () => {
    const app = mount({ locale: 'zh', allowlist: [PHONE] });
    const select = app.container.querySelector('select') as HTMLSelectElement;

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(select, 'en');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      findButton(app.container, '保存').click();
    });

    // 回复语言由我们自己的 config 字段决定，与界面语言无关
    expect(app.form.writes).toEqual([[
      { op: 'set', path: ['locale'], value: 'en' },
      { op: 'set', path: ['allowlist'], value: [PHONE] },
      { op: 'set', path: ['chunkedReplies'], value: false },
      { op: 'set', path: ['maxChunks'], value: 8 },
      { op: 'set', path: ['delayFactor'], value: 1 },
    ]]);
    app.unmount();
  });

  it('discards unsaved edits when the dialog unmounts and is reopened', async () => {
    // 真机 bug 复现：删了 chip 没保存就关设置页，重开竟看不到该号码
    // （重启 DSH 又在）——根因是 controller 比视图活得久，草稿被带回来。
    // 定案：视图卸载时 reset 回宿主已保存值。
    const app = mount({ allowlist: [PHONE, '+8613900000000'] });

    await act(async () => {
      // 删除第一个 chip（aria-label=删除 的第一个按钮）
      const remove = Array.from(app.container.querySelectorAll('button'))
        .find((item) => item.getAttribute('aria-label') === '删除');
      remove?.click();
    });
    // 删除后只剩一个 chip（提示文案含示例号码，不能按文本断言）
    expect(Array.from(app.container.querySelectorAll('button[aria-label="删除"]'))).toHaveLength(1);

    // 关闭再重开（同一 controller，只有视图重新挂载）
    app.unmountView();
    const reopened = app.remountView();

    // 未保存的删除被丢弃：两个 chip 都在
    expect(Array.from(reopened.querySelectorAll('button[aria-label="删除"]'))).toHaveLength(2);
    app.unmount();
  });

  it('writes the chunked replies style when toggled on and saved', async () => {
    const app = mount({ allowlist: [PHONE] });

    await act(async () => {
      const box = app.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')?.set;
      setter?.call(box, true);
      box.dispatchEvent(new Event('click', { bubbles: true }));
    });
    await act(async () => {
      findButton(app.container, '保存').click();
    });

    // 一次提交带全部三个风格字段（数字以数字写入）
    const write = app.form.writes.at(-1) as Array<{ op: string; path: string[]; value: unknown }>;
    expect(write).toContainEqual({ op: 'set', path: ['chunkedReplies'], value: true });
    expect(write).toContainEqual({ op: 'set', path: ['maxChunks'], value: 8 });
    expect(write).toContainEqual({ op: 'set', path: ['delayFactor'], value: 1 });
    app.unmount();
  });

  it('blocks adding and saving while the draft cannot be parsed', async () => {
    const app = mount({ allowlist: [PHONE] });

    await act(async () => {
      findButton(app.container, '添加号码').click();
    });
    await act(async () => {
      const field = app.container.querySelector('input') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(field, 'nope');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // 红色校验文案出现在输入框下面，保存按钮同时被禁用
    expect(app.container.textContent).toContain('无法识别的号码');
    expect(findButton(app.container, '保存').disabled).toBe(true);
    // 确认添加也不入列
    await act(async () => {
      findButton(app.container, '添加').click();
    });
    expect(app.container.textContent).not.toContain('nope');
    app.unmount();
  });
});
