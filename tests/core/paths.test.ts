import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DATA_ROOT_ENV, resolvePaths } from '@/core/paths';

describe('resolvePaths', () => {
  it('defaults to ~/.dsh-imessage when the env var is absent', () => {
    expect(resolvePaths({}).root).toBe(join(homedir(), '.dsh-imessage'));
    expect(resolvePaths(undefined).root).toBe(join(homedir(), '.dsh-imessage'));
  });

  it('falls back to the default on blank override values', () => {
    expect(resolvePaths({ [DATA_ROOT_ENV]: '' }).root).toBe(join(homedir(), '.dsh-imessage'));
    expect(resolvePaths({ [DATA_ROOT_ENV]: '   ' }).root).toBe(join(homedir(), '.dsh-imessage'));
  });

  it('honors an absolute override as-is', () => {
    const { root } = resolvePaths({ [DATA_ROOT_ENV]: '/tmp/dsh-imessage-test' });
    expect(root).toBe('/tmp/dsh-imessage-test');
  });

  it('expands a ~/ prefix to the home directory', () => {
    const { root } = resolvePaths({ [DATA_ROOT_ENV]: '~/elsewhere' });
    expect(root).toBe(join(homedir(), 'elsewhere'));
  });

  it('resolves a relative override against the cwd', () => {
    const { root } = resolvePaths({ [DATA_ROOT_ENV]: 'relative/root' });
    expect(root).toBe(resolve(process.cwd(), 'relative/root'));
  });

  it('lays out every well-known path under the root', () => {
    const p = resolvePaths({ [DATA_ROOT_ENV]: '/tmp/dsh-imessage-test' });
    expect(p.stateFile).toBe(join(p.root, 'state.json'));
    expect(p.logDir).toBe(join(p.root, 'logs'));
    expect(p.conversationsDir).toBe(join(p.root, 'conversations'));
  });

  it('is a pure function: does not mutate the given env', () => {
    const env: Record<string, string> = {};
    resolvePaths(env);
    expect(env).toEqual({});
  });
});
