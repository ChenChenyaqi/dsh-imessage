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
    attachmentName: null,
    attachmentBytes: null,
    threadOriginatorGuid: null,
    quotedRowId: null,
    quotedText: null,
    quotedAttributedBodyHex: null,
    quotedFromMe: null,
    quotedAttachmentPath: null,
    quotedAttachmentMime: null,
    quotedAttachmentName: null,
    quotedAttachmentBytes: null,
    quotedDateNs: null,
    ...over,
  };
}

function accepted(result: NormalizeResult | undefined) {
  expect(result).toBeDefined();
  expect(result!.status).toBe('accepted');
  return result! as unknown as {
    status: 'accepted';
    message: {
      text: string;
      replyTo?: import('@/core/types/messages').NormalizedMessage['replyTo'];
      quotedImage?: import('@/core/types/messages').MessageAttachment;
      attachments?: readonly import('@/core/types/messages').MessageAttachment[];
      [k: string]: unknown;
    };
  };
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
    const [r] = normalizeRows([makeRow({ text: null, attributedBody: makeBlob('正文来自 BLOB') })]);
    expect(accepted(r).message.text).toBe('正文来自 BLOB');
  });

  it('maps attachment-only bodies to the attachment placeholder', () => {
    const [r] = normalizeRows([makeRow({ text: null, attributedBody: makeBlob('￼') })]);
    expect(accepted(r).message.text).toBe(ATTACHMENT_PLACEHOLDER);
  });

  it('maps undecodable bodies to the undecodable placeholder', () => {
    const [r] = normalizeRows([
      makeRow({ text: null, attributedBody: new Uint8Array([0xff, 0xfe]) }),
    ]);
    expect(accepted(r).message.text).toBe(UNDECODABLE_PLACEHOLDER);
  });

  it('keeps quoted text through normalization', () => {
    const [r] = normalizeRows([
      makeRow({
        threadOriginatorGuid: 'GUID-Q',
        quotedRowId: 9,
        quotedFromMe: 0,
        quotedText: '被引用的原话',
      }),
    ]);
    expect(accepted(r).message.replyTo).toEqual({ author: 'them', text: '被引用的原话' });
    expect(accepted(r).message.quotedImage).toBeUndefined();
  });

  it('marks the reply author as us when the quoted row is our own earlier reply', () => {
    const [r] = normalizeRows([
      makeRow({
        threadOriginatorGuid: 'GUID-Q',
        quotedRowId: 9,
        quotedFromMe: 1,
        quotedText: '我早期的回复',
      }),
    ]);
    expect(accepted(r).message.replyTo).toEqual({ author: 'us', text: '我早期的回复' });
  });

  it('falls back to the quoted attributedBody when the text column is empty', () => {
    const blob = makeBlob('原话在 BLOB 里');
    const hex = [...blob].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
    const [r] = normalizeRows([
      makeRow({
        threadOriginatorGuid: 'GUID-Q',
        quotedRowId: 9,
        quotedText: null,
        quotedAttributedBodyHex: hex,
      }),
    ]);
    expect(accepted(r).message.replyTo?.text).toBe('原话在 BLOB 里');
  });

  it('keeps the degraded placeholder when the quoted row was pruned', () => {
    const [r] = normalizeRows([makeRow({ threadOriginatorGuid: 'GUID-GONE', quotedRowId: null })]);
    expect(accepted(r).message.replyTo).toEqual({
      author: 'them',
      text: '（图片或贴纸消息）',
      unavailable: true,
    });
  });

  it('describes an image-only quote from the quoted attachment', () => {
    const [r] = normalizeRows([
      makeRow({
        threadOriginatorGuid: 'GUID-Q',
        quotedRowId: 9,
        quotedText: null,
        quotedAttributedBodyHex: null,
        quotedAttachmentPath: '~/Library/Messages/Attachments/ab/cd/img.heic',
        quotedAttachmentMime: 'image/heic',
        quotedAttachmentName: 'IMG.heic',
        quotedAttachmentBytes: 1000,
      }),
    ]);
    expect(accepted(r).message.replyTo?.text).toBe('（一张图片）');
    expect(accepted(r).message.quotedImage).toEqual({
      path: '~/Library/Messages/Attachments/ab/cd/img.heic',
      mediaType: 'image/heic',
      name: 'IMG.heic',
      bytes: 1000,
    });
  });

  it('strips the object-replacement char from the quoted text', () => {
    const [r] = normalizeRows([
      makeRow({
        threadOriginatorGuid: 'GUID-Q',
        quotedRowId: 9,
        quotedText: '\uFFFC',
        quotedAttachmentPath: null,
      }),
    ]);
    expect(accepted(r).message.replyTo?.text).toBe('（图片或贴纸消息）');
  });

  it('keeps a pure quote reply (no new words) out of the attachment placeholder', () => {
    const [r] = normalizeRows([
      makeRow({
        text: null,
        attributedBody: makeBlob('\uFFFC'),
        threadOriginatorGuid: 'GUID-Q',
        quotedRowId: 9,
        quotedFromMe: 0,
        quotedText: '被引用的原话',
      }),
    ]);
    const m = accepted(r).message;
    expect(m.text).toBe('');
    expect(m.replyTo?.text).toBe('被引用的原话');
  });

  it('dedupes the fan-out of own and quoted attachment joins, keeping the first quoted image', () => {
    // 本消息 2 附件 × 引用 2 附件 = 4 行扇出；去重后 own 2、quoted 取首张图
    const rows = [
      makeRow({
        guid: 'GUID-F',
        attachmentPath: '~/a1.png',
        attachmentMime: 'image/png',
        quotedAttachmentPath: '~/q1.heic',
        quotedAttachmentMime: 'image/heic',
        threadOriginatorGuid: 'GUID-Q',
        quotedRowId: 9,
        quotedText: '原话',
      }),
      makeRow({
        guid: 'GUID-F',
        attachmentPath: '~/a2.png',
        attachmentMime: 'image/png',
        quotedAttachmentPath: '~/q1.heic',
        quotedAttachmentMime: 'image/heic',
        threadOriginatorGuid: 'GUID-Q',
        quotedRowId: 9,
        quotedText: '原话',
      }),
      makeRow({
        guid: 'GUID-F',
        attachmentPath: '~/a1.png',
        attachmentMime: 'image/png',
        quotedAttachmentPath: '~/q2.gif',
        quotedAttachmentMime: 'image/gif',
        threadOriginatorGuid: 'GUID-Q',
        quotedRowId: 9,
        quotedText: '原话',
      }),
      makeRow({
        guid: 'GUID-F',
        attachmentPath: '~/a2.png',
        attachmentMime: 'image/png',
        quotedAttachmentPath: '~/q2.gif',
        quotedAttachmentMime: 'image/gif',
        threadOriginatorGuid: 'GUID-Q',
        quotedRowId: 9,
        quotedText: '原话',
      }),
    ];
    const [r] = normalizeRows(rows);
    const m = accepted(r).message;
    expect(m.attachments?.map((a) => a.path)).toEqual(['~/a1.png', '~/a2.png']);
    expect(m.quotedImage?.path).toBe('~/q1.heic');
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

  it('collects attachments of every expanded row, deduped by path (M6.1)', () => {
    const rows = [
      makeRow({
        rowid: 7,
        guid: 'G',
        text: '两个附件',
        attachmentPath: '/a1.heic',
        attachmentMime: 'image/heic',
        attachmentName: 'a1.heic',
        attachmentBytes: 100,
      }),
      makeRow({
        rowid: 7,
        guid: 'G',
        text: '两个附件',
        attachmentPath: '/a2.png',
        attachmentMime: 'image/png',
        attachmentName: 'a2.png',
        attachmentBytes: 200,
      }),
      // 同 path 重复行（防御 JOIN 重复）：去重
      makeRow({
        rowid: 7,
        guid: 'G',
        text: '两个附件',
        attachmentPath: '/a1.heic',
        attachmentMime: 'image/heic',
      }),
    ];
    const [r] = normalizeRows(rows);
    expect(accepted(r).message.attachments).toEqual([
      { path: '/a1.heic', mediaType: 'image/heic', name: 'a1.heic', bytes: 100 },
      { path: '/a2.png', mediaType: 'image/png', name: 'a2.png', bytes: 200 },
    ]);
  });

  it('keeps non-image attachments in metadata (media layer decides)', () => {
    const rows = [
      makeRow({
        text: 'look',
        attachmentPath: '/clip.mov',
        attachmentMime: 'video/quicktime',
        attachmentName: 'clip.mov',
        attachmentBytes: 8000,
      }),
    ];
    const [r] = normalizeRows(rows);
    expect(accepted(r).message.attachments).toEqual([
      { path: '/clip.mov', mediaType: 'video/quicktime', name: 'clip.mov', bytes: 8000 },
    ]);
  });

  it('omits the attachments field when no row carries one', () => {
    const rows = [makeRow({ text: '纯文本' }), makeRow({ rowid: 1, text: '纯文本' })];
    const [r] = normalizeRows(rows);
    expect(accepted(r).message.attachments).toBeUndefined();
  });

  it('normalizes image-only messages to empty text (image speaks)', () => {
    const rows = [
      makeRow({
        text: null,
        attributedBody: null,
        attachmentPath: '/img.png',
        attachmentMime: 'image/png',
        attachmentName: 'img.png',
        attachmentBytes: 300,
      }),
    ];
    const [r] = normalizeRows(rows);
    expect(accepted(r).message.text).toBe('');
    expect(accepted(r).message.attachments).toEqual([
      { path: '/img.png', mediaType: 'image/png', name: 'img.png', bytes: 300 },
    ]);
  });

  it('keeps the attachment placeholder when the only attachment is not an image', () => {
    // BLOB 剥 U+FFFC 后空 + mov 附件：无图可代言，维持占位降级
    const rows = [
      makeRow({
        text: null,
        attributedBody: makeBlob('￼'),
        attachmentPath: '/clip.mov',
        attachmentMime: 'video/quicktime',
      }),
    ];
    const [r] = normalizeRows(rows);
    expect(accepted(r).message.text).toBe(ATTACHMENT_PLACEHOLDER);
  });

  it('strips the U+FFFC object placeholder from the text column (image-only)', () => {
    // 真机实测（2026-11-22，guid 0F602B92…）：纯图消息 text 列就是单个
    // U+FFFC（hex EFBFBC）而非 NULL——不剥会发出空白文本块
    const rows = [
      makeRow({
        text: '￼',
        attachmentPath: '/img.png',
        attachmentMime: 'image/png',
      }),
    ];
    const [r] = normalizeRows(rows);
    expect(accepted(r).message.text).toBe('');
  });

  it('strips U+FFFC placeholders embedded in a caption but keeps the text', () => {
    // 图+文混排：占位符与正文交织，剥后保留人话（判定用 trim，内容不裁空白）
    const rows = [
      makeRow({
        text: '看这￼张图',
        attachmentPath: '/img.png',
        attachmentMime: 'image/png',
      }),
    ];
    const [r] = normalizeRows(rows);
    expect(accepted(r).message.text).toBe('看这张图');
  });

  it('treats whitespace-only text after stripping as image-only', () => {
    // 剥后只剩空白：与空文本同归，避免发空白 text 块
    const rows = [
      makeRow({
        text: ' ￼ ',
        attachmentPath: '/img.png',
        attachmentMime: 'image/png',
      }),
    ];
    const [r] = normalizeRows(rows);
    expect(accepted(r).message.text).toBe('');
  });

  it('falls back to the attachment placeholder when stripped text is empty without images', () => {
    // text='￼' + mov：无图可代言，与 BLOB 路径同款占位降级
    const rows = [
      makeRow({
        text: '￼',
        attachmentPath: '/clip.mov',
        attachmentMime: 'video/quicktime',
      }),
    ];
    const [r] = normalizeRows(rows);
    expect(accepted(r).message.text).toBe(ATTACHMENT_PLACEHOLDER);
  });

  it('still skips empty messages without attachments (defensive)', () => {
    const rows = [makeRow({ text: null, attributedBody: null })];
    const [r] = normalizeRows(rows);
    expect(skipped(r).reason).toBe('empty');
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
