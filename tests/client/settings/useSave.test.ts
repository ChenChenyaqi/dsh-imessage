// useSave 规格（方案 D：context 自取；canSave 是 store 派生，保存走全量覆盖）。
//
// 锁定语义（从 card.test 时代迁移）：
// - 六 op 完整形状与顺序（一次原子 mutate）
// - 生效预设为空时省略 agentPreset op
// - 未编辑字段保存时也写回基准值（全量覆盖）

// @vitest-environment jsdom
import { createElement } from 'react';

import { describe, expect, it, vi } from 'vitest';

import { settingsMessages } from '@/client/i18n/text';
import { CardProvider, type CardContextValue } from '@/client/settings/card-context';
import { createDraftStore, type DraftStore } from '@/client/settings/draft-store';
import type { SavedBaseline } from '@/client/settings/useCardForm';
import { useSave } from '@/client/settings/useSave';
import { act, renderHook } from '../../helpers/render-hook';

const MESSAGES = settingsMessages.zh;
const PHONE = '+8613800000000';

type Mutate = (ops: never) => Promise<boolean>;

function mount(
  options: {
    saved?: Partial<SavedBaseline>;
    mutate?: Mutate;
    seed?: (store: DraftStore) => void;
  } = {},
) {
  const store = createDraftStore();
  options.seed?.(store);
  const value: CardContextValue = {
    store,
    saved: { locale: 'zh', allowlist: [], ...options.saved },
    mutate: options.mutate ?? (async () => true),
    messages: MESSAGES,
  };
  return {
    store,
    rendered: renderHook(() => useSave(), {
      wrapper: ({ children }) => createElement(CardProvider, { value }, children),
    }),
  };
}

describe('useSave · canSave derivation', () => {
  it('refuses to save when nothing changed', () => {
    const { rendered } = mount({});
    expect(rendered.result.current.canSave).toBe(false);
  });

  it('allows saving once any field is edited', () => {
    const { rendered } = mount({ seed: (store) => store.set('locale', 'en') });
    expect(rendered.result.current.canSave).toBe(true);
  });

  it('blocks saving while an entry is invalid or the add row has an error', () => {
    // 手改配置文件出现的非法条目
    const bad = mount({
      saved: { allowlist: ['not-a-phone'] },
      seed: (store) => store.set('allowlist', ['not-a-phone']),
    });
    expect(bad.rendered.result.current.canSave).toBe(false);

    const pending = mount({
      seed: (store) => store.set('adding', { active: true, input: 'x', error: 'invalid' }),
    });
    expect(pending.rendered.result.current.canSave).toBe(false);
  });

  it('blocks saving while a visible chunked input is invalid', () => {
    const max = mount({
      seed: (store) => {
        store.set('chunked', true);
        store.set('maxChunks', 'garbage');
      },
    });
    expect(max.rendered.result.current.canSave).toBe(false);

    const delay = mount({
      seed: (store) => {
        store.set('chunked', true);
        store.set('delayFactor', '99');
      },
    });
    expect(delay.rendered.result.current.canSave).toBe(false);
  });

  it('blocks saving on a malformed preset id', () => {
    const { rendered } = mount({
      seed: (store) => store.set('agentPreset', 'Not Valid'),
    });
    expect(rendered.result.current.canSave).toBe(false);
  });
});

describe('useSave · atomic full-overwrite save', () => {
  it('writes all seven ops in one mutation when every field is dirty', async () => {
    const mutate = vi.fn((_ops: unknown) => Promise.resolve(true) as Promise<boolean>);
    const { rendered } = mount({
      saved: { locale: 'zh', allowlist: [], agentPreset: '' },
      mutate: mutate as unknown as Mutate,
      seed: (store) => {
        store.set('locale', 'en');
        store.set('allowlist', [PHONE]);
        store.set('chunked', true);
        store.set('maxChunks', '12');
        store.set('delayFactor', '2');
        store.set('agentPreset', 'ptc');
      },
    });

    await act(async () => {
      await rendered.result.current.save();
    });

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toEqual([
      { op: 'set', path: ['locale'], value: 'en' },
      { op: 'set', path: ['allowlist'], value: [PHONE] },
      { op: 'set', path: ['chunkedReplies'], value: true },
      { op: 'set', path: ['maxChunks'], value: 12 },
      { op: 'set', path: ['delayFactor'], value: 2 },
      { op: 'set', path: ['agentPreset'], value: 'ptc' },
      { op: 'set', path: ['contacts'], value: {} },
    ]);
  });

  it('omits the agentPreset op when the effective preset is empty', async () => {
    const mutate = vi.fn((_ops: unknown) => Promise.resolve(true) as Promise<boolean>);
    const { rendered } = mount({
      mutate: mutate as unknown as Mutate,
      seed: (store) => store.set('locale', 'en'),
    });

    await act(async () => {
      await rendered.result.current.save();
    });

    const ops = mutate.mock.calls[0]?.[0] as readonly { path: readonly string[] }[];
    expect(ops.map((op) => op.path[0])).toEqual([
      'locale',
      'allowlist',
      'chunkedReplies',
      'maxChunks',
      'delayFactor',
      'contacts',
    ]);
  });

  it('falls back to product defaults when neither draft nor saved value parses', async () => {
    // saved 也没有时用产品默认（开关关闭时草稿可能残留不可解析文本）
    const mutate = vi.fn((_ops: unknown) => Promise.resolve(true) as Promise<boolean>);
    const { rendered } = mount({
      mutate: mutate as unknown as Mutate,
      seed: (store) => {
        store.set('locale', 'en');
        store.set('maxChunks', 'garbage');
        store.set('delayFactor', 'garbage');
      },
    });

    await act(async () => {
      await rendered.result.current.save();
    });

    const ops = mutate.mock.calls[0]?.[0] as readonly { path: readonly string[]; value: unknown }[];
    expect(ops.find((op) => op.path[0] === 'maxChunks')?.value).toBe(8);
    expect(ops.find((op) => op.path[0] === 'delayFactor')?.value).toBe(1);
  });

  it('ignores a second save call while one is in flight', async () => {
    let release: (() => void) | undefined;
    const mutate = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        }),
    );
    const { rendered } = mount({
      mutate: mutate as unknown as Mutate,
      seed: (store) => store.set('locale', 'en'),
    });

    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = rendered.result.current.save();
    });
    await act(async () => {
      await rendered.result.current.save(); // saving 中：直接返回，不重复 mutate
    });
    await act(async () => {
      release?.();
      await first;
    });

    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('falls back to saved values when a hidden draft is unparseable', async () => {
    // 开关关闭时草稿可能残留不可解析文本：写回已保存值（界面本就不显示）
    const mutate = vi.fn((_ops: unknown) => Promise.resolve(true) as Promise<boolean>);
    const { rendered } = mount({
      mutate: mutate as unknown as Mutate,
      saved: { locale: 'zh', delayFactor: 2 },
      seed: (store) => {
        store.set('locale', 'en');
        store.set('maxChunks', 'garbage');
        store.set('delayFactor', 'garbage');
      },
    });

    await act(async () => {
      await rendered.result.current.save();
    });

    const ops = mutate.mock.calls[0]?.[0] as readonly { path: readonly string[]; value: unknown }[];
    expect(ops.find((op) => op.path[0] === 'maxChunks')?.value).toBe(8);
    expect(ops.find((op) => op.path[0] === 'delayFactor')?.value).toBe(2);
  });
});

describe('useSave · failure handling', () => {
  it('surfaces the error text when the mutation is rejected', async () => {
    const { rendered } = mount({
      mutate: (async () => false) as Mutate,
      seed: (s) => s.set('locale', 'en'),
    });

    await act(async () => {
      await rendered.result.current.save();
    });

    expect(rendered.result.current.error).toBe(MESSAGES.saveFailed);
  });

  it('surfaces the error text when the mutation throws', async () => {
    const { rendered } = mount({
      mutate: (async () => {
        throw new Error('rpc down');
      }) as unknown as Mutate,
      seed: (s) => s.set('locale', 'en'),
    });

    await act(async () => {
      await rendered.result.current.save();
    });

    expect(rendered.result.current.error).toBe(MESSAGES.saveFailed);
  });

  it('keeps the draft for retry after a rejection', async () => {
    const { rendered, store } = mount({
      mutate: (async () => false) as Mutate,
      seed: (s) => s.set('locale', 'en'),
    });

    await act(async () => {
      await rendered.result.current.save();
    });

    // 草稿未清：canSave 仍 true，可重试
    expect(store.getSnapshot().locale).toBe('en');
    expect(rendered.result.current.canSave).toBe(true);
  });
});

describe('useSave · contacts domain (M7, config-backed)', () => {
  function mountWithContacts(options: {
    mutate?: Mutate;
    saved?: Partial<SavedBaseline>;
    seed?: (store: DraftStore) => void;
  }) {
    return mount({
      mutate: options.mutate,
      saved: options.saved,
      seed: options.seed,
    });
  }

  it('contacts edits alone enable saving', () => {
    const { rendered } = mountWithContacts({
      saved: { contacts: {} },
      seed: (store) => {
        store.set('peerNames', { [PHONE]: '小陈' });
      },
    });
    expect(rendered.result.current.canSave).toBe(true);
  });

  it('writes contacts as one full-overwrite op through the config mutation', async () => {
    const mutate = vi.fn((_ops: unknown) => Promise.resolve(true) as Promise<boolean>);
    const { rendered } = mountWithContacts({
      mutate: mutate as unknown as Mutate,
      saved: { contacts: { '+8613900000000': '阿九' } },
      seed: (s) => {
        s.set('peerNames', { [PHONE]: '  小陈 ', '+8613900000000': '' });
      },
    });

    await act(async () => {
      await rendered.result.current.save();
    });

    const ops = mutate.mock.calls[0]?.[0] as Array<{ path: readonly string[]; value?: unknown }>;
    const contactsOp = ops.find((op) => op.path[0] === 'contacts');
    // 整字段覆盖：清洗后草稿（trim；空值剔除 = 删除阿九）
    expect(contactsOp).toEqual({ op: 'set', path: ['contacts'], value: { [PHONE]: '小陈' } });
  });

  it('writes the baseline back when contacts are clean (full-overwrite parity)', async () => {
    const mutate = vi.fn((_ops: unknown) => Promise.resolve(true) as Promise<boolean>);
    const { rendered } = mountWithContacts({
      mutate: mutate as unknown as Mutate,
      saved: { contacts: { [PHONE]: '小陈' } },
      seed: (s) => {
        s.set('locale', 'en'); // 只有 locale 域脏
      },
    });

    await act(async () => {
      await rendered.result.current.save();
    });

    const ops = mutate.mock.calls[0]?.[0] as Array<{ path: readonly string[]; value?: unknown }>;
    expect(ops.find((op) => op.path[0] === 'contacts')).toEqual({
      op: 'set',
      path: ['contacts'],
      value: { [PHONE]: '小陈' },
    });
  });
});
