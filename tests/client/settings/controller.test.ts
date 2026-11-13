// 设置卡片 controller 规格（Step 4，测试先行）。
//
// controller 是「宿主表单 ↔ 视图」之间的粘合层：订阅快照、维护草稿、
// 触发写入。纯 TS 无 React，因此可以在 node 里完整单测；React 组件只剩
// useSyncExternalStore + 渲染。

import { describe, expect, it, vi } from 'vitest';

import { createCardController } from '@/client/settings/controller';
import { ENTRY_ID } from '@/client/settings/ids';

const PHONE = '+8613800000000';
const TEXT = { saveFailed: 'save failed' };

/** 可推快照的 fake 宿主表单。 */
function makeForm(initial: { locale?: string; allowlist?: string[] } = {}) {
  let value: Record<string, unknown> = {
    locale: initial.locale ?? 'zh',
    allowlist: initial.allowlist ?? [],
  };
  let revision = 1;
  const listeners = new Set<() => void>();
  const writes: Array<readonly { op: string; path: readonly string[]; value?: unknown }[]> = [];
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
        for (const listener of listeners) listener();
        return true;
      },
    },
    /** 宿主侧推送新值（别处改了配置 / 我们自己的写入回流）。 */
    push(next: { locale?: string; allowlist?: string[] }) {
      value = {
        locale: next.locale ?? value['locale'],
        allowlist: next.allowlist ?? value['allowlist'],
      };
      revision += 1;
      for (const listener of listeners) listener();
    },
  };
}

function makeController(options: { locale?: string; allowlist?: string[] } = {}) {
  const fake = makeForm(options);
  const controller = createCardController({ namespace: ENTRY_ID, form: fake.form, texts: TEXT });
  return { controller, fake };
}

describe('card controller · snapshot binding', () => {
  it('starts from the host snapshot and marks itself clean', () => {
    const { controller } = makeController({ allowlist: [PHONE] });

    const state = controller.getSnapshot();

    expect(state.ready).toBe(true);
    expect(state.allowlist.draft).toEqual([PHONE]);
    expect(state.canSave).toBe(false);
  });

  it('notifies subscribers when the host snapshot changes', () => {
    const { controller, fake } = makeController({ allowlist: [PHONE] });
    const listener = vi.fn();
    controller.subscribe(listener);

    fake.push({ allowlist: ['+8613900000000'] });

    expect(listener).toHaveBeenCalled();
    expect(controller.getSnapshot().allowlist.draft).toEqual(['+8613900000000']);
  });

  it('keeps a dirty draft when the host pushes an unrelated change', () => {
    // 用户正在改白名单，宿主推来语言变化：草稿不能被冲掉
    const { controller, fake } = makeController({ allowlist: [PHONE] });
    controller.removeEntry(0);

    fake.push({ locale: 'en' });

    expect(controller.getSnapshot().allowlist.draft).toEqual([]);
    expect(controller.getSnapshot().locale.draft).toBe('en');
  });

  it('tolerates a second dispose', () => {
    const { controller } = makeController();

    controller.dispose();

    // 双卸载（例如宿主重启路径）不该抛
    expect(() => controller.dispose()).not.toThrow();
  });

  it('unsubscribes from the host form on dispose', () => {
    const { controller, fake } = makeController({ allowlist: [PHONE] });
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.dispose();
    fake.push({ allowlist: [] });

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('card controller · editing', () => {
  it('marks the card savable after removing an entry', () => {
    const { controller } = makeController({ allowlist: [PHONE, '+8613900000000'] });

    controller.removeEntry(0);

    const state = controller.getSnapshot();
    expect(state.allowlist.dirty).toBe(true);
    expect(state.canSave).toBe(true);
  });

  it('runs the full add flow: open, type, confirm', () => {
    const { controller } = makeController({ allowlist: [PHONE] });

    controller.beginAdd();
    controller.updateAddDraft('+8613900000000');

    // 打字过程中状态要更新（视图实时显示校验结果）
    expect(controller.getSnapshot().adding.input).toBe('+8613900000000');
    expect(controller.getSnapshot().adding.error).toBeNull();

    controller.confirmAdd();

    const state = controller.getSnapshot();
    expect(state.allowlist.draft).toEqual([PHONE, '+8613900000000']);
    expect(state.adding.active).toBe(false);
    expect(state.canSave).toBe(true);
  });

  it('keeps an invalid add draft open with its error', () => {
    const { controller } = makeController({ allowlist: [PHONE] });

    controller.beginAdd();
    controller.updateAddDraft('not-a-number');
    controller.confirmAdd();

    const state = controller.getSnapshot();
    expect(state.allowlist.draft).toEqual([PHONE]);
    expect(state.adding.active).toBe(true);
    expect(state.adding.error).toBe('invalid');
    expect(state.canSave).toBe(false);
  });

  it('cancels the add row and clears it', () => {
    const { controller } = makeController({ allowlist: [PHONE] });

    controller.beginAdd();
    controller.updateAddDraft('not-a-number');
    controller.cancelAdd();

    expect(controller.getSnapshot().adding).toEqual({ active: false, input: '', error: null });
  });

  it('notifies subscribers while typing in the add row', () => {
    const { controller } = makeController({ allowlist: [PHONE] });
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.beginAdd();
    controller.updateAddDraft('+8613900000000');

    // 打开 + 输入 = 至少两次通知
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('reset discards unsaved drafts and re-reads the host snapshot', () => {
    // 关闭设置页 = 丢弃草稿：重开必须看到宿主已保存值，不是旧草稿
    const { controller } = makeController({ allowlist: [PHONE] });

    controller.removeEntry(0);
    controller.beginAdd();
    controller.updateAddDraft('not-a-number');
    expect(controller.getSnapshot().allowlist.dirty).toBe(true);

    controller.reset();

    const state = controller.getSnapshot();
    expect(state.allowlist.draft).toEqual([PHONE]);
    expect(state.allowlist.dirty).toBe(false);
    expect(state.adding).toEqual({ active: false, input: '', error: null });
    expect(state.canSave).toBe(false);
  });



  it('clears the draft when a save succeeds', async () => {
    const { controller } = makeController({ allowlist: [PHONE] });
    controller.removeEntry(0);

    await controller.save();

    const state = controller.getSnapshot();
    expect(state.allowlist.draft).toEqual([]);
    expect(state.allowlist.dirty).toBe(false);
    expect(state.saving).toBe(false);
  });
});

describe('card controller · saving', () => {
  it('writes our own namespace with both fields atomically', async () => {
    const { controller, fake } = makeController({ allowlist: [PHONE] });
    controller.beginAdd();
    controller.updateAddDraft('+8613900000000');
    controller.confirmAdd();

    await controller.save();

    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]).toEqual([
      { op: 'set', path: ['locale'], value: 'zh' },
      { op: 'set', path: ['allowlist'], value: [PHONE, '+8613900000000'] },
    ]);
  });

  it('ignores a save when nothing changed', async () => {
    const { controller, fake } = makeController({ allowlist: [PHONE] });

    await controller.save();

    expect(fake.writes).toHaveLength(0);
  });

  it('exposes the profile entry id it writes to', () => {
    // 配置命名空间 = profile entry id，不是菜单 id
    const { controller } = makeController();

    expect(controller.namespace).toBe(ENTRY_ID);
  });
});
