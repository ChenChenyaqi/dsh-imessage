import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AUTOMATION_PROBE_SOURCE,
  defaultChatDbPath,
  nodeProbeDeps,
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

// ---------------------------------------------------------------------------
// node 默认实现：真实临时文件验证（runAppleScript 留白，见 describe 内注释）
// ---------------------------------------------------------------------------

describe('node defaults', () => {
  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'env-probe-'));
    file = join(dir, 'head.bin');
    writeFileSync(file, 'x'); // 1 字节即可供 readFileHead 读取
  });

  afterAll(() => {
    // 清理临时目录
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaultChatDbPath points at the macOS chat.db location', () => {
    // 默认路径必须落在用户主目录的消息库位置
    expect(defaultChatDbPath()).toContain('Library/Messages/chat.db');
  });

  it('statFile detects an existing file and a missing path', () => {
    expect(nodeProbeDeps.statFile(file)).toBe(true);
    expect(nodeProbeDeps.statFile(join(dir, 'missing.db'))).toBe(false);
  });

  it('readFileHead reads one byte without throwing', () => {
    // 真实打开/读/关闭 fd，验证默认实现不抛错
    expect(() => nodeProbeDeps.readFileHead(file)).not.toThrow();
  });

  // 留白说明：nodeProbeDeps.runAppleScript 不在本 describe 测试——默认实现
  // 会真实调用 osascript（触发 TCC 授权弹窗，且仅 macOS 可用），不适合单测；
  // automation 分支已由上方 fake runAppleScript 用例覆盖。
});
