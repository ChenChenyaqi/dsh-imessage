// 发布脚本的契约测试（scripts/lib/release.mjs）。
//
// 这两个脚本站在「不可撤销」的动作前面：npm 一旦发出去，24 小时后
// 连 unpublish 都不行，只能发新版覆盖。所以边界要钉死，尤其是
// tag 与 package.json 版本不一致、以及 CHANGELOG 里忘了写对应段落
// 这两种「发出去才发现」的事故。

import { describe, expect, it } from 'vitest';

import {
  assertVersionConsistency,
  extractChangelogSection,
  parseTagVersion,
} from '../../scripts/lib/release.mjs';

describe('parseTagVersion', () => {
  it('strips the v prefix', () => {
    expect(parseTagVersion('v0.2.0')).toBe('0.2.0');
  });

  it('accepts a bare version', () => {
    expect(parseTagVersion('0.2.0')).toBe('0.2.0');
  });

  it('keeps prerelease tags', () => {
    expect(parseTagVersion('v0.2.0-beta.1')).toBe('0.2.0-beta.1');
  });

  it('keeps build metadata', () => {
    expect(parseTagVersion('v0.2.0+build.7')).toBe('0.2.0+build.7');
  });

  it.each(['v1.2', 'release-1.2.3', '', 'v', 'vabc', '1.2.3.4'])(
    'rejects invalid tag %j',
    (tag) => {
      expect(() => parseTagVersion(tag)).toThrow(/tag/i);
    },
  );
});

describe('assertVersionConsistency', () => {
  it('passes when all three match', () => {
    expect(() =>
      assertVersionConsistency({
        tag: 'v0.2.0',
        rootVersion: '0.2.0',
        presetVersion: '0.2.0',
      }),
    ).not.toThrow();
  });

  it('accepts a bare version tag', () => {
    expect(() =>
      assertVersionConsistency({
        tag: '0.2.0',
        rootVersion: '0.2.0',
        presetVersion: '0.2.0',
      }),
    ).not.toThrow();
  });

  it('throws when the tag and package version differ, naming both', () => {
    let message = '';
    try {
      assertVersionConsistency({
        tag: 'v0.2.0',
        rootVersion: '0.1.0',
        presetVersion: '0.1.0',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('0.2.0');
    expect(message).toContain('0.1.0');
  });

  it('throws when preset version differs from root', () => {
    let message = '';
    try {
      assertVersionConsistency({
        tag: 'v0.2.0',
        rootVersion: '0.2.0',
        presetVersion: '0.1.0',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('preset');
    expect(message).toContain('0.1.0');
  });

  it('rejects an invalid tag', () => {
    expect(() =>
      assertVersionConsistency({
        tag: 'latest',
        rootVersion: '0.2.0',
        presetVersion: '0.2.0',
      }),
    ).toThrow(/tag/i);
  });
});

/** 与仓库 CHANGELOG.md 同构的最小样本。 */
const CHANGELOG = `# Changelog

## [Unreleased]

## [0.2.0] - 2026-11-20

### Added

- 分段回复支持自定义延时
- 收图（HEIC → JPEG）

### Fixed

- 修复重启后重复回复

## [0.1.0] - 2026-11-14

首个公开版本。

### Added

- 收发内核
`;

describe('extractChangelogSection', () => {
  it('returns the body without the heading line', () => {
    const section = extractChangelogSection(CHANGELOG, '0.2.0');
    expect(section).toContain('### Added');
    expect(section).toContain('分段回复支持自定义延时');
    expect(section).not.toContain('## [0.2.0]');
  });

  it('does not swallow the next section', () => {
    const section = extractChangelogSection(CHANGELOG, '0.2.0');
    expect(section).not.toContain('收发内核');
    expect(section).not.toContain('[0.1.0]');
  });

  it('reads the last section at end of file', () => {
    const section = extractChangelogSection(CHANGELOG, '0.1.0');
    expect(section).toContain('收发内核');
  });

  it('trims surrounding whitespace', () => {
    const section = extractChangelogSection(CHANGELOG, '0.2.0');
    expect(section).toBe(section.trim());
  });

  it('accepts a heading without a date', () => {
    const withoutDate = '## [0.2.0]\n\n- 只有一行\n';
    expect(extractChangelogSection(withoutDate, '0.2.0')).toBe('- 只有一行');
  });

  // 这几条是真实事故来源：版本号是前缀关系时，朴素的 includes/regex
  // 会把 [0.10.0] 当成 [0.1.0]、把预发布当成正式版。
  it('does not match [0.10.0] for 0.1.0', () => {
    const text = '## [0.10.0]\n\n- 新版内容\n';
    expect(() => extractChangelogSection(text, '0.1.0')).toThrow(/0\.1\.0/);
  });

  it('does not match a prerelease for 0.1.0', () => {
    const text = '## [0.1.0-beta.1]\n\n- 预发布内容\n';
    expect(() => extractChangelogSection(text, '0.1.0')).toThrow(/0\.1\.0/);
  });

  it('throws when the section is missing', () => {
    expect(() => extractChangelogSection(CHANGELOG, '0.3.0')).toThrow(/0\.3\.0/);
    expect(() => extractChangelogSection(CHANGELOG, '0.3.0')).toThrow(/CHANGELOG/);
  });

  it('throws when the section is empty', () => {
    const empty = '## [0.2.0] - 2026-11-20\n\n## [0.1.0] - 2026-11-14\n\n- 旧内容\n';
    expect(() => extractChangelogSection(empty, '0.2.0')).toThrow(/empty|0\.2\.0/i);
  });

  it('rejects the unreleased section', () => {
    expect(() => extractChangelogSection(CHANGELOG, 'unreleased')).toThrow();
  });
});
