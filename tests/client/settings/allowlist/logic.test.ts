// 白名单域纯函数规格（从 card.test 的 allowlist entries 段迁移；测试先行）。
//
// 对齐 core 的事实：条目原样保存（宿主 config 是 string[]，归一化交给
// core 的 makePolicy），这里只做空白清洗，不做手机号格式化。

import { describe, expect, it } from 'vitest';

import {
  formatAllowlist,
  parseAllowlist,
  readAllowlist,
  validateAdd,
} from '@/client/settings/allowlist/logic';

const PHONE = '+8613800000000';
const PHONE_2 = '+8613900000000';

describe('allowlist logic · entries', () => {
  it('parses saved values into entries for chip rendering', () => {
    const entries = parseAllowlist([` ${PHONE} `, PHONE_2]);

    expect(entries.map((entry) => entry.raw)).toEqual([PHONE, PHONE_2]);
    expect(entries.every((entry) => entry.key !== null)).toBe(true);
  });

  it('marks unparseable entries instead of dropping them', () => {
    // 手改配置文件塞进非法条目：保留并标注，让界面标红可删，而不是静默丢
    const entries = parseAllowlist(['123']);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.key).toBeNull();
  });

  it('formats saved values back into the host shape', () => {
    expect(formatAllowlist([` ${PHONE} `, '', PHONE_2])).toEqual([PHONE, PHONE_2]);
  });
});

describe('allowlist logic · add validation', () => {
  it('treats an empty draft as not started (no error)', () => {
    expect(validateAdd('', [])).toBeNull();
    expect(validateAdd('   ', [])).toBeNull();
  });

  it('reports invalid and duplicate machine codes', () => {
    expect(validateAdd('not-a-number', [])).toBe('invalid');
    expect(validateAdd(PHONE, [{ raw: PHONE, key: PHONE }])).toBe('duplicate');
    expect(validateAdd(PHONE_2, [{ raw: PHONE, key: PHONE }])).toBeNull();
  });
});

describe('allowlist logic · host snapshot', () => {
  it('reads a string allowlist and ignores anything else', () => {
    expect(readAllowlist({ value: { allowlist: [PHONE] } })).toEqual([PHONE]);
    expect(readAllowlist({ value: { allowlist: 'nope' } })).toEqual([]);
    expect(readAllowlist({})).toEqual([]);
  });
});
