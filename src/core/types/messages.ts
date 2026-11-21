// NormalizedMessage：M2 解码管道的输出、M3 路由器的输入。
//
// chat.db 的原始行（typedstream 二进制、Mac 绝对时间、多表 JOIN）在 M2
// 全部消化完，进入内核的消息只有这一种标准形态——路由层永远不需要
// 再关心 Apple 的存储细节。

/** 路由器眼中的一条消息（会话键已归一化，见 types/phone.ts）。 */
export interface NormalizedMessage {
  /** chat.db message.guid，全局唯一，幂等去重（seenIds）的主键。 */
  readonly guid: string;
  /** chat.db ROWID，单调递增，增量轮询游标（cursor）的依据。 */
  readonly rowId: number;
  /** 消息时间，epoch 毫秒。实测 chat.db 原始列为 Mac 绝对时间纳
   *  米（2001 epoch，18~19 位，超出 JS 安全整数）；M2 转换必须走
   *  BigInt：Number(macNs / 1_000_000n) + 978_307_200_000。 */
  readonly date: number;
  /** 是否本机发出。防循环的第一道闸：自己发的消息绝不再触发回复。 */
  readonly fromMe: boolean;
  /** 解码后的正文。实测 93% 消息的 text 列为空，正文在
   *  attributedBody BLOB（typedstream），M2 解码以它为主、text 列兜底。 */
  readonly text: string;
  /** 对方号码/邮箱的归一化键，白名单与 sessions 路由都用它。 */
  readonly conversationKey: string;
  /** 引用消息的原文（P1 引用回复用，占位可选）。 */
  readonly quotedText?: string;
  /** 图片/附件元数据（M6.1 收图）。path 保持 chat.db 原始 `~/` 形态，
   *  展开是 media 加载层的职责；无附件消息不设该字段（旧 fixture 零改动）。
   *  媒体策略（image 准入/转码）不在这层——normalize 只管元数据透传。 */
  readonly attachments?: readonly MessageAttachment[];
}

/** 附件元数据（chat.db attachment 行的准入态投影，M6.1）。 */
export interface MessageAttachment {
  /** chat.db 原始路径（`~/Library/Messages/Attachments/…` 波浪号形态）。 */
  readonly path: string;
  /** MIME（mime_type 列；实测少量 null——media 层按非 image 跳过）。 */
  readonly mediaType: string | null;
  /** 展示名（transfer_name，可空）。 */
  readonly name: string | null;
  /** 字节数（total_bytes，可空）。 */
  readonly bytes: number | null;
}

/** 工厂入参：字段与 NormalizedMessage 同构但整体不可变约束未施加。 */
export type NormalizedMessageInput = NormalizedMessage;

/** 形状守卫：外来数据（fixture、测试、防御性边界）是否像一条合法消息。 */
export function isNormalizedMessage(value: unknown): value is NormalizedMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.guid === 'string' &&
    v.guid !== '' &&
    typeof v.rowId === 'number' &&
    Number.isInteger(v.rowId) &&
    typeof v.date === 'number' &&
    typeof v.fromMe === 'boolean' &&
    typeof v.text === 'string' &&
    typeof v.conversationKey === 'string' &&
    v.conversationKey !== '' &&
    (v.quotedText === undefined || typeof v.quotedText === 'string') &&
    (v.attachments === undefined || isMessageAttachmentList(v.attachments))
  );
}

/** 附件数组形状守卫（isNormalizedMessage 子项）。 */
function isMessageAttachmentList(value: unknown): value is readonly MessageAttachment[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (a) =>
      typeof a === 'object' &&
      a !== null &&
      typeof (a as MessageAttachment).path === 'string' &&
      (a as MessageAttachment).path !== '' &&
      ((a as MessageAttachment).mediaType === null ||
        typeof (a as MessageAttachment).mediaType === 'string') &&
      ((a as MessageAttachment).name === null ||
        typeof (a as MessageAttachment).name === 'string') &&
      ((a as MessageAttachment).bytes === null ||
        typeof (a as MessageAttachment).bytes === 'number'),
  );
}

/**
 * 构造一条不可变消息。字段类型不对当场抛错（fail loudly），
 * 坏数据绝不带病进入路由层。
 */
export function makeNormalizedMessage(input: NormalizedMessageInput): NormalizedMessage {
  if (!isNormalizedMessage(input)) {
    throw new TypeError(`invalid NormalizedMessage: ${JSON.stringify(input)}`);
  }
  return Object.freeze({ ...input });
}
