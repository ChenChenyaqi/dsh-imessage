// chat.db 原始行 → NormalizedMessage 归一化管道（M2 的「翻译官」）。
//
// 职责（所有策略性过滤集中在这层，poller/gate 保持纯粹）：
// - date 转换：Mac 绝对纳秒 → epoch 毫秒（BigInt 无损通道）
// - 双源文本合并：text 列优先，空则 typedstream 解码 attributedBody
// - 占位降级（协议标记，故意英文不走 i18n，AI 理解后自行本地化转述）：
//     纯附件且无图（剥 U+FFFC 后空，双源同规）→ [attachment: image, not yet supported]
//     解码失败（null）                        → [undecodable message]
//     带图附件且正文空（纯图/图文无字）       → ''（纯图消息，图走内容块，M6.1）
// - 防循环过滤：fromMe 防御滤 / [dsh] 前缀 / 群聊 / 无 handle / 非法 handle
// - conversationKey 派生：normalizePhone；归一化失败按默认拒绝跳过
// - 多行合并：同 guid 多附件展开行（fetchBatch 的 LIMIT 语义）合为一条
//
// 结果两态：accepted / skipped（带原因）。skipped 不进 gate 但 cursor
// 照样推进（由 M3 pipeline 决定）；本层不抛错——输入异常全部转为
// skipped，保证「单条坏消息不阻塞管道」。

import type { ChatDbRow } from './chatdb';
import { OBJECT_REPLACEMENT_CHAR, decodeAttributedBodyText } from './typedstream';
import {
  makeNormalizedMessage,
  type MessageAttachment,
  type NormalizedMessage,
} from '../types/messages';
import { normalizePhone } from '../types/phone';

// ---------------------------------------------------------------------------
// 占位协议标记（发给 DSH 的机器可读信号，非用户文案）
// ---------------------------------------------------------------------------

export const ATTACHMENT_PLACEHOLDER = '[attachment: image, not yet supported]';
export const UNDECODABLE_PLACEHOLDER = '[undecodable message]';

/** 本插件系统消息前缀（sender 层 system 路径同款），回环防御。 */
export const DSH_PREFIX = '[dsh]';

/** Mac 绝对时间（2001 epoch）与 Unix epoch 的毫秒差。 */
const MAC_EPOCH_OFFSET_MS = 978_307_200_000;

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

export type SkipReason =
  | 'from-me' // 本机发出（SQL 已滤，防御性再滤——fetchBatch 变更时兜底）
  | 'bot-prefix' // [dsh] 系统消息回环（防御深度）
  | 'group-chat' // 群聊（MVP 只做单聊）
  | 'no-handle' // 无对方账号（系统事件等）
  | 'invalid-handle' // handle 归一化失败（裸号/超界垃圾号，默认拒绝）
  | 'empty'; // 无文本也无 BLOB（tapback 等系统交互）

export type NormalizeResult =
  | { readonly status: 'accepted'; readonly message: NormalizedMessage }
  | {
      readonly status: 'skipped';
      readonly guid: string;
      readonly rowId: number;
      readonly reason: SkipReason;
    };

// ---------------------------------------------------------------------------
// 转换与归一
// ---------------------------------------------------------------------------

/** Mac 绝对纳秒（十进制字符串）→ epoch 毫秒。非法输入抛 TypeError。 */
export function macAbsoluteToEpochMs(dateNs: string): number {
  try {
    return Number(BigInt(dateNs) / 1_000_000n) + MAC_EPOCH_OFFSET_MS;
  } catch {
    throw new TypeError(`invalid Mac absolute timestamp: ${dateNs}`);
  }
}

/** 解析正文：text 列优先；空则解码 BLOB；最后分派占位。
 * M6.1：有图片附件时，空文本（双源空/剥 U+FFFC 后空）降为 '' 而非
 * 占位/skip——纯图消息的正文就是图，内容块化在 pipeline 层完成。 */
function resolveText(row: ChatDbRow, hasImageAttachment: boolean): string | null {
  if (row.text !== null && row.text !== '') {
    // text 列同样内嵌 U+FFFC 附件占位（真机实测：纯图消息 text='\uFFFC'，
    // 图+文混排时占位符与 caption 混排）——与 attributedBody 解码路径
    // 同款剥离；剥后纯空白视为无文本。判定用 trim，返回内容保原样。
    const stripped = row.text.replaceAll(OBJECT_REPLACEMENT_CHAR, '');
    if (stripped.trim() !== '') return stripped;
    return hasImageAttachment ? '' : ATTACHMENT_PLACEHOLDER;
  }

  if (row.attributedBody && row.attributedBody.length > 0) {
    const decoded = decodeAttributedBodyText(row.attributedBody);
    if (decoded === null) return UNDECODABLE_PLACEHOLDER; // 解码失败
    if (decoded === '') return hasImageAttachment ? '' : ATTACHMENT_PLACEHOLDER; // 纯附件
    return decoded;
  }
  // 双源皆空：纯图消息进得来（SQL image 分支），其余交给 skip empty
  return hasImageAttachment ? '' : null;
}

/** 从 JOIN 行提取附件元数据（准入态：未完成/贴纸/无 filename 的行此字段全空）。 */
function attachmentOf(row: ChatDbRow): MessageAttachment | null {
  if (row.attachmentPath === null) return null;
  return {
    path: row.attachmentPath,
    mediaType: row.attachmentMime,
    name: row.attachmentName,
    bytes: row.attachmentBytes,
  };
}

/** 是否携带图片附件（mime 前缀判定；null mime 不算——media 层同款准入）。 */
function hasImageAttachment(attachments: readonly MessageAttachment[]): boolean {
  return attachments.some((a) => a.mediaType?.startsWith('image/') === true);
}

function skip(guid: string, rowId: number, reason: SkipReason): NormalizeResult {
  return { status: 'skipped', guid, rowId, reason };
}

function normalizeOne(row: ChatDbRow, attachments: readonly MessageAttachment[]): NormalizeResult {
  if (row.isFromMe !== 0) return skip(row.guid, row.rowid, 'from-me');
  if (row.memberCount > 1) return skip(row.guid, row.rowid, 'group-chat');
  if (row.handleText === null) return skip(row.guid, row.rowid, 'no-handle');

  const text = resolveText(row, hasImageAttachment(attachments));
  if (text === null) return skip(row.guid, row.rowid, 'empty');
  if (text.startsWith(DSH_PREFIX)) return skip(row.guid, row.rowid, 'bot-prefix');

  const conversationKey = normalizePhone(row.handleText);
  if (conversationKey === null) return skip(row.guid, row.rowid, 'invalid-handle');

  const message = makeNormalizedMessage({
    guid: row.guid,
    rowId: row.rowid,
    date: macAbsoluteToEpochMs(row.dateNs),
    fromMe: false,
    text,
    conversationKey,
    quotedText: row.quotedText ?? undefined,
    // 无附件不设字段（旧 fixture / 序列化兼容）；media 策略过滤在 media 层
    ...(attachments.length > 0 ? { attachments } : {}),
  });
  return { status: 'accepted', message };
}

/**
 * 批量归一：先按 guid 合并多附件展开行（同 guid 取首行主体，各行的
 * 附件元数据按 path 去重聚合为 attachments，M6.1），再逐条归一。
 * 输出按 rowid 升序——不依赖上游 fetchBatch 的排序约定，输出契约自洽。
 */
export function normalizeRows(rows: readonly ChatDbRow[]): NormalizeResult[] {
  const byGuid = new Map<string, { head: ChatDbRow; attachments: MessageAttachment[] }>();
  const seenPaths = new Map<string, Set<string>>();
  for (const row of rows) {
    let entry = byGuid.get(row.guid);
    if (!entry) {
      entry = { head: row, attachments: [] };
      byGuid.set(row.guid, entry);
      seenPaths.set(row.guid, new Set());
    }
    const att = attachmentOf(row);
    if (att !== null) {
      const seen = seenPaths.get(row.guid)!;
      if (!seen.has(att.path)) {
        seen.add(att.path);
        entry.attachments.push(att);
      }
    }
  }
  return [...byGuid.values()]
    .sort((a, b) => a.head.rowid - b.head.rowid)
    .map((entry) => normalizeOne(entry.head, Object.freeze(entry.attachments)));
}
