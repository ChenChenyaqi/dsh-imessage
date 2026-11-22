// 外发暂存与清扫的规格测试（M6.2 Step A，probes ③ 终态纪律）。
//
// 纪律核心（dsh-im 两次修复换来的事实，行为照抄）：
// - 暂存文件比 send 调用活得久（daemon 异步摄取，删早了 = 静默丢失）
// - 只在 tmpdir（/var/folders）——daemon 不读 home 路径
// - 清扫无定时器：下次发送时顺带；失败 cosmetic 永不抛
// - 前缀 dsh-imessage-out- 与 dsh-im 的 dsh-im-out- 互不误清扫
//
// 测试全内存 FS fake（core 零真 IO）。

import { describe, expect, it } from 'vitest';

import {
  OUTBOUND_PREFIX,
  OUTBOUND_RETENTION_MS,
  safeOutboundName,
  stageOutboundFile,
  sweepStaleOutbound,
  type OutboundDeps,
} from '@/core/imessage/outbound';

// ---------------------------------------------------------------------------
// 内存 FS fake
// ---------------------------------------------------------------------------

interface FileEntry {
  data: Uint8Array;
  mode: number;
  mtimeMs: number;
}

interface FakeFs {
  files: Map<string, FileEntry>;
  skips: Array<{ name: string; error: string }>;
  /** 注入：下一次 stat(path) 抛错（单文件清扫失败路径）。 */
  failStatOf?: string;
  deps: OutboundDeps;
  /** 直塞一个文件（清扫用例预置）。 */
  put(path: string, mtimeMs: number): void;
}

function makeFakeFs(nowMs = 1_000_000): FakeFs {
  const files = new Map<string, FileEntry>();
  const skips: FakeFs['skips'] = [];
  const fake: FakeFs = {
    files,
    skips,
    deps: {
      tmpdir: () => '/var/folders/t',
      writeFile: async (path, data, mode) => {
        files.set(path, { data, mode, mtimeMs: nowMs });
      },
      readdir: async () => [...files.keys()].map((p) => p.split('/').pop()!),
      stat: async (path) => {
        if (path === fake.failStatOf) throw new Error('stat i/o error');
        const entry = files.get(path);
        if (!entry) throw new Error('ENOENT');
        return { mtimeMs: entry.mtimeMs };
      },
      rm: async (path) => {
        files.delete(path);
      },
      onSweepSkip: (info) => skips.push(info),
    },
    put(path, mtimeMs) {
      files.set(path, { data: new Uint8Array(1), mode: 0o600, mtimeMs });
    },
  };
  return fake;
}

// ---------------------------------------------------------------------------
// 展示名安全化
// ---------------------------------------------------------------------------

describe('safeOutboundName', () => {
  it('keeps a plain file name as-is', () => {
    expect(safeOutboundName('report.pdf')).toBe('report.pdf');
  });

  it('reduces path-like input to its basename (no separators into tmpdir)', () => {
    expect(safeOutboundName('/etc/passwd')).toBe('passwd');
    expect(safeOutboundName('../../secrets.txt')).toBe('secrets.txt');
    expect(safeOutboundName('a\\b\\c.png')).toBe('c.png');
  });

  it('falls back to "file" for empty or separator-only names', () => {
    expect(safeOutboundName('')).toBe('file');
    expect(safeOutboundName('/')).toBe('file');
  });
});

// ---------------------------------------------------------------------------
// 暂存
// ---------------------------------------------------------------------------

describe('stageOutboundFile', () => {
  it('writes bytes under the owned prefix with mode 0600', async () => {
    const fs = makeFakeFs();
    const staged = await stageOutboundFile(new Uint8Array([1, 2, 3]), 'photo.png', fs.deps, {
      pid: 4242,
      now: () => 1_730_000_000_000,
    });
    expect(staged.bytes).toBe(3);
    expect(staged.path).toBe(`/var/folders/t/${OUTBOUND_PREFIX}4242-1730000000000-photo.png`);
    const entry = fs.files.get(staged.path)!;
    expect(entry.mode).toBe(0o600);
    expect([...entry.data]).toEqual([1, 2, 3]);
  });

  it('sanitizes path-like display names into the staged file name', async () => {
    const fs = makeFakeFs();
    const staged = await stageOutboundFile(new Uint8Array([9]), '/abs/evil.png', fs.deps, {
      pid: 1,
      now: () => 5,
    });
    expect(staged.path.endsWith(`${OUTBOUND_PREFIX}1-5-evil.png`)).toBe(true);
  });

  it('rejects empty bytes before touching the fs', async () => {
    const fs = makeFakeFs();
    await expect(stageOutboundFile(new Uint8Array(0), 'a.png', fs.deps)).rejects.toThrow(TypeError);
    expect(fs.files.size).toBe(0);
  });

  it('defaults pid/now to the process values when omitted', async () => {
    const fs = makeFakeFs();
    // 不传 options：pid/now 走 process.pid / Date.now 默认分支
    const staged = await stageOutboundFile(new Uint8Array([1]), 'd.png', fs.deps);
    expect(staged.path.startsWith(`/var/folders/t/${OUTBOUND_PREFIX}`)).toBe(true);
    expect(staged.path.endsWith('-d.png')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 清扫
// ---------------------------------------------------------------------------

describe('sweepStaleOutbound', () => {
  const HOUR = OUTBOUND_RETENTION_MS;

  it('deletes only own-prefixed files older than the retention window', async () => {
    const now = 10 * HOUR;
    const fs = makeFakeFs(now);
    fs.put(`/var/folders/t/${OUTBOUND_PREFIX}old-a.png`, now - HOUR - 1);
    fs.put(`/var/folders/t/${OUTBOUND_PREFIX}fresh-b.png`, now - 100);
    // 别家前缀再旧也不碰（dsh-im 共存互不误清扫）
    fs.put('/var/folders/t/dsh-im-out-old-c.png', now - 10 * HOUR);
    fs.put('/var/folders/t/unrelated.log', now - 10 * HOUR);

    const result = await sweepStaleOutbound(fs.deps, { now: () => now });

    expect(result).toEqual({ deleted: 1 });
    expect(fs.files.has(`/var/folders/t/${OUTBOUND_PREFIX}old-a.png`)).toBe(false);
    expect(fs.files.has(`/var/folders/t/${OUTBOUND_PREFIX}fresh-b.png`)).toBe(true);
    expect(fs.files.has('/var/folders/t/dsh-im-out-old-c.png')).toBe(true);
  });

  it('returns zero when tmpdir does not exist (common case)', async () => {
    const files = new Map<string, FileEntry>();
    const deps: OutboundDeps = {
      tmpdir: () => '/var/folders/t',
      writeFile: async () => undefined,
      readdir: async () => {
        throw new Error('ENOENT dir');
      },
      stat: async () => ({ mtimeMs: 0 }),
      rm: async () => undefined,
    };
    void files;
    await expect(sweepStaleOutbound(deps)).resolves.toEqual({ deleted: 0 });
  });

  it('skips failing entries cosmetically and keeps sweeping the rest', async () => {
    const now = 10 * HOUR;
    const fs = makeFakeFs(now);
    fs.put(`/var/folders/t/${OUTBOUND_PREFIX}bad.png`, now - HOUR - 1);
    fs.put(`/var/folders/t/${OUTBOUND_PREFIX}good.png`, now - HOUR - 1);
    fs.failStatOf = `/var/folders/t/${OUTBOUND_PREFIX}bad.png`;

    const result = await sweepStaleOutbound(fs.deps, { now: () => now });

    expect(result).toEqual({ deleted: 1 }); // good 删除继续
    expect(fs.skips).toHaveLength(1);
    expect(fs.skips[0]).toMatchObject({ name: `${OUTBOUND_PREFIX}bad.png` });
    expect(fs.skips[0]!.error).toContain('stat i/o error');
  });

  it('stringifies non-Error sweep failures in the skip report', async () => {
    const now = 10 * HOUR;
    const skips: FakeFs['skips'] = [];
    const deps: OutboundDeps = {
      tmpdir: () => '/var/folders/t',
      writeFile: async () => undefined,
      readdir: async () => [`${OUTBOUND_PREFIX}x.png`],
      stat: async () => {
        throw 'raw string failure'; // 非 Error 抛出物
      },
      rm: async () => undefined,
      onSweepSkip: (info) => skips.push(info),
    };
    await sweepStaleOutbound(deps, { now: () => now });
    expect(skips[0]!.error).toBe('raw string failure');
  });
});
