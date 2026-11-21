// media 模块镜像测试：全 fake deps，零真 IO（CI/Linux 可跑）。
// 断言点：准入矩阵、HEIC 转码链路（sips 参数、.jpg 命名、finally 清理
// 含失败路径）、expandHome、逐图独立成败、永不抛出。

import { describe, expect, it } from 'vitest';

import {
  expandHome,
  loadImages,
  TMP_FILE_PREFIX,
  type MediaDeps,
  type SkippedImageReason,
} from '@/core/imessage/media';
import type { MessageAttachment } from '@/core/types/messages';

// ---------------------------------------------------------------------------
// fake deps
// ---------------------------------------------------------------------------

interface Call {
  readonly kind: 'read' | 'write' | 'unlink' | 'exec';
  readonly args: readonly unknown[];
}

/** 内存文件系统 + exec 记录；可注入失败点与 sips 产物。 */
function makeDeps(over: Partial<MediaDeps> = {}) {
  const files = new Map<string, Uint8Array>();
  const calls: Call[] = [];
  const deps: MediaDeps = {
    readFile: async (path) => {
      calls.push({ kind: 'read', args: [path] });
      const f = files.get(path);
      if (!f) throw new Error(`ENOENT: ${path}`);
      return f;
    },
    writeFile: async (path, data) => {
      calls.push({ kind: 'write', args: [path] });
      files.set(path, data);
    },
    unlink: async (path) => {
      calls.push({ kind: 'unlink', args: [path] });
      files.delete(path);
    },
    exec: async (cmd, args) => {
      calls.push({ kind: 'exec', args: [cmd, ...args] });
      // sips 语义：--out 的目标写入（jpeg 产物）
      const out = args[args.indexOf('--out') + 1];
      files.set(out as string, new TextEncoder().encode('jpeg-bytes'));
    },
    tmpdir: () => '/tmp',
    homedir: () => '/Users/tester',
    ...over,
  };
  return { deps, files, calls };
}

function att(over: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    path: '~/Library/Messages/Attachments/ab/cd/IMG.heic',
    mediaType: 'image/heic',
    name: 'IMG.heic',
    bytes: 1000,
    ...over,
  };
}

const skippedOf = (r: { skipped: readonly { reason: SkippedImageReason }[] }) =>
  r.skipped.map((s) => s.reason);

// ---------------------------------------------------------------------------
// expandHome
// ---------------------------------------------------------------------------

describe('expandHome', () => {
  it('expands ~/… onto homedir', () => {
    expect(expandHome('~/Library/Messages', '/Users/t')).toBe('/Users/t/Library/Messages');
  });

  it('expands a bare ~ to homedir', () => {
    expect(expandHome('~', '/Users/t')).toBe('/Users/t');
  });

  it('keeps absolute paths and ~user untouched', () => {
    expect(expandHome('/var/folders/xyz', '/Users/t')).toBe('/var/folders/xyz');
    expect(expandHome('~shared/cache', '/Users/t')).toBe('~shared/cache');
  });
});

// ---------------------------------------------------------------------------
// loadImages · 准入矩阵
// ---------------------------------------------------------------------------

describe('loadImages · admission', () => {
  it('returns empty result for no attachments', async () => {
    const { deps } = makeDeps();
    await expect(loadImages([], deps)).resolves.toEqual({ loaded: [], skipped: [] });
  });

  it('loads white-listed types directly without touching tmpdir', async () => {
    const { deps, files, calls } = makeDeps();
    files.set('/Users/tester/a.png', new Uint8Array([1]));
    const r = await loadImages(
      [att({ path: '~/a.png', mediaType: 'image/png', name: 'a.png' })],
      deps,
    );
    expect(r.loaded).toEqual([
      { bytes: new Uint8Array([1]), mediaType: 'image/png', name: 'a.png' },
    ]);
    expect(skippedOf(r)).toEqual([]);
    // 直读不产生中间文件与 exec
    expect(calls.filter((c) => c.kind === 'exec')).toEqual([]);
    expect(calls.filter((c) => c.kind === 'write')).toEqual([]);
  });

  it.each([
    ['mov', att({ mediaType: 'video/quicktime' }), 'not-image'],
    ['null mime', att({ mediaType: null }), 'not-image'],
    ['tiff', att({ mediaType: 'image/tiff' }), 'unsupported-media-type'],
  ])('skips %s with %s', async (_name, input, reason) => {
    const { deps } = makeDeps();
    const r = await loadImages([input], deps);
    expect(r.loaded).toEqual([]);
    expect(skippedOf(r)).toEqual([reason]);
    expect(r.skipped[0]!.path).toBe(input.path);
  });
});

// ---------------------------------------------------------------------------
// loadImages · 直读失败
// ---------------------------------------------------------------------------

describe('loadImages · read failures', () => {
  it('skips with read-failed when the source is unreadable', async () => {
    const { deps } = makeDeps(); // 文件系统里没有源文件
    const r = await loadImages([att({ mediaType: 'image/png' })], deps);
    expect(skippedOf(r)).toEqual(['read-failed']);
    expect(r.skipped[0]!.error).toMatch(/ENOENT/);
  });

  it('stringifies non-Error rejections in the error field', async () => {
    const { deps } = makeDeps();
    const throwing: MediaDeps = {
      ...deps,
      readFile: async () => {
        throw 'raw string failure';
      },
    };
    const r = await loadImages([att({ mediaType: 'image/png' })], throwing);
    expect(skippedOf(r)).toEqual(['read-failed']);
    expect(r.skipped[0]!.error).toBe('raw string failure');
  });
});

// ---------------------------------------------------------------------------
// loadImages · HEIC 转码链路
// ---------------------------------------------------------------------------

describe('loadImages · heic transcode', () => {
  function heicDeps() {
    const ctx = makeDeps();
    ctx.files.set(
      '/Users/tester/Library/Messages/Attachments/ab/cd/IMG.heic',
      new TextEncoder().encode('heic-source'),
    );
    return ctx;
  }

  it('transcodes heic via tmpdir + sips and reports as image/jpeg', async () => {
    const { deps, calls } = heicDeps();
    const r = await loadImages([att()], deps);
    expect(r.loaded).toEqual([
      { bytes: new TextEncoder().encode('jpeg-bytes'), mediaType: 'image/jpeg', name: 'IMG.jpg' },
    ]);
    const exec = calls.find((c) => c.kind === 'exec')!;
    const args = exec.args as string[];
    // args = ['/usr/bin/sips', '-s', 'format', 'jpeg', inPath, '--out', outPath]
    const inPath = args[4]!;
    const outPath = args[6]!;
    expect(args[0]).toBe('/usr/bin/sips');
    expect(args.slice(1)).toEqual(['-s', 'format', 'jpeg', inPath, '--out', outPath]);
    expect(inPath).toMatch(new RegExp(`^/tmp/${TMP_FILE_PREFIX}\\d+\\.heic$`));
    expect(outPath).toBe(inPath.replace(/\.heic$/, '.jpg'));
  });

  it('writes and finally-deletes both intermediates in tmpdir only', async () => {
    const { deps, files, calls } = heicDeps();
    await loadImages([att()], deps);
    // 中间文件已删（源文件不动）
    expect([...files.keys()]).toEqual([
      '/Users/tester/Library/Messages/Attachments/ab/cd/IMG.heic',
    ]);
    const wrote = calls.filter((c) => c.kind === 'write').map((c) => c.args[0] as string);
    expect(wrote).toHaveLength(1); // 只写中间 .heic
    const unlinked = calls.filter((c) => c.kind === 'unlink').map((c) => c.args[0] as string);
    expect(unlinked).toEqual([...wrote, wrote[0]!.replace(/\.heic$/, '.jpg')]);
    // 中间文件全部在 tmpdir，源路径从未被写（中转拷贝纪律）
    expect(wrote.every((p) => p.startsWith('/tmp/'))).toBe(true);
  });

  it('keeps null name null after transcode', async () => {
    const { deps } = heicDeps();
    const r = await loadImages([att({ name: null })], deps);
    expect(r.loaded[0]!.name).toBeNull();
  });

  it('appends .jpg when the name has no extension', async () => {
    const { deps } = heicDeps();
    const r = await loadImages([att({ name: 'IMG_1234' })], deps);
    expect(r.loaded[0]!.name).toBe('IMG_1234.jpg');
  });

  it('skips with transcode-failed when sips errors, still cleaning up', async () => {
    const { deps, files } = heicDeps();
    const failing: MediaDeps = {
      ...deps,
      exec: async () => {
        throw new Error('sips exited 1');
      },
    };
    const r = await loadImages([att()], failing);
    expect(skippedOf(r)).toEqual(['transcode-failed']);
    expect(r.skipped[0]!.error).toMatch(/sips exited 1/);
    // finally 清理仍执行（tmpdir 不残留中间文件）
    expect([...files.keys()].filter((p) => p.startsWith('/tmp/'))).toEqual([]);
  });

  it('survives unlink failures in cleanup (swallowed)', async () => {
    const { deps } = heicDeps();
    const failing: MediaDeps = {
      ...deps,
      unlink: async () => {
        throw new Error('EBUSY');
      },
    };
    const r = await loadImages([att()], failing);
    expect(r.loaded).toHaveLength(1); // 清理失败不影响结果
  });

  it('reports read-failed (not transcode) when the heic source is missing', async () => {
    const { deps } = makeDeps(); // 无源文件
    const r = await loadImages([att()], deps);
    expect(skippedOf(r)).toEqual(['read-failed']);
  });
});

// ---------------------------------------------------------------------------
// loadImages · 混合批与顺序
// ---------------------------------------------------------------------------

describe('loadImages · mixed batches', () => {
  it('processes each attachment independently, preserving order', async () => {
    const { deps, files } = makeDeps();
    files.set('/Users/tester/ok.png', new Uint8Array([7]));
    const r = await loadImages(
      [
        att({ path: '~/ok.png', mediaType: 'image/png', name: 'ok.png' }),
        att({ path: '~/clip.mov', mediaType: 'video/quicktime', name: 'clip.mov' }),
        att({ path: '~/gone.heic' }), // 源不存在 → read-failed
      ],
      deps,
    );
    expect(r.loaded.map((l) => l.name)).toEqual(['ok.png']);
    expect(skippedOf(r)).toEqual(['not-image', 'read-failed']);
    expect(r.skipped[1]!.path).toBe('~/gone.heic');
  });
});
