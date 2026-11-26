// contacts 域纯函数（行集 / 清洗 / dirty / 保存载荷）。

import { describe, expect, it } from 'vitest';

import {
  contactsDraftView,
  contactsSavePayload,
  peerRows,
  sameNames,
  sanitizePeerNames,
} from '@/client/settings/contacts/logic';

const BASE = { '+8613800000000': '小陈' };

describe('peerRows', () => {
  it('unions normalized allowlist keys with baseline keys, ascending', () => {
    expect(peerRows(['+86 139 0000 0000', '+8613800000000'], BASE)).toEqual([
      '+8613800000000',
      '+8613900000000',
    ]);
  });

  it('drops unparseable allowlist entries (they appear after saving)', () => {
    expect(peerRows(['not-a-phone'], BASE)).toEqual(['+8613800000000']);
  });

  it('baseline-only keys survive (hand-edited file entries are not lost)', () => {
    expect(peerRows([], { ...BASE, '+8613900000000': '阿九' })).toEqual([
      '+8613800000000',
      '+8613900000000',
    ]);
  });
});

describe('sanitizePeerNames', () => {
  it('trims values and drops empty ones (empty input = clear)', () => {
    expect(sanitizePeerNames({ a: '  x ', b: '   ' })).toEqual({ a: 'x' });
  });

  it('caps the value at 64 chars (same budget as the core store)', () => {
    expect(sanitizePeerNames({ a: 'x'.repeat(80) }).a).toHaveLength(64);
  });
});

describe('sameNames', () => {
  it('compares key-value pairs deeply', () => {
    expect(sameNames({ a: '1' }, { a: '1' })).toBe(true);
    expect(sameNames({ a: '1' }, { a: '2' })).toBe(false);
    expect(sameNames({ a: '1' }, { a: '1', b: '' })).toBe(false);
  });
});

describe('contactsDraftView', () => {
  it('follows the baseline when unedited', () => {
    const view = contactsDraftView(undefined, BASE, ['+8613800000000']);
    expect(view.names).toEqual(BASE);
    expect(view.dirty).toBe(false);
    expect(view.rows).toEqual([{ handle: '+8613800000000', value: '小陈' }]);
  });

  it('marks dirty on an edited value and on a new row', () => {
    const edited = contactsDraftView({ '+8613800000000': '陈工' }, BASE, ['+8613800000000']);
    expect(edited.dirty).toBe(true);
    const added = contactsDraftView({ '+8613900000000': '阿九' }, BASE, [
      '+8613800000000',
      '+8613900000000',
    ]);
    expect(added.dirty).toBe(true);
  });

  it('clearing a name is dirty (sanitize drops it, baseline keeps it)', () => {
    const view = contactsDraftView({ '+8613800000000': ' ' }, BASE, ['+8613800000000']);
    expect(view.names).toEqual({});
    expect(view.dirty).toBe(true);
  });

  it('an empty draft equal to an empty baseline is clean', () => {
    const view = contactsDraftView({ a: ' ' }, {}, ['+8613800000000']);
    expect(view.dirty).toBe(false);
    // 行仍出现（白名单号码），输入框为空
    expect(view.rows).toEqual([{ handle: '+8613800000000', value: '' }]);
  });
});

describe('contactsSavePayload', () => {
  it('merges override over baseline and sanitizes', () => {
    const payload = contactsSavePayload(
      { '+8613800000000': '  陈工 ', '+8613900000000': ' ' },
      BASE,
    );
    expect(payload).toEqual({ '+8613800000000': '陈工' });
  });

  it('falls back to baseline sanitize when unedited', () => {
    expect(contactsSavePayload(undefined, BASE)).toEqual(BASE);
  });

  it('works with no baseline at all (fresh card)', () => {
    expect(contactsSavePayload({ '+8613800000000': '小陈' }, {})).toEqual({
      '+8613800000000': '小陈',
    });
    expect(contactsSavePayload(undefined, {})).toEqual({});
  });
});
