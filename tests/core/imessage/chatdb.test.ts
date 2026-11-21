import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
  assertSchema,
  ChatDbSchemaError,
  fetchBatch,
  openChatDb,
  readMaxRowId,
} from '@/core/imessage/chatdb';

/** 查询涉及的最小 schema（内存库用；共享自 tests/helpers）。 */
import { SCHEMA_SQL } from '../../helpers/chatdb-schema';

interface Fixture {
  readonly db: DatabaseSync;
  readonly dispose: () => void;
}

/** 建内存库并灌一组覆盖各场景的 fixture 数据。
 * M6.1 起附件 JOIN 带准入（is_sticker=0 / transfer_state=5 / filename 非空），
 * fixture 覆盖准入矩阵：完成态图片（M6）、未完成（M7）、贴纸（M8）、
 * 无 filename（M9）、非图片 mime（M10 文本+mov / M13 纯 mov 不返回）、
 * 纯图（M11）、多附件扇出（M12）、空消息不返回（M14）。 */
function makeDb(): Fixture {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec(`
    INSERT INTO handle (ROWID, id, service) VALUES
      (1, '+8613800000000', 'iMessage'),
      (2, '+8613900000000', 'iMessage');
    INSERT INTO chat (ROWID, guid, style) VALUES
      (10, 'CHAT-ONE', 45),
      (11, 'CHAT-GROUP', 45);

    INSERT INTO attachment (
      ROWID, filename, mime_type, is_sticker, transfer_state, transfer_name, total_bytes
    ) VALUES
      (90, '/tmp/IMG_0001.heic', 'image/heic', 0, 5, 'IMG_0001.heic', 546000),
      (91, '/tmp/dl.png', 'image/png', 0, 0, 'dl.png', 1000),
      (92, '/tmp/sticker.png', 'image/png', 1, 5, 'sticker.png', 2000),
      (93, NULL, 'image/png', 0, 5, 'nofile.png', 3000),
      (94, '/tmp/clip.mov', 'video/quicktime', 0, 5, 'clip.mov', 8000000),
      (95, '/tmp/a.png', 'image/png', 0, 5, 'a.png', 95000),
      (96, '/tmp/b.png', 'image/png', 0, 5, 'b.png', 96000),
      (97, '/tmp/solo.mov', 'video/quicktime', 0, 5, 'solo.mov', 7000000),
      (98, '/tmp/solo.png', 'image/png', 0, 5, 'solo.png', 98000);

    -- ROWID 1：普通对方文本消息
    INSERT INTO message (ROWID, guid, text, is_from_me, handle_id, date)
      VALUES (1, 'M1', 'hello', 0, 1, 815743613388000000);
    -- ROWID 2：自己发的（SQL 层过滤）
    INSERT INTO message (ROWID, guid, text, is_from_me, handle_id, date)
      VALUES (2, 'M2', 'my reply', 1, 1, 815743613488000000);
    -- ROWID 3：正文在 attributedBody（text 为空）
    INSERT INTO message (ROWID, guid, text, attributedBody, is_from_me, handle_id, date)
      VALUES (3, 'M3', NULL, x'0102', 0, 1, 815743613588000000);
    -- ROWID 4：群聊消息（chat 11 有 2 成员）
    INSERT INTO message (ROWID, guid, text, is_from_me, handle_id, date)
      VALUES (4, 'M4', 'group msg', 0, 2, 815743613688000000);
    -- ROWID 5：引用 M1 的回复
    INSERT INTO message (ROWID, guid, text, is_from_me, handle_id, date, thread_originator_guid)
      VALUES (5, 'M5', 're: hello', 0, 1, 815743613788000000, 'M1');
    -- ROWID 6：带完成态图片附件（无正文，纯图）
    INSERT INTO message (ROWID, guid, text, is_from_me, handle_id, date)
      VALUES (6, 'M6', NULL, 0, 1, 815743613888000000);
    INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (6, 90);
    -- ROWID 7：附件传输未完成（transfer_state=0）——消息照返，附件字段空
    INSERT INTO message (ROWID, guid, text, is_from_me, handle_id, date)
      VALUES (7, 'M7', 'still downloading', 0, 1, 815743613988000000);
    INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (7, 91);
    -- ROWID 8：贴纸附件（is_sticker=1）——同上，附件字段空
    INSERT INTO message (ROWID, guid, text, is_from_me, handle_id, date)
      VALUES (8, 'M8', 'sticker msg', 0, 1, 815743614088000000);
    INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (8, 92);
    -- ROWID 9：无 filename 附件——同上，附件字段空
    INSERT INTO message (ROWID, guid, text, is_from_me, handle_id, date)
      VALUES (9, 'M9', 'no filename', 0, 1, 815743614188000000);
    INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (9, 93);
    -- ROWID 10：文本 + 非 image 附件（mov）——准入不含 mime，附件照带
    INSERT INTO message (ROWID, guid, text, is_from_me, handle_id, date)
      VALUES (10, 'M10', 'look at this video', 0, 1, 815743614288000000);
    INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (10, 94);
    -- ROWID 11：纯图（双源空 + 完成态 png）——WHERE image 分支纳入
    INSERT INTO message (ROWID, guid, text, is_from_me, handle_id, date)
      VALUES (11, 'M11', NULL, 0, 1, 815743614388000000);
    INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (11, 98);
    -- ROWID 12：多附件纯图（JOIN 扇出 2 行，normalize 层折叠）
    INSERT INTO message (ROWID, guid, text, is_from_me, handle_id, date)
      VALUES (12, 'M12', NULL, 0, 1, 815743614488000000);
    INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (12, 95), (12, 96);
    -- ROWID 13：纯 mov（双源空 + 非 image 附件）——不返回
    INSERT INTO message (ROWID, guid, text, is_from_me, handle_id, date)
      VALUES (13, 'M13', NULL, 0, 1, 815743614588000000);
    INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (13, 97);
    -- ROWID 14：空消息（tapback 类）——不返回
    INSERT INTO message (ROWID, guid, text, is_from_me, handle_id, date)
      VALUES (14, 'M14', NULL, 0, 1, 815743614688000000);

    INSERT INTO chat_message_join (chat_id, message_id) VALUES
      (10, 1), (10, 2), (10, 3), (11, 4), (10, 5), (10, 6), (10, 7), (10, 8),
      (10, 9), (10, 10), (10, 11), (10, 12), (10, 13), (10, 14);
    INSERT INTO chat_handle_join (chat_id, handle_id) VALUES
      (10, 1), (11, 1), (11, 2);
  `);
  return { db, dispose: () => db.close() };
}

describe('fetchBatch', () => {
  it('returns only inbound messages with joined handle/chat data', () => {
    const { db, dispose } = makeDb();
    try {
      const rows = fetchBatch(db, 0, 100);
      // M2（fromMe）/M13（纯 mov）/M14（空）被 SQL 过滤；M12 扇出 2 行
      expect(rows.map((r) => r.guid)).toEqual([
        'M1',
        'M3',
        'M4',
        'M5',
        'M6',
        'M7',
        'M8',
        'M9',
        'M10',
        'M11',
        'M12',
        'M12',
      ]);
      const m1 = rows[0]!;
      expect(m1.handleText).toBe('+8613800000000');
      expect(m1.service).toBe('iMessage');
      expect(m1.chatGuid).toBe('CHAT-ONE');
      expect(m1.isFromMe).toBe(0);
    } finally {
      dispose();
    }
  });

  it('carries date as a lossless decimal string', () => {
    const { db, dispose } = makeDb();
    try {
      const rows = fetchBatch(db, 0, 100);
      expect(rows[0]!.dateNs).toBe('815743613388000000');
      // 字符串可无损走 BigInt（后续 normalize 的转换入口）
      expect(BigInt(rows[0]!.dateNs)).toBe(815743613388000000n);
    } finally {
      dispose();
    }
  });

  it('carries attributedBody BLOB bytes through', () => {
    const { db, dispose } = makeDb();
    try {
      const rows = fetchBatch(db, 0, 100);
      const m3 = rows.find((r) => r.guid === 'M3')!;
      expect(m3.text).toBeNull();
      expect(m3.attributedBody).toBeInstanceOf(Uint8Array);
      expect(Array.from(m3.attributedBody!)).toEqual([0x01, 0x02]);
    } finally {
      dispose();
    }
  });

  it('exposes member count for group-chat filtering downstream', () => {
    const { db, dispose } = makeDb();
    try {
      const rows = fetchBatch(db, 0, 100);
      const single = rows.find((r) => r.guid === 'M1')!;
      const group = rows.find((r) => r.guid === 'M4')!;
      expect(single.memberCount).toBe(1);
      expect(group.memberCount).toBe(2);
    } finally {
      dispose();
    }
  });

  it('joins quoted message text via thread_originator_guid', () => {
    const { db, dispose } = makeDb();
    try {
      const rows = fetchBatch(db, 0, 100);
      const m5 = rows.find((r) => r.guid === 'M5')!;
      expect(m5.quotedText).toBe('hello');
      expect(m5.quotedDateNs).toBe('815743613388000000');
    } finally {
      dispose();
    }
  });

  it('joins attachment path, mime type, name and bytes', () => {
    const { db, dispose } = makeDb();
    try {
      const rows = fetchBatch(db, 0, 100);
      const m6 = rows.find((r) => r.guid === 'M6')!;
      expect(m6.attachmentPath).toBe('/tmp/IMG_0001.heic');
      expect(m6.attachmentMime).toBe('image/heic');
      expect(m6.attachmentName).toBe('IMG_0001.heic');
      expect(m6.attachmentBytes).toBe(546000);
    } finally {
      dispose();
    }
  });

  it('admits only completed non-sticker attachments with a filename', () => {
    const { db, dispose } = makeDb();
    try {
      const rows = fetchBatch(db, 0, 100);
      const byGuid = new Map(rows.map((r) => [r.guid, r]));
      // 未完成（M7）/贴纸（M8）/无 filename（M9）：消息照返、附件字段空
      for (const guid of ['M7', 'M8', 'M9']) {
        expect(byGuid.get(guid)!.attachmentPath).toBeNull();
        expect(byGuid.get(guid)!.attachmentName).toBeNull();
        expect(byGuid.get(guid)!.attachmentBytes).toBeNull();
      }
      // 非 image mime 不在 JOIN 准入内（准入只看状态，不看类型）
      expect(byGuid.get('M10')!.attachmentPath).toBe('/tmp/clip.mov');
      expect(byGuid.get('M10')!.attachmentMime).toBe('video/quicktime');
    } finally {
      dispose();
    }
  });

  it('includes image-only messages via the image branch of WHERE', () => {
    const { db, dispose } = makeDb();
    try {
      const rows = fetchBatch(db, 0, 100);
      const m11 = rows.find((r) => r.guid === 'M11')!;
      expect(m11.text).toBeNull();
      expect(m11.attributedBody).toBeNull();
      expect(m11.attachmentPath).toBe('/tmp/solo.png');
    } finally {
      dispose();
    }
  });

  it('respects the cursor (ROWID > afterRowId, ascending)', () => {
    const { db, dispose } = makeDb();
    try {
      const rows = fetchBatch(db, 10, 100);
      expect(rows.map((r) => r.rowid)).toEqual([11, 12, 12]);
      expect(rows.map((r) => r.guid)).toEqual(['M11', 'M12', 'M12']);
    } finally {
      dispose();
    }
  });

  it('applies the row limit (rows, not messages)', () => {
    const { db, dispose } = makeDb();
    try {
      const rows = fetchBatch(db, 0, 2);
      expect(rows).toHaveLength(2);
    } finally {
      dispose();
    }
  });
});

describe('readMaxRowId', () => {
  it('returns the max ROWID over ALL messages (watermark incl. own sends)', () => {
    const { db, dispose } = makeDb();
    try {
      // 全库最大是 14（M14），不是对方消息的最大——水位必须盖住 fromMe 行，
      // 否则下轮会把它们拉出来再滤一次
      expect(readMaxRowId(db)).toBe(14);
    } finally {
      dispose();
    }
  });

  it('returns undefined on an empty message table', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    try {
      expect(readMaxRowId(db)).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe('assertSchema', () => {
  it('passes on the expected schema', () => {
    const { db, dispose } = makeDb();
    try {
      expect(() => assertSchema(db)).not.toThrow();
    } finally {
      dispose();
    }
  });

  it('names the missing pieces when columns are absent', () => {
    const db = new DatabaseSync(':memory:');
    // 缺 attributedBody 列的 message 表
    db.exec(`CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT,
      is_from_me INTEGER, handle_id INTEGER, date INTEGER,
      thread_originator_guid TEXT)`);
    db.exec(`CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, style INTEGER)`);
    db.exec(`CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT)`);
    try {
      expect(() => assertSchema(db)).toThrow(ChatDbSchemaError);
      try {
        assertSchema(db);
      } catch (err) {
        expect((err as ChatDbSchemaError).missing).toContain('message.attributedBody');
      }
    } finally {
      db.close();
    }
  });
});

describe('openChatDb', () => {
  it('opens a real file database read-only after schema check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-imessage-chatdb-'));
    const file = join(dir, 'chat.db');
    try {
      const seed = new DatabaseSync(file);
      seed.exec(SCHEMA_SQL);
      seed.close();

      const db = openChatDb(file);
      try {
        expect(readMaxRowId(db)).toBeUndefined();
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a file without the expected schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-imessage-chatdb-'));
    const file = join(dir, 'empty.db');
    try {
      const seed = new DatabaseSync(file);
      seed.exec('CREATE TABLE unrelated(x)');
      seed.close();
      expect(() => openChatDb(file)).toThrow(ChatDbSchemaError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
