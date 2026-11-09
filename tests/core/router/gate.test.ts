import { describe, expect, it } from 'vitest';

import {
  evaluateGate,
  markSeen,
  unmarkSeen,
} from '@/core/router/gate';
import { makePolicy } from '@/core/types/policy';
import { makeMessage } from '../../helpers/messages';

// ---------------------------------------------------------------------------
// evaluateGate
// ---------------------------------------------------------------------------

describe('evaluateGate', () => {
  const policy = makePolicy(['+8613800000000']);

  it('passes an unseen message from an allowlisted key', () => {
    expect(evaluateGate(policy, [], makeMessage())).toEqual({ pass: true });
  });

  it('rejects an already-seen guid even if allowlisted (seen is absolute fact)', () => {
    const msg = makeMessage();
    const verdict = evaluateGate(policy, [msg.guid], msg);
    expect(verdict).toEqual({ pass: false, reason: 'already-seen' });
  });

  it('rejects a key outside the allowlist', () => {
    const verdict = evaluateGate(policy, [], makeMessage({ conversationKey: '+8613900000000' }));
    expect(verdict).toEqual({ pass: false, reason: 'not-allowlisted' });
  });

  it('defensively rejects an unparseable key', () => {
    const verdict = evaluateGate(policy, [], makeMessage({ conversationKey: '12345' }));
    expect(verdict).toEqual({ pass: false, reason: 'unparseable-key' });
  });

  it('checks seen before allowlist (a formerly-allowed seen guid stays rejected)', () => {
    // 用户把号码移出白名单后，已处理的旧消息依然按 already-seen 拒
    const msg = makeMessage();
    const shrunk = makePolicy([]);
    expect(evaluateGate(shrunk, [msg.guid], msg)).toEqual({ pass: false, reason: 'already-seen' });
  });
});

// ---------------------------------------------------------------------------
// markSeen / unmarkSeen（claim 台账）
// ---------------------------------------------------------------------------

describe('markSeen', () => {
  it('prepends the guid (newest first)', () => {
    expect(markSeen(['a'], 'b')).toEqual(['b', 'a']);
  });

  it('is idempotent for an already-claimed guid (same reference)', () => {
    const seen = ['a', 'b'];
    expect(markSeen(seen, 'a')).toBe(seen);
  });

  it('evicts the oldest entries beyond the ring capacity', () => {
    const capacity = 500;
    const full = Array.from({ length: capacity }, (_, i) => `g${capacity - 1 - i}`); // g499..g0
    const next = markSeen(full, 'fresh');
    expect(next).toHaveLength(capacity);
    expect(next[0]).toBe('fresh');
    expect(next[1]).toBe(`g${capacity - 1}`); // 原最新仍在
    expect(next).not.toContain('g0'); // 最旧的被挤出
  });
});

describe('unmarkSeen', () => {
  it('removes the guid wherever it sits', () => {
    expect(unmarkSeen(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
    expect(unmarkSeen(['a'], 'a')).toEqual([]);
  });

  it('returns the same reference when the guid is absent (idempotent)', () => {
    const seen = ['a'];
    expect(unmarkSeen(seen, 'zzz')).toBe(seen);
  });

  it('mark → unmark round-trips to the original order', () => {
    const seen = ['a', 'b'];
    expect(unmarkSeen(markSeen(seen, 'c'), 'c')).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// 时序契约（钉住 claim 语义供 pipeline 遵守）
// ---------------------------------------------------------------------------

describe('gate · claim contract', () => {
  it('a claimed message is invisible to subsequent evaluations until unmarked', async () => {
    const policy = makePolicy(['+8613800000000']);
    const msg = makeMessage();
    const claimed = markSeen([], msg.guid);
    expect(evaluateGate(policy, claimed, msg).pass).toBe(false);
    const released = unmarkSeen(claimed, msg.guid);
    expect(evaluateGate(policy, released, msg).pass).toBe(true);
  });
});
