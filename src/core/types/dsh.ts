// DshPort：core 对 DeepSeek Harness 宿主的最小接口契约。
//
// M3 定义接口 + 用 fake 驱动内核；M4 在 host 层用 apiProxy 实现真货。
// 接口面只放内核需要的三件事：开会话、查会话状态、流式提问。
//
// 设计约定：
// - SessionId 为不透明 branded string：DSH 允许调用方自带 id，本插件
//   视其为不透明令牌（不解析格式，去重只需判存在）；
// - 会话 id 由 port 侧生成（DSH API 支持自带 id，但生成权归 port，
//   内核不关心 id 怎么来，见 M3 预绑定事务时序）；
// - ask 以 AsyncIterable<string> 流式产出回复片段，消费方自行拼接；
// - abort 语义：signal 触发后流应当停止产出并抛 abort（真实现遵循
//   DSH 的 abort 传递，fake 在迭代时检查）。

// ---------------------------------------------------------------------------
// 值对象
// ---------------------------------------------------------------------------

/** DSH 会话 id（不透明令牌；branded 防与 guid/号码等普通字符串混淆）。 */
export type SessionId = string & { readonly __brand: 'DshSessionId' };

/** 信任来源的转换（state.json 读回 / fake 构造）。不做格式校验——
 *  id 的合法性由来源保证（DSH 生成或曾经落盘）。 */
export function asSessionId(raw: string): SessionId {
  return raw as SessionId;
}

/** 会话健康状态（懒验证三态；M4 用 workspaceRegistry 实现）。 */
export type SessionStatus = 'active' | 'archived' | 'missing';

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

export interface CreateSessionInput {
  /** 固定工作区（相对数据根路径，state 里持久化的同款）。 */
  readonly workspaceDir: string;
  /** 会话显示名，约定 `imessage <phone>`，仅可读辅助、非安全边界。 */
  readonly name: string;
  /** agent 预设 id（人设组合；缺省 = 宿主默认预设）。 */
  readonly preset?: string;
}

export interface AskInput {
  readonly sessionId: SessionId;
  /** 提问内容：纯文本，或 text/image 内容块（M6.1 收图）。
   *  联合形态（分叉①定案）：系统路径/纯文本调用零改动；图片块由
   *  host 映射为 DSH ImageAttachmentRef（bytes 是 core 自有形态，
   *  DshPort 仍是唯一接缝）。空文本纯图消息不带 text 块（分叉④）。 */
  readonly prompt: string | readonly AskPart[];
  readonly signal?: AbortSignal;
}

/** 纯图消息全失败的占位文本（协议标记，英文同 normalize 占位符惯例；
 *  避免空 prompt/空 content 被宿主拒收或吞掉语义）。 */
export const IMAGE_PLACEHOLDER = '[image]';

/** ask 内容块（core 自有；host 负责映射为宿主块类型）。 */
export type AskPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image';
      readonly bytes: Uint8Array;
      readonly mediaType: import('../imessage/media').DshImageMediaType;
      readonly name?: string;
    };

/** 流式回复：按到达顺序产出的文本片段。 */
export type AskStream = AsyncIterable<string>;

export interface DshPort {
  /** 在指定工作区创建会话，返回其 id。端口实现负责唯一性。 */
  createSession(input: CreateSessionInput): Promise<SessionId>;
  /** 查会话状态（懒验证）。missing = DSH 侧已不存在（删除）。 */
  getSessionStatus(sessionId: SessionId): Promise<SessionStatus>;
  /** 流式提问。signal 中止后停止产出。 */
  ask(input: AskInput): AskStream;
}
