// DSH 宿主服务类型子集（A 路线 / webhook 范式）。
//
// 这是 DshPort 适配层（host/dsh-port.ts）依赖的 cordis 服务面：
// 进程内直接方法调用 + ctx.on 事件，无 RPC 序列化。接口按
// 「只放适配层会消费的成员」裁剪。
//
// 事实来源（D7：实测优先）：
// - docs/host-api-facts-plugin.md / -ask.md / -rpc.md（源码级事实，带行号）
// - /tmp/dsh-probe 两轮真机探针（行为语义互证）
// 差异点已标注「未实测」处，M4 联调时互证。

// ---------------------------------------------------------------------------
// 基础值
// ---------------------------------------------------------------------------

/** 宿主侧会话 id：plain string（branded 转换在 dsh-port 适配层完成）。 */
/** 宿主 SessionId（官方 branded 类型；与 core 的 brand 不同，跨层 as 转换）。 */
export type HostSessionId = import('@deepseek-ai/dsh-session').SessionId;

/** 宿主 MessageId（dsh-llm brand；构造时 as 转换）。 */
export type HostMessageId = import('@deepseek-ai/dsh-llm/brand').MessageId;

/** 活会话引用（官方 Session 对象，id 在 .id 字段；探针实测）。 */
export type HostSessionObject = import('@deepseek-ai/dsh-session').Session;

/** 模型选择（agentOptions；探针：agents.create 必带，无默认兜底）。 */
export interface HostAgentOptions {
  readonly provider: string;
  readonly model: string;
  readonly maxTokens?: number;
}

/** LLM 结构化失败（源码事实：message + 中性稳定码，如 TRANSPORT/TIMEOUT）。 */
export interface HostLlmFailure {
  readonly message: string;
  readonly code: string;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 持久会话事件（ctx.on('session/event', (session, event) => ...)）
// ---------------------------------------------------------------------------

/** turn 收口原因（源码事实：五态 + 插件可扩展）。 */
export type HostTurnEndReason =
  | { readonly kind: 'completed' }
  | { readonly kind: 'aborted'; readonly reason: unknown }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'error'; readonly error: HostLlmFailure }
  | { readonly kind: 'max-tokens' };

/** 适配层消费的持久事件判别联合；type 为其余值时落到兜底分支。 */
export type HostSessionEvent =
  | { readonly type: 'turn/start'; readonly seq: number; readonly data: { readonly turn: number } }
  | {
      readonly type: 'turn/end';
      readonly seq: number;
      readonly data: { readonly turn: number; readonly reason: HostTurnEndReason };
    }
  | {
      readonly type: 'assistant/message';
      readonly seq: number;
      readonly data: {
        readonly turn: number;
        readonly step: number;
        readonly message: { readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }> };
        readonly interrupted?: boolean;
      };
    }
  | {
      readonly type: 'assistant/attempt';
      readonly seq: number;
      readonly data: { readonly turn: number; readonly step: number };
    }
  | {
      readonly type: 'llm/retry';
      readonly seq: number;
      readonly data: {
        readonly retryId: string;
        readonly turn: number;
        readonly step: number;
        readonly retry: number;
        readonly maxRetries: number;
        readonly delayMs: number;
        readonly failure: HostLlmFailure;
      };
    }
  | { readonly type: string; readonly seq: number; readonly data: Readonly<Record<string, unknown>> };

// ---------------------------------------------------------------------------
// token 级流帧（ctx.on('agent/assistant-stream', ({ agent, frame }) => ...)）
// ---------------------------------------------------------------------------

/** 流 chunk：适配层只关心 text-delta（增量拼接）与 finish；其余宽松。 */
export type HostStreamChunk =
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'finish'; readonly reason: string }
  | { readonly type: string; readonly [key: string]: unknown };

/** 尝试收口：committed 指明固化为哪个持久事件。 */
export type HostStreamOutcome =
  | { readonly kind: 'committed'; readonly eventType: 'assistant/message' | 'assistant/attempt'; readonly seq: number }
  | { readonly kind: 'abandoned' };

export type HostAssistantStreamFrame =
  | { readonly type: 'start'; readonly attemptId: string; readonly revision: number; readonly turn: number; readonly step: number }
  | {
      readonly type: 'chunk';
      readonly attemptId: string;
      readonly revision: number;
      readonly index: number;
      readonly chunk: HostStreamChunk;
    }
  | { readonly type: 'end'; readonly attemptId: string; readonly revision: number; readonly index: number; readonly outcome: HostStreamOutcome };

// ---------------------------------------------------------------------------
// 入会消息（agent.followup 入参；探针/源码事实：fire-and-forget）
// ---------------------------------------------------------------------------

export interface HostTextBlock {
  readonly type: 'text';
  readonly text: string;
}

/** 用户消息（官方 UserMessage；探针实测：缺 role:'user' 的消息 resume 时
 *  报 SessionPersistenceCorruptionError，构造时必带 role）。 */
export type HostUserMessage = import('@deepseek-ai/dsh-llm/types').UserMessage;

/** 取消原因（源码事实：user/parent/hook/disposed 四态；具体形态对适配层不透明）。 */
export type HostAgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: unknown }
  | { readonly kind: 'disposed' };

export interface HostCancelOptions {
  /** true 保留排队输入；默认 false 清空（源码事实）。 */
  readonly keepInbox?: boolean;
}

// ---------------------------------------------------------------------------
// Agent 服务（ctx.agents）
// ---------------------------------------------------------------------------

export interface HostCreateAgentInput {
  /** 探针：对已存在的活会话是硬错误（already exists），复用需先 get。
   * 官方类型必填（探针一致：创建必带 sessionId）。 */
  readonly sessionId: HostSessionId;
  readonly meta?: { readonly cwd?: string; readonly agentPreset?: string };
  readonly agentOptions?: HostAgentOptions;
}

export interface HostAgent {
  /** 探针实测：是 Session 对象（不是 id 字符串），id 在 .id。 */
  readonly session: HostSessionObject;
  /** 探针：只有 idle/running 两态，翻转沿各发一次事件。 */
  readonly status: 'idle' | 'running';
  /** 入队一条用户消息并独占一个 turn；无返回值（源码事实：fire-and-forget）。 */
  followup(message: HostUserMessage): void;
  /** 中止活动 turn；keepInbox 决定是否清空排队输入。 */
  cancel(cause: HostAgentCancelCause, options?: HostCancelOptions): void;
  /** 静默等待：idle 立即 resolve；running 等收敛（含取消后的收敛）。 */
  whenIdle(): Promise<void>;
}

export interface HostAgentHandle {
  readonly agent: HostAgent;
  dispose(): Promise<void>;
}

/** 裸 Agent 最小面（官方类型事实：agents.get 只承诺 Agent，handle 仅创建者可见；
 * 我们仅用它判活）。 */
export interface HostBareAgent {
  readonly id: HostSessionId;
}

export interface HostAgentsService {
  create(input: HostCreateAgentInput): Promise<HostAgentHandle>;
  /** 活会话判活；不存在返回 undefined（探针实测；官方类型只承诺裸 Agent）。 */
  get(sessionId: HostSessionId): HostBareAgent | undefined;
  /** 冷会话恢复（探针实测：持久存在则恢复同 id 活句柄；不存在抛
   *  SessionPersistenceNotFoundError —— 适配层判 missing 的依据）。 */
  resume(input: { readonly resumeSessionId: HostSessionId }): Promise<HostAgentHandle>;
}

// ---------------------------------------------------------------------------
// Workspace（ctx.workspaceRegistry）
// ---------------------------------------------------------------------------

export interface HostWorkspace {
  readonly path: string;
  readonly sessionIds: ReadonlyArray<HostSessionId>;
  attachSession(sessionId: HostSessionId): Promise<void>;
  detachSession(sessionId: HostSessionId): Promise<void>;
}

export interface HostWorkspaceRegistry {
  /** 探针：要求目录预先存在（realpath 校验），适配层负责 mkdir。 */
  create(absolutePath: string): Promise<HostWorkspace>;
  /** 探针：可直读的持久归档集；includes 判归档（getSessionStatus 数据源）。 */
  readonly archivedSessionIds: ReadonlyArray<HostSessionId>;
}

// ---------------------------------------------------------------------------
// 模型选择与会话标题
// ---------------------------------------------------------------------------

export interface HostAgentDefaultModelService {
  currentSelection(): HostAgentOptions;
}

/** 探针实测返回形状（同步调用）。 */
/** 标题来源（官方 SessionTitleSource：fallback/provider/user 三态）。 */
export type HostTitleSource = import('@deepseek-ai/dsh-session-title').SessionTitleSource;

export interface HostRenameResult {
  readonly title: string;
  readonly messageSeqs: ReadonlyArray<number>;
  readonly source: HostTitleSource;
  readonly eventSeq: number;
  readonly updatedAt: number;
}

export interface HostSessionTitleService {
  /** 探针实测：首参传 Session 对象（webhook 同款用法）。 */
  rename(session: HostSessionObject, title: string): HostRenameResult;
}

// ---------------------------------------------------------------------------
// 事件面（host.on 的 payload 签名，对齐真宿主 ctx.on）
// ---------------------------------------------------------------------------

export interface HostEventPayloads {
  /** 两参回调；首参是 **Session 对象**（不是 id 字符串）——
   *  官方签名 `(session: Session, event: SessionEvent)`。
   *  2026-11-12 事故：按字符串比较导致 turn/end 永不匹配、流永不收口。 */
  'session/event': [session: HostSessionObject, event: HostSessionEvent];
  /** `{ agent: Agent; frame }`——agent 是 **Agent 对象**（id 在 .id）。 */
  'agent/assistant-stream': [{ agent: HostBareAgent; frame: HostAssistantStreamFrame }];
  'agent/status': [{ agent: HostBareAgent; status: 'idle' | 'running' }];
  /** 官方 error 为 unknown；需要字段时在消费处收窄。 */
  'agent/error': [{ agent: HostBareAgent; turn: number; step: number; error: unknown }];
}

export type HostEventName = keyof HostEventPayloads;

// ---------------------------------------------------------------------------
// branded 转换（官方 brand 与 core brand 标签不同；跨层边界显式 as）
// ---------------------------------------------------------------------------

/** raw string → 宿主 SessionId（branded）。 */
export function asHostSessionId(raw: string): HostSessionId {
  return raw as HostSessionId;
}

/** raw string → 宿主 MessageId（branded）。 */
export function asHostMessageId(raw: string): HostMessageId {
  return raw as HostMessageId;
}
