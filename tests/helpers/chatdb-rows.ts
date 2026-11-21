// ChatDbRow 测试工厂：字段多且含可空列，pipeline 集成测试用。

import type { ChatDbRow } from '@/core/imessage/chatdb';

/** 只需覆盖关心的字段；默认为一条来自 +8613800000000 的普通文本行。 */
export function makeRow(init: Partial<ChatDbRow> = {}): ChatDbRow {
  return {
    rowid: init.rowid ?? 1,
    guid: init.guid ?? 'row-guid-1',
    text: init.text ?? 'hello there',
    attributedBody: init.attributedBody ?? null,
    dateNs: init.dateNs ?? '755500000000000000',
    isFromMe: init.isFromMe ?? 0,
    handleText: init.handleText ?? '+8613800000000',
    service: init.service ?? 'iMessage',
    chatGuid: init.chatGuid ?? 'iMessage;-;+8613800000000',
    style: init.style ?? 45,
    memberCount: init.memberCount ?? 1,
    attachmentPath: init.attachmentPath ?? null,
    attachmentMime: init.attachmentMime ?? null,
    attachmentName: init.attachmentName ?? null,
    attachmentBytes: init.attachmentBytes ?? null,
    quotedText: init.quotedText ?? null,
    quotedDateNs: init.quotedDateNs ?? null,
    ...init,
  };
}
