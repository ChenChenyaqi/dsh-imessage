import { describe, expect, it } from 'vitest';

import { evaluateAccess, makePolicy } from '@/core/types/policy';

describe('makePolicy', () => {
  it('normalizes allowlist entries', () => {
    const policy = makePolicy(['+8613800000000', '+86 139 0000 0000', 'Alice@iCloud.com']);
    expect(policy.allowlist).toEqual(['+8613800000000', '+8613900000000', 'alice@icloud.com']);
  });

  it('silently drops invalid entries (file-edited config degrades to deny)', () => {
    const policy = makePolicy(['+8613800000000', '13800000000', '###', 'a@b@c']);
    expect(policy.allowlist).toEqual(['+8613800000000']);
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(makePolicy([]))).toBe(true);
  });
});

describe('evaluateAccess · deny by default', () => {
  it('empty allowlist denies everything', () => {
    expect(evaluateAccess(makePolicy([]), '+8613800000000')).toEqual({
      allow: false,
      reason: 'not-allowlisted',
    });
  });
});

describe('evaluateAccess · matching', () => {
  const policy = makePolicy(['+8613800000000', 'alice@icloud.com']);

  it('allows a listed key regardless of symbol spelling', () => {
    expect(evaluateAccess(policy, '+8613800000000').allow).toBe(true);
    expect(evaluateAccess(policy, '+86 138-0000-0000')).toEqual({
      allow: true,
      reason: 'allowlisted',
    });
  });

  it('matches emails case-insensitively', () => {
    expect(evaluateAccess(policy, 'Alice@iCloud.com').allow).toBe(true);
  });

  it('denies keys not in the list', () => {
    expect(evaluateAccess(policy, '+8613700000000')).toEqual({
      allow: false,
      reason: 'not-allowlisted',
    });
  });

  it('denies spam-length forged numbers', () => {
    expect(evaluateAccess(policy, '+20123456789012345678')).toEqual({
      allow: false,
      reason: 'unparseable-key',
    });
  });
});

describe('evaluateAccess · robustness', () => {
  it('returns explicit verdict for unparseable keys', () => {
    expect(evaluateAccess(makePolicy(['+8613800000000']), '???')).toEqual({
      allow: false,
      reason: 'unparseable-key',
    });
  });
});
