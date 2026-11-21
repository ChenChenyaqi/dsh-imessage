// 查询涉及的最小 chat.db schema（内存库用；从 chatdb.test.ts 抽出共享）。
// 见 src/core/imessage/chatdb.ts 的 REQUIRED_COLUMNS。
import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_SQL = `
  CREATE TABLE message (
    ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
    is_from_me INTEGER, handle_id INTEGER, date INTEGER,
    thread_originator_guid TEXT
  );
  CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, style INTEGER);
  CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
  CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
  CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
  CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
  CREATE TABLE attachment (
    ROWID INTEGER PRIMARY KEY, filename TEXT, mime_type TEXT,
    is_sticker INTEGER DEFAULT 0, transfer_state INTEGER,
    transfer_name TEXT, total_bytes INTEGER
  );
`;

/** 插一条对方文本消息（handle/chat/join 按需补行——fetchBatch 是 JOIN 查询）。
 * 单聊：chat 只有该 handle 一个成员。 */
export function insertIncomingMessage(
  db: DatabaseSync,
  input: {
    rowid: number;
    guid: string;
    handleId: string;
    text: string;
  },
): void {
  db.prepare(
    `INSERT INTO handle (ROWID, id, service)
     VALUES (?, ?, 'iMessage')
     ON CONFLICT(ROWID) DO UPDATE SET id = excluded.id`,
  ).run(input.rowid, input.handleId);
  db.prepare(
    `INSERT INTO chat (ROWID, guid, style)
     VALUES (?, ?, 45)
     ON CONFLICT(ROWID) DO NOTHING`,
  ).run(input.rowid + 100, `CHAT-${input.guid}`);
  db.prepare(`INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)`).run(
    input.rowid + 100,
    input.rowid,
  );
  db.prepare(`INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)`).run(
    input.rowid + 100,
    input.rowid,
  );
  db.prepare(
    `INSERT INTO message (ROWID, guid, text, is_from_me, handle_id, date)
     VALUES (?, ?, ?, 0, ?, 815743613388000000)`,
  ).run(input.rowid, input.guid, input.text, input.rowid);
}
