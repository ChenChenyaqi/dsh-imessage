// usePreset 规格（方案 D：context 自取；草稿走 store，roster 走 remote）。

// @vitest-environment jsdom
import { createElement } from 'react';

import { describe, expect, it } from 'vitest';

import { settingsMessages } from '@/client/i18n/text';
import { CardProvider, type CardContextValue } from '@/client/settings/card-context';
import { createDraftStore, type DraftStore } from '@/client/settings/draft-store';
import type { SavedBaseline } from '@/client/settings/useCardForm';
import { type PresetRemote } from '@/client/settings/preset/logic';
import { usePreset } from '@/client/settings/preset/usePreset';
import type { PresetRosterRow } from '@/client/settings/preset/logic';
import { act, renderHook } from '../../../helpers/render-hook';

const MESSAGES = settingsMessages.zh;

function makeRemote(
  result:
    | { ok: true; value: { presets: PresetRosterRow[] } }
    | { ok: false }
    | 'pending',
): PresetRemote {
  return {
    list: () => (result === 'pending' ? new Promise<Pnever>(() => undefined) : Promise.resolve(result)),
  };
}
type Pnever = { ok: true; value: { presets: PresetRosterRow[] } } | { ok: false };

function mount(
  options: {
    saved?: Partial<SavedBaseline>;
    remote?: PresetRemote;
    store?: DraftStore;
  } = {},
) {
  const store = options.store ?? createDraftStore();
  let value: CardContextValue = {
    store,
    saved: { locale: 'zh', allowlist: [], ...options.saved },
    mutate: async () => true,
    messages: MESSAGES,
    remote: options.remote,
  };
  const rendered = renderHook(() => usePreset(), {
    wrapper: ({ children }) => createElement(CardProvider, { value }, children),
  });
  const push = (next: Partial<SavedBaseline>) => {
    value = { ...value, saved: { locale: 'zh', allowlist: [], ...options.saved, ...next } };
    rendered.rerender();
  };
  return { ...rendered, push, store };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('usePreset · draft', () => {
  it('uses the saved preset as the draft until edited', () => {
    const { result } = mount({ saved: { agentPreset: 'ptc' } });
    expect(result.current.draft).toBe('ptc');
  });

  it('keeps a dirty draft when the host pushes the same field (draft wins)', () => {
    const { result, push } = mount({ saved: { agentPreset: 'standard' } });

    act(() => result.current.setDraft('ptc'));
    expect(result.current.dirty).toBe(true);

    push({ agentPreset: 'standard' });
    expect(result.current.draft).toBe('ptc');
  });

  it('treats an empty draft as "back to default" (not an error)', () => {
    const { result } = mount({});
    expect(result.current.draft).toBe('');
    expect(result.current.presetError).toBe(false);
  });

  it('flags a malformed draft (not a preset-id shape)', () => {
    const { result } = mount({});
    act(() => result.current.setDraft('Not A Preset!'));
    expect(result.current.presetError).toBe(true);
  });
});

describe('usePreset · roster', () => {
  it('loads the roster from remote once after mount', async () => {
    const { result } = mount({
      remote: makeRemote({
        ok: true,
        value: { presets: [{ id: 'ptc' }, { id: 'standard', isDefault: true }] },
      }),
    });

    await flush();
    expect(result.current.options.map((o) => o.id)).toEqual(['ptc', 'standard']);
    // 保 roster 顺序；isDefault 只标注，不重排
    expect(result.current.options.find((o) => o.isDefault)?.id).toBe('standard');
  });

  it('degrades to an empty roster when the service call fails', async () => {
    const { result } = mount({ remote: makeRemote({ ok: false }) });

    await flush();
    expect(result.current.options).toEqual([]);
  });

  it('degrades to an empty roster when the service is missing', async () => {
    const { result } = mount({});

    await flush();
    expect(result.current.options).toEqual([]);
  });
});
