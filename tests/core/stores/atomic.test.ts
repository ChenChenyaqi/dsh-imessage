import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { JsonCorruptError, readJson, writeJsonAtomic } from '@/core/stores/atomic';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-imessage-atomic-'));
}

describe('writeJsonAtomic', () => {
  it('round-trips a value through write then read', () => {
    const dir = tempDir();
    try {
      const file = join(dir, 'state.json');
      writeJsonAtomic(file, { cursor: 42, names: ['a', 'b'] });
      expect(readJson(file)).toEqual({ cursor: 42, names: ['a', 'b'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves no tmp files behind after success', () => {
    const dir = tempDir();
    try {
      const file = join(dir, 'state.json');
      writeJsonAtomic(file, { a: 1 });
      writeJsonAtomic(file, { a: 2 });
      const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'));
      expect(leftovers).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates nested directories on demand', () => {
    const dir = tempDir();
    try {
      const file = join(dir, 'logs', 'deep', 'state.json');
      writeJsonAtomic(file, { ok: true });
      expect(readJson(file)).toEqual({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('overwrites previous content with the newest value', () => {
    const dir = tempDir();
    try {
      const file = join(dir, 'state.json');
      writeJsonAtomic(file, { version: 1 });
      writeJsonAtomic(file, { version: 2 });
      expect(readJson<{ version: number }>(file)?.version).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readJson', () => {
  it('returns undefined when the file does not exist', () => {
    const dir = tempDir();
    try {
      expect(readJson(join(dir, 'nope.json'))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws JsonCorruptError on unparsable content', () => {
    const dir = tempDir();
    try {
      const file = join(dir, 'broken.json');
      writeFileSync(file, '{ this is not json', 'utf8');
      expect(() => readJson(file)).toThrow(JsonCorruptError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
