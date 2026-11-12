// 客户端插件入口行为（Step 0 探针）。
//
// apply 只做一件事：把自己的菜单注册进设置弹窗左侧的 settings.section
// 槽位。这里用最小 fake ClientContext 钉住注册参数与生命周期——不渲染
// 组件（渲染靠真机联调验证）。
//
// 实测事实（2026-11-12 真机探针）：`slots.register` 在槽位声明之前调用会
// 抛 `slot "..." is not declared`——我们的 entry 可能早于声明方
// （ui-settings-general）激活，所以必须走 `slots.inject(key, cb)` 等声明
// 就绪再注册。这条约束是本文件的核心断言。

import { describe, expect, it } from 'vitest';

import { SECTION_ID, SECTION_ORDER, apply, inject } from '@/client/index';

interface SectionOptions {
  readonly name: string;
  readonly id?: string;
  readonly order?: number;
  readonly label?: () => string;
}

function makeClientCtx() {
  const registrations: Array<{ options: SectionOptions; component: unknown }> = [];
  const waits: Array<{ key: string; run: () => unknown }> = [];
  const disposers: Array<() => unknown> = [];
  const ctx = {
    slots: {
      register(options: SectionOptions, component: unknown) {
        registrations.push({ options, component });
        return () => {
          const index = registrations.findIndex((row) => row.options === options);
          if (index >= 0) registrations.splice(index, 1);
        };
      },
      /** 声明就绪前不跑 callback：模拟槽位尚未被父插件声明。 */
      inject(key: string, callback: () => unknown) {
        let active: (() => unknown) | undefined;
        const entry = {
          key,
          run: () => {
            active = callback() as () => unknown;
            return active;
          },
        };
        waits.push(entry);
        return () => {
          const index = waits.findIndex((row) => row === entry);
          if (index >= 0) waits.splice(index, 1);
          // 真 slots.inject 语义：取消等待时连带 dispose 已激活的注册
          active?.();
          active = undefined;
        };
      },
    },
    effect(fn: () => () => unknown) {
      disposers.push(fn());
    },
  };
  return { ctx, registrations, waits, disposers };
}

describe('client entry · settings section', () => {
  it('declares the slots service as an injected dependency', () => {
    expect(inject).toContain('slots');
  });

  it('waits for the section declaration instead of registering eagerly', () => {
    const { ctx, registrations, waits } = makeClientCtx();

    apply(ctx as never);

    // 关键：不能直接 register（声明未就绪会抛错），必须先 inject 等声明
    expect(registrations).toHaveLength(0);
    expect(waits).toHaveLength(1);
    expect(waits[0]?.key).toBe('settings.section');
  });

  it('registers the section once the declaration arrives', () => {
    const { ctx, registrations, waits } = makeClientCtx();
    apply(ctx as never);

    waits[0]?.run();

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.options).toMatchObject({
      name: 'settings.section',
      id: SECTION_ID,
      order: SECTION_ORDER,
    });
  });

  it('labels the section iMessage (product name is not translated)', () => {
    const { ctx, registrations, waits } = makeClientCtx();
    apply(ctx as never);

    waits[0]?.run();

    expect(registrations[0]?.options.label?.()).toBe('iMessage');
  });

  it('registers a renderable component', () => {
    const { ctx, registrations, waits } = makeClientCtx();
    apply(ctx as never);

    waits[0]?.run();

    expect(typeof registrations[0]?.component).toBe('function');
  });

  it('cancels the pending wait when the fiber disposes', () => {
    const { ctx, waits, disposers } = makeClientCtx();
    apply(ctx as never);
    expect(waits).toHaveLength(1);

    for (const dispose of disposers) void dispose();

    expect(waits).toHaveLength(0);
  });

  it('removes the registration when the fiber disposes after activation', () => {
    const { ctx, registrations, waits, disposers } = makeClientCtx();
    apply(ctx as never);
    waits[0]?.run();
    expect(registrations).toHaveLength(1);

    for (const dispose of disposers) void dispose();

    expect(registrations).toHaveLength(0);
  });
});
