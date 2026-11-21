// chat.db 只读访问层：打开（含 schema 探测）、水位、增量拉取。
//
// 实测定案（2026-11 真机，Messages.app 运行中）：
// - readonly 打开即可读到 WAL 中的最新数据（-shm/-wal 可读时），无需复制库；
// - date 是 Mac absolute 纳秒（18 位，超 JS 安全整数）：SQL 层 CAST AS TEXT
//   无损带出（十进制字符串），消费侧 BigInt(row.dateNs) 精确转换——
//   浮点除法方案实测丢精度（.0001ms），已否决；
// - chat 表群聊判定列叫 style（不是 chat_style），但其枚举语义无文档，
//   改用 chat_handle_join 成员数判定群聊（>1 即群），不依赖 style 值。
//
// 行为约定：本模块是纯读取层，不做任何策略（fromMe 过滤除外——SQL 层
// 下沉的静态条件）；群聊/空消息/[dsh] 前缀等策略过滤在 normalize 层。

import { DatabaseSync } from 'node:sqlite';

/** schema 不符合预期（典型于 macOS 大版本升级改表）：明确报错不静默。 */
export class ChatDbSchemaError extends Error {
  constructor(public readonly missing: string[]) {
    super(`chat.db schema mismatch, missing: ${missing.join(', ')}`);
    this.name = 'ChatDbSchemaError';
  }
}

/** 查询依赖的列（schema 探测用）。 */
const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  message: [
    'ROWID',
    'guid',
    'text',
    'attributedBody',
    'is_from_me',
    'handle_id',
    'date',
    'thread_originator_guid',
  ],
  chat: ['ROWID', 'guid', 'style'],
  handle: ['ROWID', 'id', 'service'],
  attachment: [
    'ROWID',
    'filename',
    'mime_type',
    'is_sticker',
    'transfer_state',
    'transfer_name',
    'total_bytes',
  ],
};

/** 增量拉取的原始行（驼峰别名；dateNs 为十进制纳秒字符串）。 */
export interface ChatDbRow {
  readonly rowid: number;
  readonly guid: string;
  readonly text: string | null;
  /** attributedBody BLOB；93% 现代消息正文在这里。 */
  readonly attributedBody: Uint8Array | null;
  /** Mac absolute 纳秒，十进制字符串（BigInt 安全）。 */
  readonly dateNs: string;
  readonly isFromMe: number;
  /** 对方账号（handle.id，+86 形态或 email）。 */
  readonly handleText: string | null;
  readonly service: string | null;
  readonly chatGuid: string;
  readonly style: number;
  /** 聊天成员数（>1 = 群聊，策略过滤在 normalize 层）。 */
  readonly memberCount: number;
  /** 主附件（一条消息多附件时本查询展开多行，由 normalize 按 guid 合并）。
   * JOIN ON 准入（M6.1 定案）：贴纸/未完成传输
   * （transfer_state != 5）/无 filename 的附件不匹配——附件字段置空，
   * 不吞整条消息（放 ON 不放 WHERE）。 */
  readonly attachmentPath: string | null;
  readonly attachmentMime: string | null;
  /** 展示名（attachment.transfer_name，可空）。 */
  readonly attachmentName: string | null;
  /** 字节数（attachment.total_bytes，可空）。 */
  readonly attachmentBytes: number | null;
  /** 引用的原消息文本（thread_originator_guid JOIN）。 */
  readonly quotedText: string | null;
  readonly quotedDateNs: string | null;
}

const FETCH_SQL = `
  SELECT
    m.ROWID AS rowid,
    m.guid AS guid,
    m.text AS text,
    m.attributedBody AS attributedBody,
    CAST(m.date AS TEXT) AS dateNs,
    m.is_from_me AS isFromMe,
    h.id AS handleText,
    h.service AS service,
    c.guid AS chatGuid,
    c.style AS style,
    COALESCE(mc.member_count, 0) AS memberCount,
    a.filename AS attachmentPath,
    a.mime_type AS attachmentMime,
    a.transfer_name AS attachmentName,
    a.total_bytes AS attachmentBytes,
    q.text AS quotedText,
    CAST(q.date AS TEXT) AS quotedDateNs
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c ON c.ROWID = cmj.chat_id
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  LEFT JOIN (
    SELECT chat_id, COUNT(*) AS member_count
    FROM chat_handle_join GROUP BY chat_id
  ) mc ON mc.chat_id = c.ROWID
  LEFT JOIN message_attachment_join maj ON maj.message_id = m.ROWID
  LEFT JOIN attachment a ON a.ROWID = maj.attachment_id
    AND a.is_sticker = 0
    AND a.transfer_state = 5
    AND a.filename IS NOT NULL
  LEFT JOIN message q ON q.guid = m.thread_originator_guid
  WHERE m.ROWID > ? AND m.is_from_me = 0
    AND (
      (m.text IS NOT NULL AND m.text != '')
      OR m.attributedBody IS NOT NULL
      OR (a.filename IS NOT NULL AND a.mime_type LIKE 'image/%')
    )
  ORDER BY m.ROWID ASC
  LIMIT ?
`;

/** 打开真库（readonly）并做 schema 探测；不满足直接抛 ChatDbSchemaError。 */
export function openChatDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assertSchema(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/** schema 探测：查询依赖的表列必须齐（风险对策：macOS 升级改表时明确报错）。 */
export function assertSchema(db: DatabaseSync): void {
  const missing: string[] = [];
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const present = new Set(
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name),
    );
    if (present.size === 0) missing.push(`${table}(table)`);
    for (const col of columns) {
      if (!present.has(col)) missing.push(`${table}.${col}`);
    }
  }
  if (missing.length > 0) throw new ChatDbSchemaError(missing);
}

/** 当前最大 ROWID（首次启动的水位基准）；空库返回 undefined。 */
export function readMaxRowId(db: DatabaseSync): number | undefined {
  const row = db.prepare('SELECT MAX(ROWID) AS max FROM message').get() as
    { max: number | null } | undefined;
  return row?.max ?? undefined;
}

/**
 * 增量拉取：ROWID > afterRowId 的对方消息（is_from_me=0 已在 SQL 过滤），
 * 按 ROWID 升序、最多 limit 行（行≠消息数：多附件会展开，normalize 层合并）。
 * 空文本+空 BLOB+无完成态图片附件的消息（tapback 等）不返回；纯图消息
 * 靠 WHERE 的 image 分支纳入（M6.1）。
 */
export function fetchBatch(db: DatabaseSync, afterRowId: number, limit: number): ChatDbRow[] {
  return db.prepare(FETCH_SQL).all(afterRowId, limit) as unknown as ChatDbRow[];
}
