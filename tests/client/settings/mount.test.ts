// 挂载接线规格（Step 4）：槽位注册 + 表单绑定 + 词条注册。
//
// 入口（index.ts）只是薄壳，真正的时序细节在这里验证：
// 1. 槽位：settings.section 等声明就绪再注册（真机踩过的坑）
// 2. 表单：configForms.get(entryId) 绑我们自己的命名空间
// 3. 文案：按宿主 locale 提供我们自己的 zh/en 词条
//
// 组件的渲染契约在 settings-card-view.test.ts；状态流转在
// settings-card-controller.test.ts。这里只验证接线，不调用 hook 组件
// （hook 只能在真渲染器里跑，node 里直接调用会抛 invalid hook call）。

import { describe, expect, it } from 'vitest';

import { ENTRY_ID, SECTION_ID, SECTION_ORDER } from '@/client/settings/ids';
import { mountSettingsSection } from '@/client/settings/mount';

/** 最小 fake ClientContext：记录槽位注册、locale 字典与表单绑定。 */
function makeCtx(options: { locale?: string } = {}) {
  const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = [];
  const waits: Array<{ key: string; run: () => void }> = [];
  const dictionaries: Array<{ ns: string; dict: unknown }> = [];
  const forms: string[] = [];
  const disposers: Array<() => unknown> = [];
  const form = {
    getSnapshot: () => ({ value: { locale: 'zh', allowlist: [] }, revision: 1, writable: true }),
    subscribe: () => () => undefined,
    mutate: async () => true,
  };
  const ctx = {
    slots: {
      register(registrationOptions: Record<string, unknown>, component: unknown) {
        registrations.push({ options: registrationOptions, component });
        return () => undefined;
      },
      inject(key: string, callback: () => () => void) {
        const entry = { key, run: () => void callback() };
        waits.push(entry);
        return () => {
          const index = waits.findIndex((row) => row === entry);
          if (index >= 0) waits.splice(index, 1);
        };
      },
    },
    locale: {
      register(ns: string, dict: unknown) {
        dictionaries.push({ ns, dict });
        return () => undefined;
      },
      getSnapshot: () => ({ active: options.locale ?? 'zh', revision: 1 }),
      subscribe: () => () => undefined,
    },
    configForms: {
      get(ns: string) {
        forms.push(ns);
        return form;
      },
    },
    effect(fn: () => () => unknown) {
      disposers.push(fn());
    },
  };
  return { ctx, registrations, waits, dictionaries, forms, disposers };
}

describe('settings mount · wiring', () => {
  it('binds the host form for the profile entry id, not the menu id', () => {
    // 真机事实：配置命名空间 = profile patch 的 entry id（chenyaqi-dsh-imessage），
    // 菜单 id 只是 UI 身份；用错就永远读到空快照
    const { ctx, forms } = makeCtx();

    mountSettingsSection(ctx as never);

    expect(forms).toEqual([ENTRY_ID]);
    expect(ENTRY_ID).not.toBe(SECTION_ID);
  });

  it('registers dictionaries with the same keys in every locale', () => {
    const { ctx, dictionaries } = makeCtx();

    mountSettingsSection(ctx as never);

    const dict = dictionaries.find((row) => row.ns === 'settings.imessage')?.dict as
      | Record<string, Record<string, string>>
      | undefined;
    expect(dict).toBeDefined();
    // 缺一个 key 就会回退到另一语言，界面语言会串
    expect(Object.keys(dict?.['zh'] ?? {}).sort()).toEqual(Object.keys(dict?.['en'] ?? {}).sort());
  });

  it('waits for the section declaration before registering', () => {
    const { ctx, registrations, waits } = makeCtx();

    mountSettingsSection(ctx as never);

    expect(registrations).toHaveLength(0);
    expect(waits.map((row) => row.key)).toEqual(['settings.section']);
  });

  it('registers the section with our id and order once declared', () => {
    const { ctx, registrations, waits } = makeCtx();
    mountSettingsSection(ctx as never);

    waits[0]?.run();

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.options).toMatchObject({
      name: 'settings.section',
      id: SECTION_ID,
      order: SECTION_ORDER,
    });
    expect(typeof registrations[0]?.component).toBe('function');
  });

  it('labels the section iMessage (product name is not translated)', () => {
    const { ctx, registrations, waits } = makeCtx();
    mountSettingsSection(ctx as never);

    waits[0]?.run();

    expect((registrations[0]?.options['label'] as () => string)()).toBe('iMessage');
  });

  it('drops the pending wait when the fiber disposes', () => {
    const { ctx, waits, disposers } = makeCtx();
    mountSettingsSection(ctx as never);
    expect(waits).toHaveLength(1);

    for (const dispose of disposers) void dispose();

    expect(waits).toHaveLength(0);
  });
});
