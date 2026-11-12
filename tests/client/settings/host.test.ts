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
  return { ...env, container, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('settings card · mounted', () => {
  it('renders the saved allowlist from the host form', () => {
    const app = mount({ allowlist: [PHONE] });

    expect(app.container.querySelector('textarea')?.value).toBe(PHONE);
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

  it('writes both fields when the user saves', async () => {
    const app = mount({ allowlist: [PHONE] });
    const textarea = app.container.querySelector('textarea') as HTMLTextAreaElement;

    await act(async () => {
      // React 受控组件：必须走原生 setter + input 事件
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, `${PHONE}\n+8613900000000`);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = app.container.querySelector('button') as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    await act(async () => {
      save.click();
    });

    expect(app.form.writes).toEqual([[
      { op: 'set', path: ['locale'], value: 'zh' },
      { op: 'set', path: ['allowlist'], value: [PHONE, '+8613900000000'] },
    ]]);
    app.unmount();
  });

  it('re-renders when the host pushes a new snapshot', async () => {
    const app = mount({ allowlist: [PHONE] });

    await act(async () => {
      app.form.push({ allowlist: ['+8613900000000'] });
    });

    expect(app.container.querySelector('textarea')?.value).toBe('+8613900000000');
    app.unmount();
  });

  it('switches our own copy when the interface language changes', async () => {
    const app = mount({ locale: 'zh', allowlist: [PHONE] });
    expect(app.container.textContent).toContain('回复语言');

    await act(async () => {
      app.setLocale('en');
    });

    expect(app.container.textContent).toContain('Reply language');
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
      (app.container.querySelector('button') as HTMLButtonElement).click();
    });

    // 回复语言由我们自己的 config 字段决定，与界面语言无关
    expect(app.form.writes).toEqual([[
      { op: 'set', path: ['locale'], value: 'en' },
      { op: 'set', path: ['allowlist'], value: [PHONE] },
    ]]);
    app.unmount();
  });

  it('blocks saving while an entry cannot be parsed', async () => {
    const app = mount({ allowlist: [PHONE] });
    const textarea = app.container.querySelector('textarea') as HTMLTextAreaElement;

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, 'nope');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect((app.container.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    app.unmount();
  });
});
