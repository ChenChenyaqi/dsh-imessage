// NormalizedMessage 测试工厂：字段多且全冻结，逐处手写构造太吵。

import type { NormalizedMessage } from '@/core/types/messages';

/** 只需覆盖关心的字段，其余用稳定默认值。 */
export type MessageInit = Partial<NormalizedMessage>;

let seq = 0;

/** 构造一条标准形态的入站消息（默认白名单友好键 +8613800000000）。 */
export function makeMessage(init: MessageInit = {}): NormalizedMessage {
  seq += 1;
  return Object.freeze({
    guid: `g${seq}`,
    rowId: seq,
    date: 1_700_000_000_000 + seq,
    fromMe: false,
    text: `message ${seq}`,
    conversationKey: '+8613800000000',
    ...init,
  } satisfies NormalizedMessage);
}
