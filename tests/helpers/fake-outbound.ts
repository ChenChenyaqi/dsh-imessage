// 内存版 OutboundDeps（pipeline 交付段测试用；M6.2）。
// 语义对齐 node:fs/promises 的最小面：writeFile/readdir/stat/rm + tmpdir。

export interface FakeOutboundFile {
  data: Uint8Array;
  mode: number;
  mtimeMs: number;
}

export interface FakeOutbound {
  /** path → entry（可断言暂存命名与 mode）。 */
  files: Map<string, FakeOutboundFile>;
  /** 注入：匹配 path 的 writeFile 抛错（stage 失败旁支）。 */
  failWriteOf?: string;
  /** 注入：第 N 次（1 基）writeFile 抛错（按序注入用；抛出物可自定义）。 */
  failWriteAt?: number;
  /** failWriteAt 的抛出物（缺省 Error('disk full')；非 Error 用例用）。 */
  failWriteWith?: unknown;
  skips: Array<{ name: string; error: string }>;
  deps: import('@/core/imessage/outbound').OutboundDeps;
  /** 预置一个文件（清扫用例）。 */
  put(path: string, mtimeMs: number): void;
}

export function makeFakeOutbound(nowMs = 1_000_000): FakeOutbound {
  const files = new Map<string, FakeOutboundFile>();
  const skips: FakeOutbound['skips'] = [];
  let writeCount = 0;
  const fake: FakeOutbound = {
    files,
    skips,
    deps: {
      tmpdir: () => '/var/folders/t',
      writeFile: async (path, data, mode) => {
        writeCount += 1;
        if (path === fake.failWriteOf || writeCount === fake.failWriteAt) {
          throw fake.failWriteWith ?? new Error('disk full');
        }
        files.set(path, { data, mode, mtimeMs: nowMs });
      },
      readdir: async () => [...files.keys()].map((p) => p.split('/').pop()!),
      stat: async (path) => {
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
