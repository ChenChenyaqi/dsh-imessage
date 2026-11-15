// chat.db 原始行 → NormalizedMessage 归一化管道（M2 的「翻译官」）。
//
// 职责（所有策略性过滤集中在这层，poller/gate 保持纯粹）：
// - date 转换：Mac 绝对纳秒 → epoch 毫秒（BigInt 无损通道）
// - 双源文本合并：text 列优先，空则 typedstream 解码 attributedBody
// - 占位降级（协议标记，故意英文不走 i18n，AI 理解后自行本地化转述）：
//     纯附件（解码成功但剥 U+FFFC 后空）→ [attachment: image, not yet supported]
//     解码失败（null）                  → [undecodable message]
// - 防循环过滤：fromMe 防御滤 / [dsh] 前缀 / 群聊 / 无 handle / 非法 handle
// - conversationKey 派生：normalizePhone；归一化失败按默认拒绝跳过
// - 多行合并：同 guid 多附件展开行（fetchBatch 的 LIMIT 语义）合为一条
//
// 结果两态：accepted / skipped（带原因）。skipped 不进 gate 但 cursor
// 照样推进（由 M3 pipeline 决定）；本层不抛错——输入异常全部转为
// skipped，保证「单条坏消息不阻塞管道」。

import type { ChatDbRow } from './chatdb';
import { decodeAttributedBodyText } from './typedstream';
import { makeNormalizedMessage, type NormalizedMessage } from '../types/messages';
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

/** 解析正文：text 列优先；空则解码 BLOB；最后分派占位。 */
function resolveText(row: ChatDbRow): string | null {
  if (row.text !== null && row.text !== '') return row.text;

  if (row.attributedBody && row.attributedBody.length > 0) {
    const decoded = decodeAttributedBodyText(row.attributedBody);
    if (decoded === null) return UNDECODABLE_PLACEHOLDER; // 解码失败
    if (decoded === '') return ATTACHMENT_PLACEHOLDER; // 纯附件
    return decoded;
  }
  return null; // 双源皆空
}

function skip(guid: string, rowId: number, reason: SkipReason): NormalizeResult {
  return { status: 'skipped', guid, rowId, reason };
}

function normalizeOne(row: ChatDbRow): NormalizeResult {
  if (row.isFromMe !== 0) return skip(row.guid, row.rowid, 'from-me');
  if (row.memberCount > 1) return skip(row.guid, row.rowid, 'group-chat');
  if (row.handleText === null) return skip(row.guid, row.rowid, 'no-handle');

  const text = resolveText(row);
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
  });
  return { status: 'accepted', message };
}

/**
 * 批量归一：先按 guid 合并多附件展开行（同 guid 取首行主体，附件信息
 * 合并至 M5 使用），再逐条归一。输出按 rowid 升序——不依赖上游
 * fetchBatch 的排序约定，输出契约自洽。
 */
export function normalizeRows(rows: readonly ChatDbRow[]): NormalizeResult[] {
  const byGuid = new Map<string, ChatDbRow>();
  for (const row of rows) {
    if (!byGuid.has(row.guid)) byGuid.set(row.guid, row); // 首行为主体
  }
  return [...byGuid.values()].sort((a, b) => a.rowid - b.rowid).map((row) => normalizeOne(row));
}
