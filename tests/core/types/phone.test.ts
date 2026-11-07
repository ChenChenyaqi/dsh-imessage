import { describe, expect, it } from 'vitest';

import { normalizePhone } from '@/core/types/phone';

describe('normalizePhone · email handles', () => {
  it('lowercases Apple ID emails', () => {
    expect(normalizePhone('Alice@iCloud.com')).toBe('alice@icloud.com');
  });

  it('rejects malformed emails', () => {
    expect(normalizePhone('a@b@c')).toBeNull();
    expect(normalizePhone('@nope')).toBeNull();
  });
});

describe('normalizePhone · international form (+)', () => {
  it('keeps + prefix and strips symbols', () => {
    expect(normalizePhone('+1 (555) 123-4567')).toBe('+15551234567');
    expect(normalizePhone('+81 90 1234 5678')).toBe('+819012345678');
    expect(normalizePhone('+86 138-0000-0000')).toBe('+8613800000000');
  });

  it('enforces the E.164 digit range 7..15', () => {
    expect(normalizePhone('+123456')).toBeNull(); // 6 位，过短
    expect(normalizePhone('+1234567890123456')).toBeNull(); // 16 位，超 E.164 上限
    expect(normalizePhone('+67712345')).toBe('+67712345'); // 所罗门群岛 8 位，最短合法
  });

  it('rejects spam-length forged numbers', () => {
    // chat.db 实测存在的超长垃圾伪造号形态
    expect(normalizePhone('+20123456789012345678')).toBeNull();
  });
});

describe('normalizePhone · bare digits are never guessed', () => {
  it('returns null for numbers without a + prefix', () => {
    expect(normalizePhone('13800000000')).toBeNull();
    expect(normalizePhone('5551234567')).toBeNull();
    expect(normalizePhone('8613800000000')).toBeNull();
  });
});

describe('normalizePhone · invalid input', () => {
  it('returns null for empty or blank input', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('   ')).toBeNull();
  });

  it('returns null when no digits remain', () => {
    expect(normalizePhone('---')).toBeNull();
    expect(normalizePhone('(+)**')).toBeNull();
  });
});
