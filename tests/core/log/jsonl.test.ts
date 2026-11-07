import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeFileSink, makeLogger, type LogSink } from '@/core/log/jsonl';

function memorySink(): { lines: string[]; sink: LogSink } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

describe('makeLogger · output format', () => {
  it('writes a single parseable JSON line with ts/level/event', () => {
    const { lines, sink } = memorySink();
    const log = makeLogger({ sink, now: () => 1730000000000 });
    log.info('poll.batch', { count: 3 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      ts: 1730000000000,
      level: 'info',
      event: 'poll.batch',
      count: 3,
    });
  });

  it('spreads fields flat into the entry', () => {
    const { lines, sink } = memorySink();
    makeLogger({ sink }).warn('gate.denied', { key: '+8613800000000', reason: 'not-allowlisted' });
    const entry = JSON.parse(lines[0]!);
    expect(entry.key).toBe('+8613800000000');
    expect(entry.reason).toBe('not-allowlisted');
  });

  it('supports all four levels', () => {
    const { lines, sink } = memorySink();
    const log = makeLogger({ sink, minLevel: 'debug' });
    log.debug('a'); log.info('b'); log.warn('c'); log.error('d');
    expect(lines.map((l) => JSON.parse(l).level)).toEqual(['debug', 'info', 'warn', 'error']);
  });
});

describe('makeLogger · level filtering', () => {
  it('drops entries below minLevel (default info)', () => {
    const { lines, sink } = memorySink();
    const log = makeLogger({ sink });
    log.debug('quiet');
    log.info('kept');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).event).toBe('kept');
  });
});

describe('makeLogger · never throws', () => {
  it('degrades on unserializable fields instead of throwing', () => {
    const { lines, sink } = memorySink();
    const log = makeLogger({ sink });
    log.info('poll.batch', { bad: BigInt(1) });
    const entry = JSON.parse(lines[0]!);
    expect(entry.event).toBe('log.serialize-failed');
    expect(entry.rawEvent).toBe('poll.batch');
  });

  it('swallows sink failures', () => {
    const log = makeLogger({
      sink: () => {
        throw new Error('disk full');
      },
    });
    expect(() => log.error('x')).not.toThrow();
  });

  it('still rejects empty event names (programmer error)', () => {
    const log = makeLogger({ sink: () => {} });
    expect(() => log.info('')).toThrow(TypeError);
  });
});

describe('makeFileSink · daily rotation', () => {
  const day = (ymd: string) => () => new Date(`${ymd}T12:00:00`);

  it('writes into a date-stamped file and auto-creates the directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-imessage-log-'));
    try {
      const sink = makeFileSink(join(dir, 'nested', 'logs'), { now: day('2026-11-06') });
      sink('{"a":1}');
      sink('{"a":2}');
      const text = readFileSync(join(dir, 'nested', 'logs', 'imessage-20261106.jsonl'), 'utf8');
      expect(text.split('\n').filter(Boolean)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('switches to a new file when the day changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-imessage-log-'));
    try {
      let now = day('2026-11-06')();
      const sink = makeFileSink(dir, { now: () => now });
      sink('{"day":1}');
      now = day('2026-11-07')();
      sink('{"day":2}');
      expect(existsSync(join(dir, 'imessage-20261106.jsonl'))).toBe(true);
      expect(existsSync(join(dir, 'imessage-20261107.jsonl'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lazily removes logs older than the retention window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-imessage-log-'));
    try {
      // 预置：10 天前（应删）、6 天前（应留）、无关文件（不动）
      writeFileSync(join(dir, 'imessage-20261027.jsonl'), '', 'utf8');
      writeFileSync(join(dir, 'imessage-20261031.jsonl'), '', 'utf8');
      writeFileSync(join(dir, 'unrelated.txt'), '', 'utf8');
      const sink = makeFileSink(dir, { now: day('2026-11-06'), keepDays: 7 });
      sink('{"x":1}');
      const names = readdirSync(dir).sort();
      expect(names).toEqual(['imessage-20261031.jsonl', 'imessage-20261106.jsonl', 'unrelated.txt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
