import { describe, expect, it } from 'vitest';

import {
  AUTOMATION_PROBE_SOURCE,
  probeEnvironment,
  type ProbeDeps,
} from '@/core/imessage/env';

function fakeDeps(over: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    statFile: () => true,
    readFileHead: () => {},
    runAppleScript: () => {},
    ...over,
  };
}

describe('probeEnvironment · all good', () => {
  it('reports both permissions ok', () => {
    const probe = probeEnvironment('/x/chat.db', fakeDeps());
    expect(probe.disk).toEqual({ ok: true });
    expect(probe.automation).toEqual({ ok: true });
    expect(probe.chatDbPath).toBe('/x/chat.db');
  });

  it('runs the non-destructive automation probe source', () => {
    // 探测命令不能有副作用（不发送、不建会话）：钉住命令内容
    expect(AUTOMATION_PROBE_SOURCE).toBe('tell application "Messages" to get name');
  });
});

describe('probeEnvironment · disk failures', () => {
  it('reports missing chat.db as disk failure, automation still probed', () => {
    const probe = probeEnvironment('/nope/chat.db', fakeDeps({ statFile: () => false }));
    expect(probe.disk.ok).toBe(false);
    expect(probe.disk.detail).toContain('not found');
    expect(probe.disk.detail).toContain('/nope/chat.db');
    expect(probe.automation.ok).toBe(true);
  });

  it('reports unreadable chat.db (FDA denied) with the original error', () => {
    const probe = probeEnvironment(
      '/x/chat.db',
      fakeDeps({
        readFileHead: () => {
          throw new Error('EACCES: operation not permitted');
        },
      }),
    );
    expect(probe.disk.ok).toBe(false);
    expect(probe.disk.detail).toContain('operation not permitted');
  });
});

describe('probeEnvironment · automation failures', () => {
  it('reports automation denial independently of disk state', () => {
    const probe = probeEnvironment(
      '/x/chat.db',
      fakeDeps({
        runAppleScript: () => {
          throw new Error('osascript: not authorized');
        },
      }),
    );
    expect(probe.automation.ok).toBe(false);
    expect(probe.automation.detail).toContain('not authorized');
    expect(probe.disk.ok).toBe(true);
  });
});

describe('probeEnvironment · probe isolation', () => {
  it('probes automation even when disk failed (no short-circuit)', () => {
    const probe = probeEnvironment(
      '/nope/chat.db',
      fakeDeps({
        statFile: () => false,
        runAppleScript: () => {
          throw new Error('denied');
        },
      }),
    );
    expect(probe.disk.ok).toBe(false);
    expect(probe.automation.ok).toBe(false);
  });
});
