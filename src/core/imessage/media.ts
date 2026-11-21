// 媒体加载：附件元数据 → 可送 DSH 的图片 bytes（M6.1 Step B）。
//
// 职责与边界（docs/media-exchange/inbound-images.md 定案）：
// - 本模块是 core 层唯一的真 IO 触点——但全部经 deps 注入（CI fake），
//   与 preset() 同款模式；真实现由 host channel 组装；
// - 图片级失败只剔该图 + 结构化上报（skipped），绝不抛出——
//   文本照发（分叉②：整条失败在 at-most-once 语义下 = 吞消息，代价过高）；
// - HEIC→JPEG 中转拷贝转码（probes ③）：sips 只碰 tmpdir 中自有的
//   中间文件（input/output），不直接读写 Messages 源路径；中间文件
//   finally 删（进程内临时物，与 M6.2 外发暂存的 1h 纪律是两回事）；
// - DSH mediaType 白名单（probes ②）：png/jpeg/webp/gif 直读，
//   heic 转码，其余（tiff / video / null）跳过留痕。

import type { MessageAttachment } from '../types/messages';

/** DSH saveImages 接受的 mediaType（attachment-local 白名单，probes ②）。 */
export type DshImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** 加载完成的图片（bytes 形态；host 层再经 attachments.saveImages 签发 ref）。 */
export interface LoadedImage {
  readonly bytes: Uint8Array;
  readonly mediaType: DshImageMediaType;
  /** 展示名（heic 转码后同步替换 .jpg 扩展；源 null 则保持 null）。 */
  readonly name: string | null;
}

/** 跳过原因（日志/排查用；永不携带图片内容）。 */
export type SkippedImageReason =
  | 'not-image' // 非 image/*（mov/docx…；mediaType 为 null 同列——无法判定即不收）
  | 'unsupported-media-type' // image/* 但不在 DSH 白名单（tiff/heif-sequence…）
  | 'read-failed' // 源文件读失败（被清理/权限）
  | 'transcode-failed'; // sips 转码失败（损坏 heic/系统异常）

export interface SkippedImage {
  readonly path: string;
  readonly reason: SkippedImageReason;
  /** 底层错误摘要（read-failed / transcode-failed 时有）。 */
  readonly error?: string;
}

export interface LoadImagesResult {
  readonly loaded: readonly LoadedImage[];
  readonly skipped: readonly SkippedImage[];
}

/** 全注入的 IO 依赖（node:fs/promises + node:child_process 形态；CI fake）。 */
export interface MediaDeps {
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly writeFile: (path: string, data: Uint8Array) => Promise<void>;
  /** finally 清理用；实现侧错误由调用方吞掉（删失败不影响结果）。 */
  readonly unlink: (path: string) => Promise<void>;
  /** execFile 形态；reject = 非零退出/系统错误。 */
  readonly exec: (cmd: string, args: readonly string[]) => Promise<void>;
  readonly tmpdir: () => string;
  readonly homedir: () => string;
}

/** tmpdir 中间文件自有前缀（转码临时物；与 M6.2 外发前缀是两回事）。 */
export const TMP_FILE_PREFIX = 'dsh-imessage-tmp-';

/** 直读白名单（heic 不在——必须转码为 jpeg）。 */
const DIRECT_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const HEIC_MEDIA_TYPE = 'image/heic';

/** 进程内自增序号：同一批多附件、跨批并发都不撞名。 */
let tmpCounter = 0;

/** `~/…` → homedir 展开；其余（含 ~user 与绝对路径）原样返回。 */
export function expandHome(path: string, homedir: string): string {
  if (path === '~') return homedir;
  if (path.startsWith('~/')) return `${homedir}/${path.slice(2)}`;
  return path;
}

/** 展示名换扩展（无扩展则追加）；null 保持 null。 */
function withJpegName(name: string | null): string | null {
  if (name === null) return null;
  return /\.[^.]*$/.test(name) ? name.replace(/\.[^.]*$/, '.jpg') : `${name}.jpg`;
}

/** 单附件 → 图片（或跳过）。永不抛。 */
async function loadOne(
  att: MessageAttachment,
  deps: MediaDeps,
): Promise<LoadedImage | SkippedImage> {
  if (!att.mediaType?.startsWith('image/')) {
    return { path: att.path, reason: 'not-image' };
  }
  if (att.mediaType !== HEIC_MEDIA_TYPE && !DIRECT_MEDIA_TYPES.has(att.mediaType)) {
    // 白名单外（tiff/heif-sequence…）：不读源，直接跳过（省 IO 且语义准）
    return { path: att.path, reason: 'unsupported-media-type' };
  }
  // 源文件读取对直读/转码两路先行（失败统一归 read-failed）
  let source: Uint8Array;
  try {
    source = await deps.readFile(expandHome(att.path, deps.homedir()));
  } catch (err) {
    return { path: att.path, reason: 'read-failed', error: messageOf(err) };
  }
  if (att.mediaType === HEIC_MEDIA_TYPE) {
    return transcodeHeic(att, source, deps);
  }
  return { bytes: source, mediaType: att.mediaType as DshImageMediaType, name: att.name };
}

/** HEIC 中转转码：tmpdir 写中间 .heic → sips → 读回 .jpg → finally 删两文件。
 * 源 bytes 已读得（read-failed 已在上游分类），此处失败皆转码链路问题。 */
async function transcodeHeic(
  att: MessageAttachment,
  source: Uint8Array,
  deps: MediaDeps,
): Promise<LoadedImage | SkippedImage> {
  tmpCounter += 1;
  const heicPath = `${deps.tmpdir()}/${TMP_FILE_PREFIX}${tmpCounter}.heic`;
  const jpgPath = `${deps.tmpdir()}/${TMP_FILE_PREFIX}${tmpCounter}.jpg`;
  try {
    await deps.writeFile(heicPath, source);
    // dsh-im 已验证参数形态（probes ③）；sips 零退出即成功
    await deps.exec('/usr/bin/sips', ['-s', 'format', 'jpeg', heicPath, '--out', jpgPath]);
    const bytes = await deps.readFile(jpgPath);
    return { bytes, mediaType: 'image/jpeg', name: withJpegName(att.name) };
  } catch (err) {
    return { path: att.path, reason: 'transcode-failed', error: messageOf(err) };
  } finally {
    // 中间文件是进程内临时物：删失败（竞态/权限）只留隐患不留错误
    await deps.unlink(heicPath).catch(() => undefined);
    await deps.unlink(jpgPath).catch(() => undefined);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 加载一批附件中的图片。逐图独立成败：任何失败只进 skipped，
 * 不阻塞其他图片与文本（分叉②定案）。输出顺序与输入一致。
 */
export async function loadImages(
  attachments: readonly MessageAttachment[],
  deps: MediaDeps,
): Promise<LoadImagesResult> {
  const loaded: LoadedImage[] = [];
  const skipped: SkippedImage[] = [];
  for (const att of attachments) {
    const result = await loadOne(att, deps);
    if ('reason' in result) skipped.push(result);
    else loaded.push(result);
  }
  return { loaded, skipped };
}
