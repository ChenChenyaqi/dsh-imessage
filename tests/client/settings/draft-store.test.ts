// 草稿 override store 规格（方案 D 的核心，测试先行）。
//
// 语义：
// - 快照不可变，未 set 时 getSnapshot 返回同一引用（useSyncExternalStore 契约）
// - set 单字段，通知订阅者；同值短路不通知
// - undefined = 该字段未编辑（跟随 saved 基准），可显式赋回 undefined

import { describe, expect, it, vi } from 'vitest';

import { createDraftStore } from '@/client/settings/draft-store';

describe('draft store · snapshot immutability', () => {
  it('starts with an empty overrides snapshot (no field edited)', () => {
    const store = createDraftStore();

    expect(store.getSnapshot()).toEqual({});
  });

  it('keeps the same snapshot reference until a set changes it', () => {
    const store = createDraftStore();

    const before = store.getSnapshot();
    store.set('locale', 'zh');
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    // 旧快照不被原地修改（不可变）
    expect(before).toEqual({});
    expect(after.locale).toBe('zh');
  });

  it('isolates fields: setting one leaves the other untouched', () => {
    const store = createDraftStore();

    store.set('locale', 'zh');
    store.set('maxChunks', '12');

    expect(store.getSnapshot()).toEqual({ locale: 'zh', maxChunks: '12' });
  });

  it('accepts an explicit undefined to return a field to "not edited"', () => {
    const store = createDraftStore();

    store.set('locale', 'en');
    store.set('locale', undefined);

    expect('locale' in store.getSnapshot()).toBe(true);
    expect(store.getSnapshot().locale).toBeUndefined();
  });
});

describe('draft store · subscriptions', () => {
  it('notifies subscribers on set', () => {
    const store = createDraftStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.set('locale', 'zh');

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops notifying after unsubscribe', () => {
    const store = createDraftStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    unsubscribe();
    store.set('locale', 'zh');

    expect(listener).not.toHaveBeenCalled();
  });

  it('skips notification when the value is unchanged (same reference)', () => {
    const store = createDraftStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.set('locale', 'zh');
    store.set('locale', 'zh');

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
