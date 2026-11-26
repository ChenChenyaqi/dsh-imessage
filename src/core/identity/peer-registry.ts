// PeerRegistry：sessionId → note 的进程内查表（dsh-im imessage-peer.mjs
// PeerRegistry 同款语义，TS 化 + SessionId branded）。
//
// 消费方（Step B）：systemPrompt.context 的 text 回调每次 prompt 组装
// 都会查表——get 未命中返回 undefined → 调用方回空串，非 iMessage
// 会话与未发布会话天然不可见。

import type { SessionId } from '../types/dsh';

/** 进程内上限（dsh-im MAX_SESSIONS 同值：防绑定表异常膨胀把内存
 *  撑爆；正常运营远达不到）。 */
export const DEFAULT_MAX_PEER_ENTRIES = 1_024;

export interface PeerRegistryOptions {
  /** 上限（默认 1024）。 */
  readonly maxEntries?: number;
}

export class PeerRegistry {
  readonly #bySession = new Map<SessionId, string>();
  readonly #maxEntries: number;

  constructor(options: PeerRegistryOptions = {}) {
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_PEER_ENTRIES;
  }

  /**
   * 发布一个会话的 note；空白 note = 清除（单一入口）。
   * 重复发布同一会话刷新 LRU 新鲜度（delete-then-set）。
   */
  publish(sessionId: SessionId, note: string): void {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    this.#bySession.delete(sessionId);
    if (typeof note !== 'string' || note.trim() === '') return;
    this.#bySession.set(sessionId, note);
    while (this.#bySession.size > this.#maxEntries) {
      const oldest = this.#bySession.keys().next().value;
      if (oldest === undefined) break;
      this.#bySession.delete(oldest);
    }
  }

  /** 查 note：未发布 → undefined。 */
  get(sessionId: SessionId): string | undefined {
    return typeof sessionId === 'string' ? this.#bySession.get(sessionId) : undefined;
  }

  /** 清除一个会话的 note。 */
  forget(sessionId: SessionId): void {
    if (typeof sessionId === 'string') this.#bySession.delete(sessionId);
  }

  /** 清空全部（测试与通道重建用）。 */
  clear(): void {
    this.#bySession.clear();
  }

  /** 当前条目数（观测/测试用）。 */
  size(): number {
    return this.#bySession.size;
  }
}
