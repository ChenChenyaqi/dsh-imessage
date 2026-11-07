import { describe, expect, it } from 'vitest';

import type { ChatDbRow } from '@/core/imessage/chatdb';
import {
  ATTACHMENT_PLACEHOLDER,
  macAbsoluteToEpochMs,
  normalizeRows,
  UNDECODABLE_PLACEHOLDER,
  type NormalizeResult,
} from '@/core/imessage/normalize';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const UTF8 = new TextEncoder();

/** 最小可解码 typedstream blob（与 typedstream.test 同构）。 */
function makeBlob(payloadText: string): Uint8Array {
  const payload = UTF8.encode(payloadText);
  const parts = [
    new Uint8Array([0x04, 0x0b, ...UTF8.encode('streamtyped')]),
    UTF8.encode('NSString'),
    new Uint8Array([0x2b]),
    new Uint8Array([payload.length]),
    payload,
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function makeRow(over: Partial<ChatDbRow> = {}): ChatDbRow {
  return {
    rowid: 1,
    guid: 'GUID-1',
    text: 'hello',
    attributedBody: null,
    dateNs: '815743613388000000',
    isFromMe: 0,
    handleText: '+8613800000000',
    service: 'iMessage',
    chatGuid: 'CHAT-1',
    style: 45,
    memberCount: 1,
    attachmentPath: null,
    attachmentMime: null,
    quotedText: null,
    quotedDateNs: null,
    ...over,
  };
}

function accepted(result: NormalizeResult | undefined) {
  expect(result).toBeDefined();
  expect(result!.status).toBe('accepted');
  return result! as unknown as { status: 'accepted'; message: { text: string; [k: string]: unknown } };
}

function skipped(result: NormalizeResult | undefined) {
  expect(result).toBeDefined();
  expect(result!.status).toBe('skipped');
  return result! as unknown as { status: 'skipped'; reason: string };
}

// ---------------------------------------------------------------------------
// date 转换
// ---------------------------------------------------------------------------

describe('macAbsoluteToEpochMs', () => {
  it('converts Mac absolute nanoseconds to epoch milliseconds', () => {
    // 本机实测样本：1921 行 → 2026-11-07 19:26:51.140 (本地时区)
    expect(macAbsoluteToEpochMs('815743611140000128')).toBe(1794050811140);
    // 边界：纳秒不是整毫秒时向下取整（BigInt 整除）
    expect(macAbsoluteToEpochMs('815743611140000999')).toBe(1794050811140);
  });

  it('throws TypeError on garbage input', () => {
    expect(() => macAbsoluteToEpochMs('not-a-number')).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// 文本双源与占位
// ---------------------------------------------------------------------------

describe('normalizeRows · text sources', () => {
  it('uses the text column when present', () => {
    const [r] = normalizeRows([makeRow({ text: 'plain text' })]);
    expect(accepted(r).message.text).toBe('plain text');
  });

  it('falls back to typedstream decode when text column is empty', () => {
    const [r] = normalizeRows([
      makeRow({ text: null, attributedBody: makeBlob('正文来自 BLOB') }),
    ]);
    expect(accepted(r).message.text).toBe('正文来自 BLOB');
  });

  it('maps attachment-only bodies to the attachment placeholder', () => {
    const [r] = normalizeRows([
      makeRow({ text: null, attributedBody: makeBlob('￼') }),
    ]);
    expect(accepted(r).message.text).toBe(ATTACHMENT_PLACEHOLDER);
  });

  it('maps undecodable bodies to the undecodable placeholder', () => {
    const [r] = normalizeRows([
      makeRow({ text: null, attributedBody: new Uint8Array([0xff, 0xfe]) }),
    ]);
    expect(accepted(r).message.text).toBe(UNDECODABLE_PLACEHOLDER);
  });

  it('keeps quoted text through normalization', () => {
    const [r] = normalizeRows([makeRow({ quotedText: '被引用的原话' })]);
    expect(accepted(r).message.quotedText).toBe('被引用的原话');
  });
});

// ---------------------------------------------------------------------------
// 过滤分支（防循环 + 默认拒绝）
// ---------------------------------------------------------------------------

describe('normalizeRows · skip branches', () => {
  it('skips messages from me (defensive, SQL already filters)', () => {
    const [r] = normalizeRows([makeRow({ isFromMe: 1 })]);
    expect(skipped(r).reason).toBe('from-me');
  });

  it('skips group chats (memberCount > 1)', () => {
    const [r] = normalizeRows([makeRow({ memberCount: 3 })]);
    expect(skipped(r).reason).toBe('group-chat');
  });

  it('skips messages without a handle (system events)', () => {
    const [r] = normalizeRows([makeRow({ handleText: null })]);
    expect(skipped(r).reason).toBe('no-handle');
  });

  it('skips invalid handles (bare digits / out-of-range junk)', () => {
    const [a] = normalizeRows([makeRow({ handleText: '12345678' })]);
    expect(skipped(a).reason).toBe('invalid-handle');
    const [b] = normalizeRows([
      makeRow({ handleText: '+861234567890123456789' }), // 21 位垃圾
    ]);
    expect(skipped(b).reason).toBe('invalid-handle');
  });

  it('skips our own system replies by [dsh] prefix', () => {
    const [r] = normalizeRows([makeRow({ text: '[dsh] 会话已归档' })]);
    expect(skipped(r).reason).toBe('bot-prefix');
  });

  it('skips bodies with neither text nor blob', () => {
    const [r] = normalizeRows([makeRow({ text: null, attributedBody: null })]);
    expect(skipped(r).reason).toBe('empty');
  });
});

// ---------------------------------------------------------------------------
// 归一化输出
// ---------------------------------------------------------------------------

describe('normalizeRows · accepted shape', () => {
  it('derives conversationKey from the phone normalizer', () => {
    const [r] = normalizeRows([makeRow({ handleText: '+8613800000000' })]);
    const m = accepted(r).message;
    expect(m.conversationKey).toBe('+8613800000000');
    expect(m.guid).toBe('GUID-1');
    expect(m.rowId).toBe(1);
    expect(m.fromMe).toBe(false);
    expect(m.date).toBe(macAbsoluteToEpochMs('815743613388000000'));
  });

  it('accepts Apple ID emails as conversation keys (lowercased)', () => {
    const [r] = normalizeRows([makeRow({ handleText: 'Alice@iCloud.com' })]);
    expect(accepted(r).message.conversationKey).toBe('alice@icloud.com');
  });

  it('freezes the produced message (immutability contract)', () => {
    const [r] = normalizeRows([makeRow()]);
    expect(Object.isFrozen(accepted(r).message)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 多行合并
// ---------------------------------------------------------------------------

describe('normalizeRows · multi-row merge', () => {
  it('merges attachment-expanded rows of the same guid into one message', () => {
    const rows = [
      makeRow({ rowid: 7, guid: 'G', text: '两个附件的消息', attachmentPath: '/a1.heic' }),
      makeRow({ rowid: 7, guid: 'G', text: '两个附件的消息', attachmentPath: '/a2.heic' }),
      makeRow({ rowid: 8, guid: 'G2', text: '下一条' }),
    ];
    const results = normalizeRows(rows);
    expect(results).toHaveLength(2);
    expect(accepted(results[0]!).message.text).toBe('两个附件的消息');
    expect(accepted(results[1]!).message.text).toBe('下一条');
  });

  it('preserves rowid ascending order', () => {
    const rows = [
      makeRow({ rowid: 5, guid: 'G5' }),
      makeRow({ rowid: 3, guid: 'G3' }),
      makeRow({ rowid: 4, guid: 'G4' }),
    ];
    const results = normalizeRows(rows);
    expect(results.map((r) => (r.status === 'accepted' ? r.message.rowId : r.rowId))).toEqual([
      3, 4, 5,
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(normalizeRows([])).toEqual([]);
  });
});
