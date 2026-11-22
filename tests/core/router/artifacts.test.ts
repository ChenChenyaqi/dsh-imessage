// ArtifactCollector 规格（M6.2 Step B）：每轮 ask 开/收、防跨轮泄漏。

import { describe, expect, it } from 'vitest';

import { makeArtifactCollector } from '@/core/router/artifacts';

describe('makeArtifactCollector', () => {
  it('push preserves order; take drains and clears the key', () => {
    const c = makeArtifactCollector();
    c.open('s1');
    c.push('s1', { bytes: new Uint8Array([1]), fileName: 'a.png' });
    c.push('s1', { bytes: new Uint8Array([2]), fileName: 'b.png' });
    const taken = c.take('s1');
    expect(taken.map((a) => a.fileName)).toEqual(['a.png', 'b.png']);
    expect(c.take('s1')).toEqual([]); // 取走即清
  });

  it('open clears stale artifacts from an interrupted turn (no cross-turn leak)', () => {
    const c = makeArtifactCollector();
    c.open('s1');
    c.push('s1', { bytes: new Uint8Array([1]), fileName: 'stale.png' });
    // 上轮 ask 抛错 → 残留未取走；下一轮 open 清空
    c.open('s1');
    c.push('s1', { bytes: new Uint8Array([2]), fileName: 'fresh.png' });
    expect(c.take('s1').map((a) => a.fileName)).toEqual(['fresh.png']);
  });

  it('takes pushes that happened before open (tool may run before pipeline opens the turn)', () => {
    const c = makeArtifactCollector();
    c.push('s1', { bytes: new Uint8Array([3]), fileName: 'c.pdf' });
    expect(c.take('s1').map((a) => a.fileName)).toEqual(['c.pdf']);
  });

  it('keeps sessions isolated from each other', () => {
    const c = makeArtifactCollector();
    c.open('s1');
    c.open('s2');
    c.push('s1', { bytes: new Uint8Array([1]), fileName: 'only-s1.png' });
    expect(c.take('s2')).toEqual([]);
    expect(c.take('s1')).toHaveLength(1);
  });
});
