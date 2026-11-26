// PeerRegistry：sessionId → note 的进程内查表（dsh-im imessage-peer.mjs
// 同款语义）。Step B 的 systemPrompt.context text 回调每次组装都查表，
// 空 note = 非 iMessage 会话 / 未发布会话，天然不可见。

import { asSessionId, type SessionId } from '@/core/types/dsh';
import { describe, expect, it } from 'vitest';

import { PeerRegistry } from '@/core/identity/peer-registry';

const sid = (n: number): SessionId => asSessionId(`session-${n}`);

describe('PeerRegistry', () => {
  it('stores and retrieves a note by session id', () => {
    const reg = new PeerRegistry();
    reg.publish(sid(1), 'note-a');
    expect(reg.get(sid(1))).toBe('note-a');
  });

  it('publishing an empty note clears the entry (empty = not published)', () => {
    const reg = new PeerRegistry();
    reg.publish(sid(1), 'note-a');
    reg.publish(sid(1), '');
    expect(reg.get(sid(1))).toBeUndefined();
    reg.publish(sid(2), '   ');
    expect(reg.get(sid(2))).toBeUndefined();
  });

  it('re-publishing refreshes LRU recency (delete-then-set, dsh-im parity)', () => {
    const reg = new PeerRegistry({ maxEntries: 2 });
    reg.publish(sid(1), 'a');
    reg.publish(sid(2), 'b');
    reg.publish(sid(1), 'a2'); // refresh 1 above the eviction line
    reg.publish(sid(3), 'c'); // evicts 2, not 1
    expect(reg.get(sid(1))).toBe('a2');
    expect(reg.get(sid(2))).toBeUndefined();
    expect(reg.get(sid(3))).toBe('c');
  });

  it('evicts the least recently published entry above the cap', () => {
    const reg = new PeerRegistry({ maxEntries: 2 });
    reg.publish(sid(1), 'a');
    reg.publish(sid(2), 'b');
    reg.publish(sid(3), 'c');
    expect(reg.get(sid(1))).toBeUndefined();
    expect(reg.size()).toBe(2);
  });

  it('ignores non-string or empty session ids', () => {
    const reg = new PeerRegistry();
    reg.publish(undefined as unknown as SessionId, 'a');
    reg.publish('' as SessionId, 'a');
    expect(reg.size()).toBe(0);
    // get / forget 对非 string 入参同样防御（branded 类型只是编译期约束，
    // text 回调拿到的 assembly 是动态对象）
    expect(reg.get(undefined as unknown as SessionId)).toBeUndefined();
    expect(() => reg.forget(undefined as unknown as SessionId)).not.toThrow();
    expect(() => reg.forget(42 as unknown as SessionId)).not.toThrow();
  });

  it('forget removes one entry; clear removes all', () => {
    const reg = new PeerRegistry();
    reg.publish(sid(1), 'a');
    reg.publish(sid(2), 'b');
    reg.forget(sid(1));
    expect(reg.get(sid(1))).toBeUndefined();
    expect(reg.get(sid(2))).toBe('b');
    reg.clear();
    expect(reg.size()).toBe(0);
  });
});
