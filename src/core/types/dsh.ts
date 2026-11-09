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
}

export interface AskInput {
  readonly sessionId: SessionId;
  readonly prompt: string;
  readonly signal?: AbortSignal;
}

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
