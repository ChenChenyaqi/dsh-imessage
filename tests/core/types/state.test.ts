import { asSessionId } from '@/core/types/dsh';
import { describe, expect, it } from 'vitest';

import {
  SEEN_IDS_MAX,
  STATE_VERSION,
  deriveWorkspaceDir,
  isChannelState,
  makeChannelState,
  recordBinding,
} from '@/core/types/state';

describe('makeChannelState', () => {
  it('starts with null cursor, empty seenIds and sessions', () => {
    const state = makeChannelState();
    expect(state.cursor).toBeNull();
    expect(state.seenIds).toEqual([]);
    expect(state.sessions).toEqual({});
    expect(state.version).toBe(STATE_VERSION);
  });
});

describe('deriveWorkspaceDir', () => {
  it('keeps phone keys as-is under conversations/', () => {
    expect(deriveWorkspaceDir('+8613800000000')).toBe('conversations/+8613800000000');
  });

  it('sanitizes unsafe chars in email keys', () => {
    expect(deriveWorkspaceDir('alice@icloud.com')).toBe('conversations/alice_icloud.com');
  });
});

describe('recordBinding · first bind', () => {
  it('creates binding with derived workspace and single-entry history', () => {
    const state = recordBinding(makeChannelState(), '+8613800000000', asSessionId('s1'));
    const b = state.sessions['+8613800000000']!;
    expect(b.sessionId).toBe('s1');
    expect(b.workspaceDir).toBe('conversations/+8613800000000');
    expect(b.bindHistory).toEqual(['s1']);
  });
});

describe('recordBinding · rebind', () => {
  const setup = () =>
    recordBinding(
      recordBinding(makeChannelState(), '+8613800000000', asSessionId('s1')),
      '+8613800000000',
      asSessionId('s2'),
    );

  it('moves the pointer and appends history', () => {
    const b = setup().sessions['+8613800000000']!;
    expect(b.sessionId).toBe('s2');
    expect(b.bindHistory).toEqual(['s1', 's2']);
  });

  it('never changes the derived workspace dir', () => {
    expect(setup().sessions['+8613800000000']!.workspaceDir).toBe('conversations/+8613800000000');
  });
});

describe('recordBinding · dedup', () => {
  it('re-binding an old session keeps history order and unique', () => {
    // s1 → s2 → 切回 s1 → 再 s2：bindHistory 仍是 [s1, s2]
    let state = makeChannelState();
    for (const sid of ['s1', 's2', 's1', 's2', 's1']) {
      state = recordBinding(state, '+8613800000000', asSessionId(sid));
    }
    const b = state.sessions['+8613800000000']!;
    expect(b.sessionId).toBe('s1');
    expect(b.bindHistory).toEqual(['s1', 's2']);
  });
});

describe('recordBinding · purity', () => {
  it('does not mutate the input state', () => {
    const before = recordBinding(makeChannelState(), '+8613800000000', asSessionId('s1'));
    const snapshot = structuredClone(before);
    recordBinding(before, '+8613800000000', asSessionId('s2'));
    expect(before).toEqual(snapshot);
  });

  it('keeps other keys untouched', () => {
    let state = recordBinding(makeChannelState(), '+8613800000000', asSessionId('s1'));
    state = recordBinding(state, 'alice@icloud.com', asSessionId('e1'));
    expect(state.sessions['+8613800000000']!.sessionId).toBe('s1');
    expect(state.sessions['alice@icloud.com']!.sessionId).toBe('e1');
  });
});

describe('isChannelState', () => {
  it('accepts a fresh and a bound state', () => {
    expect(isChannelState(makeChannelState())).toBe(true);
    expect(
      isChannelState(recordBinding(makeChannelState(), '+8613800000000', asSessionId('s1'))),
    ).toBe(true);
  });

  it('rejects malformed objects', () => {
    expect(isChannelState(null)).toBe(false);
    expect(isChannelState({ version: 1 })).toBe(false);
    expect(isChannelState({ ...makeChannelState(), seenIds: 'nope' })).toBe(false);
    expect(
      isChannelState({
        ...makeChannelState(),
        sessions: { k: { sessionId: 1, workspaceDir: 'x', bindHistory: [] } },
      }),
    ).toBe(false);
  });

  it('rejects a cursor that is neither null nor a number', () => {
    // cursor 为字符串：过不了「null 或 number」检查
    expect(isChannelState({ ...makeChannelState(), cursor: '42' })).toBe(false);
  });

  it('rejects seenIds that is an object but not an array', () => {
    // 对象非数组：能通过 typeof 检查，但不是合法的 guid 环形列表
    expect(isChannelState({ ...makeChannelState(), seenIds: { length: 0 } })).toBe(false);
  });

  it('rejects seenIds containing non-string entries', () => {
    // 数组里混入数字：去重列表必须全为字符串 guid
    expect(isChannelState({ ...makeChannelState(), seenIds: ['ok', 42] })).toBe(false);
  });

  it('rejects sessions that is null or not an object', () => {
    // sessions 为 null / 字符串：台账结构不合法
    expect(isChannelState({ ...makeChannelState(), sessions: null })).toBe(false);
    expect(isChannelState({ ...makeChannelState(), sessions: 'nope' })).toBe(false);
  });
});

describe('constants', () => {
  it('exports sane ring size and version', () => {
    expect(SEEN_IDS_MAX).toBeGreaterThan(0);
    expect(STATE_VERSION).toBe(1);
  });
});
