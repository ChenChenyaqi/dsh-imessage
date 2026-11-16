// 分段回复域纯函数规格（此前经状态机间接覆盖；归位时补直测，测试先行）。

import { describe, expect, it } from 'vitest';

import {
  readChunked,
  readDelayFactor,
  readMaxChunks,
  validDelayFactorDraft,
  validMaxChunksDraft,
} from '@/client/settings/chunked/logic';

describe('chunked logic · host snapshot', () => {
  it('reads the toggle with a false default', () => {
    expect(readChunked({ value: { chunkedReplies: true } })).toBe(true);
    expect(readChunked({ value: { chunkedReplies: 'yes' } })).toBe(false);
    expect(readChunked({})).toBe(false);
  });

  it('reads maxChunks with fallback 8 for anything invalid', () => {
    expect(readMaxChunks({ value: { maxChunks: 5 } })).toBe(5);
    expect(readMaxChunks({ value: { maxChunks: 'x' } })).toBe(8);
    expect(readMaxChunks({})).toBe(8);
  });

  it('reads delayFactor with fallback 1 for anything invalid', () => {
    expect(readDelayFactor({ value: { delayFactor: 0 } })).toBe(0);
    expect(readDelayFactor({ value: { delayFactor: null } })).toBe(1);
    expect(readDelayFactor({})).toBe(1);
  });
});

describe('chunked logic · drafts', () => {
  it('validates maxChunks as an integer within 1..50', () => {
    for (const bad of ['abc', '0', '51', '1.5', '']) expect(validMaxChunksDraft(bad)).toBe(false);
    for (const good of ['1', '8', '50', ' 12 ']) expect(validMaxChunksDraft(good)).toBe(true);
  });

  it('validates delayFactor as a number within 0..5 (0 = no delay)', () => {
    for (const bad of ['abc', '-0.1', '5.1', '']) expect(validDelayFactorDraft(bad)).toBe(false);
    for (const good of ['0', '1', '2.5', '5', ' 0.3 '])
      expect(validDelayFactorDraft(good)).toBe(true);
  });
});
