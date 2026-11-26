// 身份上下文文案（M7 分叉②α：systemPrompt.context 管道发布的 note
// 文本；dsh-im 7fe9f4be buildPeerGuidance 的 α 分叉版）。
//
// 与 dsh-im 的差异：无「记名字」指引行——分叉①定案 α 称呼归设置页
// 管，AI 不写文件；「认不出是谁就直说，别瞎猜」保留（防瞎编名字）。
// 文案 zh 硬编码：prompt 是 AI 输入，i18n 层只覆盖出站用户文本
// （M6.3 引用块同款边界）。

/** 称呼注入预算（存储写入侧同用此值截断：超长一律截断，
 *  防单条称呼把 system prompt 上下文撑爆；dsh-im MAX_NAME_LENGTH 同值）。 */
export const MAX_PEER_NAME_LENGTH = 64;

/** note 的输入：handle = conversationKey 归一化键（router 命中时
 *  天然持有）；name = 称呼（可空 = 未知，如实告知 AI）。 */
export interface PeerNoteInput {
  readonly handle: string;
  readonly name?: string | null;
}

/**
 * 她读到的身份段。handle 空白 → ''（空 note = 不发布，注册侧
 * text 回调返回空串即对非目标会话天然不可见）。
 */
export function buildPeerNote({ handle, name }: PeerNoteInput): string {
  const who = handle.trim();
  if (who === '') return '';
  const trimmed = typeof name === 'string' ? name.trim().slice(0, MAX_PEER_NAME_LENGTH) : '';
  const identity = trimmed !== '' ? `${trimmed}（${who}）` : `${who}（还不知道叫什么，可以问）`;
  return [
    `[对话来源] 你正在通过 iMessage 私聊跟一个人说话，对方是${identity}。`,
    '认不出是谁就直说，别瞎猜。',
  ].join('\n');
}
