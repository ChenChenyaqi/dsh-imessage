// 外发文件暂存与清扫（M6.2 发图/发文件，probes ③ 终态纪律）。
//
// 为什么暂存文件故意比 send 调用活得久：osascript send 一返回，Messages
// 的 helper daemon 还在异步摄取/复制/上传附件——发完立即删 = 大文件竞态
// 丢失（transfer_state=0 卡死、无任何错误、对方收不到）。
//
// 为什么必须是 os.tmpdir()（/var/folders）：helper daemon 不读任意 home
// 路径（dsh-im 实测：暂存在 ~/.dsh 下的附件 transfer_state=6 永不投递）。
//
// 清扫无定时器：下次发送时顺带删 >1h 的同前缀旧文件；清扫失败仅日志
// （cosmetic，永不阻塞发送）。
//
// 前缀与 dsh-im 的 `dsh-im-out-` 刻意区分：两插件共存时互相不误清扫。

/** 外发暂存自有前缀（区别于 dsh-im 的 dsh-im-out-，防共存误清扫）。 */
export const OUTBOUND_PREFIX = 'dsh-imessage-out-';

/** 保留时长：Messages daemon 摄取完成绰绰有余，1h 后可清。 */
export const OUTBOUND_RETENTION_MS = 60 * 60_000;

/** 文件 IO 面（node:fs/promises 形状；测试注入内存 fake）。 */
export interface OutboundDeps {
  readonly tmpdir: () => string;
  readonly writeFile: (path: string, data: Uint8Array, mode: number) => Promise<void>;
  readonly readdir: (dir: string) => Promise<readonly string[]>;
  readonly stat: (path: string) => Promise<{ mtimeMs: number }>;
  readonly rm: (path: string) => Promise<void>;
  /** 失败 cosmetic 上报（清扫跳过/删除失败；不抛）。 */
  readonly onSweepSkip?: (info: { name: string; error: string }) => void;
}

/** 展示名安全化：basename + 空兜底（防把路径分隔符带进暂存文件名）。 */
export function safeOutboundName(name: string): string {
  const base = name.split('/').pop()!.split('\\').pop()!;
  return base === '' ? 'file' : base;
}

export interface StagedOutbound {
  /** 暂存绝对路径（交给 sender.sendFile 的就是它）。 */
  readonly path: string;
  /** 暂存字节数。 */
  readonly bytes: number;
}

/**
 * bytes 暂存为 tmpdir 文件：`<prefix><pid>-<ts>-<name>`、mode 0600。
 * 不返回清理责任——文件由后续 sweep 收走（见文件头纪律）。
 */
export async function stageOutboundFile(
  bytes: Uint8Array,
  name: string,
  deps: OutboundDeps,
  options: { pid?: number; now?: () => number } = {},
): Promise<StagedOutbound> {
  if (bytes.length === 0) throw new TypeError('outbound file bytes are required');
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const path = `${deps.tmpdir()}/${OUTBOUND_PREFIX}${pid}-${now()}-${safeOutboundName(name)}`;
  await deps.writeFile(path, bytes, 0o600);
  return { path, bytes: bytes.length };
}

export interface SweepResult {
  /** 实际删除的暂存文件数。 */
  readonly deleted: number;
}

/**
 * 清扫过期的同前缀暂存文件（>1h）。目录不存在是常态（返回 0）；
 * 单文件失败跳过上报、不中断——清扫永远不该让发送失败。
 */
export async function sweepStaleOutbound(
  deps: OutboundDeps,
  options: { now?: () => number; retentionMs?: number } = {},
): Promise<SweepResult> {
  const now = options.now ?? Date.now;
  const retentionMs = options.retentionMs ?? OUTBOUND_RETENTION_MS;
  const dir = deps.tmpdir();
  let names: readonly string[];
  try {
    names = await deps.readdir(dir);
  } catch {
    return { deleted: 0 }; // 目录不存在是常态
  }
  let deleted = 0;
  for (const name of names) {
    if (!name.startsWith(OUTBOUND_PREFIX)) continue;
    const path = `${dir}/${name}`;
    try {
      const { mtimeMs } = await deps.stat(path);
      if (now() - mtimeMs < retentionMs) continue;
      await deps.rm(path);
      deleted += 1;
    } catch (err) {
      // cosmetic：单文件失败不影响其余清扫，更不影响发送
      deps.onSweepSkip?.({
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { deleted };
}
