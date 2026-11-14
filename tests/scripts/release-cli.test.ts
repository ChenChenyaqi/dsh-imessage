// 发布 CLI 薄壳的集成测试：真跑进程，验证退出码与输出。
//
// 薄壳本身没逻辑，但它是 workflow 里唯一会失败的地方——退出码错了
// 就等于没拦住。测试用临时目录造 package.json / CHANGELOG，不依赖
// 仓库当前版本号（版本一变测试就红是更差的失败方式）。

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CHECK_CLI = join(ROOT, 'scripts/check-release-versions.mjs');
const NOTES_CLI = join(ROOT, 'scripts/release-notes.mjs');

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** 造一个最小的项目骨架，返回其根目录。 */
function fixture({ rootVersion = '0.2.0', presetVersion = '0.2.0', changelog }: {
  rootVersion?: string;
  presetVersion?: string;
  changelog?: string;
} = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-release-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root-pkg', version: rootVersion }));
  mkdirSync(join(dir, 'preset'), { recursive: true });
  writeFileSync(
    join(dir, 'preset/package.json'),
    JSON.stringify({ name: 'preset-pkg', version: presetVersion }),
  );
  if (changelog !== undefined) writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
  return dir;
}

/** 跑 CLI，返回退出码与输出（不抛异常）。 */
function run(
  script: string,
  args: string[],
): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [script, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

describe('check-release-versions CLI', () => {
  it('exits 0 and prints the version', () => {
    const dir = fixture();
    const result = run(CHECK_CLI, ['v0.2.0', '--root', dir]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('0.2.0');
  });

  it('exits 1 with a GitHub Actions error annotation', () => {
    const dir = fixture({ rootVersion: '0.1.0', presetVersion: '0.1.0' });
    const result = run(CHECK_CLI, ['v0.2.0', '--root', dir]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('::error::');
    expect(result.stderr).toContain('0.2.0');
  });

  it('exits 1 when preset version lags', () => {
    const dir = fixture({ presetVersion: '0.1.0' });
    const result = run(CHECK_CLI, ['v0.2.0', '--root', dir]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('preset');
  });

  it('exits 1 and prints usage without a tag', () => {
    const dir = fixture();
    const result = run(CHECK_CLI, ['--root', dir]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/usage/i);
  });
});

const CHANGELOG = `# Changelog

## [Unreleased]

## [0.2.0] - 2026-11-20

### Added

- 收图

## [0.1.0] - 2026-11-14

- 内核
`;

describe('release-notes CLI', () => {
  it('prints the version body to stdout', () => {
    const dir = fixture({ changelog: CHANGELOG });
    const result = run(NOTES_CLI, ['0.2.0', '--root', dir]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('### Added');
    expect(result.stdout).toContain('收图');
    expect(result.stdout).not.toContain('内核');
  });

  it('writes to a file with --out and stays quiet', () => {
    const dir = fixture({ changelog: CHANGELOG });
    const outFile = join(dir, 'notes.md');
    const result = run(NOTES_CLI, ['0.2.0', '--root', dir, '--out', outFile]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(readFileSync(outFile, 'utf8')).toContain('收图');
  });

  it('exits 1 when the changelog section is missing', () => {
    const dir = fixture({ changelog: CHANGELOG });
    const result = run(NOTES_CLI, ['0.9.0', '--root', dir]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('CHANGELOG');
    expect(result.stderr).toContain('0.9.0');
  });

  it('exits 1 and prints usage without a version', () => {
    const dir = fixture({ changelog: CHANGELOG });
    const result = run(NOTES_CLI, ['--root', dir]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/usage/i);
  });
});
