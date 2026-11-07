import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  decodeAttributedBodyText,
  OBJECT_REPLACEMENT_CHAR,
} from '@/core/imessage/typedstream';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const UTF8 = new TextEncoder();

/** 构造最小可解码 blob：魔数头 + NSString 类名 + '+' 标签 + 长度 + payload。 */
function makeBlob(
  payload: Uint8Array,
  lengthPrefix: Uint8Array = new Uint8Array([payload.length]),
): Uint8Array {
  const head = new Uint8Array([0x04, 0x0b, ...UTF8.encode('streamtyped')]);
  const parts = [
    head,
    UTF8.encode('NSString'),
    new Uint8Array([0x2b]),
    lengthPrefix,
    payload,
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 结构 fixture：真实 blob 的结构骨架 + 合成文本（零隐私）
//
// 生成方式：从真实 chat.db dump 的 attributedBody 中定位 payload 段，
// 整体替换为合成文本并重写长度前缀；头部（魔数/类注册）与尾部（属性
// 字典）字节原样保留——结构 100% 来自真实数据（SMS/iMessage 结构差异、
// 单字节与 0x81 长度编码、多段文本、FFFC 前缀），内容零隐私。
// ---------------------------------------------------------------------------

interface FixtureEntry {
  readonly hex: string;
  readonly kind: 'structure';
  readonly expected: string;
}

const FIXTURE: readonly FixtureEntry[] = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'attributed-body.json'), 'utf8'),
) as FixtureEntry[];

describe('decodeAttributedBodyText · structure fixtures', () => {
  it('decodes every real-structure sample to its synthetic text', () => {
    expect(FIXTURE.length).toBe(8);
    for (const x of FIXTURE) {
      expect(decodeAttributedBodyText(hexToBytes(x.hex))).toBe(x.expected);
    }
  });

  it('covers both length encodings across real structures', () => {
    // 单字节字面长度与 0x81 两字节长度都必须出现在结构样本里
    const encodings = FIXTURE.map((x) => {
      const b = hexToBytes(x.hex);
      const marker = b.findIndex((_, i) =>
        NSStringAt(b, i),
      );
      let tag = marker + 8;
      while (b[tag] !== 0x2b) tag++;
      return b[tag + 1] === 0x81 ? '0x81' : 'literal';
    });
    expect(new Set(encodings)).toEqual(new Set(['0x81', 'literal']));
  });
});

function NSStringAt(b: Uint8Array, off: number): boolean {
  const bytes = [0x4e, 0x53, 0x53, 0x74, 0x72, 0x69, 0x6e, 0x67];
  return bytes.every((v, j) => b[off + j] === v);
}

// ---------------------------------------------------------------------------
// 构造用例：覆盖结构样本里没有的形态
// ---------------------------------------------------------------------------

describe('decodeAttributedBodyText · constructed blobs', () => {
  it('decodes multibyte text (CJK + emoji)', () => {
    const payload = UTF8.encode('你好 🌍 世界');
    expect(decodeAttributedBodyText(makeBlob(payload))).toBe('你好 🌍 世界');
  });

  it('decodes multi-paragraph text with newlines', () => {
    const payload = UTF8.encode('第一段\n\n第二段');
    expect(decodeAttributedBodyText(makeBlob(payload))).toBe('第一段\n\n第二段');
  });

  it('preserves trailing whitespace verbatim (no trim in decoder)', () => {
    const payload = UTF8.encode('原文保留尾部空白  ');
    expect(decodeAttributedBodyText(makeBlob(payload))).toBe('原文保留尾部空白  ');
  });

  it('supports the 2-byte length form (0x81) for long payloads', () => {
    const text = '长'.repeat(300); // 900 字节，必须走 0x81 编码
    const payload = UTF8.encode(text);
    const prefix = new Uint8Array([0x81, payload.length & 0xff, payload.length >> 8]);
    expect(decodeAttributedBodyText(makeBlob(payload, prefix))).toBe(text);
  });

  it('supports the 4-byte length form (0x82)', () => {
    const text = 'x'.repeat(300); // 300 字节，用 0x82 编码声明
    const payload = UTF8.encode(text);
    const view = new DataView(new ArrayBuffer(4));
    view.setInt32(0, payload.length, true);
    const prefix = new Uint8Array([0x82, ...new Uint8Array(view.buffer)]);
    expect(decodeAttributedBodyText(makeBlob(payload, prefix))).toBe(text);
  });

  it('strips attachment placeholders from captioned text', () => {
    const payload = UTF8.encode(`${OBJECT_REPLACEMENT_CHAR}看这张图${OBJECT_REPLACEMENT_CHAR}`);
    expect(decodeAttributedBodyText(makeBlob(payload))).toBe('看这张图');
  });

  it('returns empty string for attachment-only bodies (all U+FFFC)', () => {
    const payload = UTF8.encode(OBJECT_REPLACEMENT_CHAR.repeat(3));
    expect(decodeAttributedBodyText(makeBlob(payload))).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 降级与防御
// ---------------------------------------------------------------------------

describe('decodeAttributedBodyText · degradation', () => {
  it('returns null on missing / empty input', () => {
    expect(decodeAttributedBodyText(null)).toBeNull();
    expect(decodeAttributedBodyText(undefined)).toBeNull();
    expect(decodeAttributedBodyText(new Uint8Array(0))).toBeNull();
  });

  it('returns null when the class name is absent', () => {
    const blob = new Uint8Array([0x01, 0x02, 0x2b, 0x03, 0x61, 0x62, 0x63]);
    expect(decodeAttributedBodyText(blob)).toBeNull();
  });

  it('returns null when no inline tag follows the class name', () => {
    const blob = new Uint8Array([...UTF8.encode('NSString'), 0x01, 0x02, 0x03]);
    expect(decodeAttributedBodyText(blob)).toBeNull();
  });

  it('returns null when the declared length overruns the blob (truncation)', () => {
    const payload = UTF8.encode('hello');
    const lyingPrefix = new Uint8Array([0x50]); // 声称 80 字节，实际 5
    expect(decodeAttributedBodyText(makeBlob(payload, lyingPrefix))).toBeNull();
  });

  it('returns null on invalid UTF-8 payload bytes', () => {
    const payload = new Uint8Array([0xff, 0xfe, 0xfd]);
    expect(decodeAttributedBodyText(makeBlob(payload))).toBeNull();
  });

  it('returns null on a negative single-byte length', () => {
    const payload = UTF8.encode('hello');
    const badPrefix = new Uint8Array([0xff]); // -1（有符号）
    expect(decodeAttributedBodyText(makeBlob(payload, badPrefix))).toBeNull();
  });
});
