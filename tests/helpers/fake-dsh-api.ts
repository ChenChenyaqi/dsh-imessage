// fake DSH 宿主（A 路线 / webhook 范式）——Step 2 适配层测试的宿主模拟器。
//
// 规格由 tests/host/dsh-api.test.ts 固化（测试先行）：事件序列保真到
// 探针实测顺序，接口签名对齐 src/host/dsh-api.ts 的宿主类型（回调
// 两参/对象 payload 一致），适配层代码可在 fake 与真宿主间无差异复用。
//
// 与真宿主的已知差距（不影响适配层逻辑）：
// - 不发射 create 三件套（permission/sandbox/approval）与 request/* 事件
//   （适配层不消费）；
// - llm/retry-started、step/start、user/message 等未发射（同上）；
// - 失败尝试不带真实退避延迟（delayMs 仅是事件字段值）。

import { randomUUID } from 'node:crypto';
import { asHostMessageId, asHostSessionId } from '@/host/dsh-api';
import type {
  HostAgent,
  HostAgentCancelCause,
  HostAgentHandle,
  HostAgentsService,
  HostBareAgent,
  HostSessionObject,
  HostAgentDefaultModelService,
  HostAssistantStreamFrame,
  HostCreateAgentInput,
  HostEventName,
  HostEventPayloads,
  HostLlmFailure,
  HostRenameResult,
  HostSessionEvent,
  HostSessionId,
  HostSessionTitleService,
  HostStreamChunk,
  HostUserMessage,
  HostWorkspace,
  HostWorkspaceRegistry,
} from '@/host/dsh-api';

// ---------------------------------------------------------------------------
// 脚本模型
// ---------------------------------------------------------------------------

/** 成功回复脚本：text 拆两半按序发 text-delta。 */
interface ReplyScript {
  readonly kind: 'reply';
  readonly text: string;
  /** 帧间停顿（ms）：给 cancel 留出打断窗口；默认 0（仅宏任务间隙）。 */
  readonly chunkPauseMs: number;
}

/** 失败脚本：N 次 attempt（探针模式：N-1 次 llm/retry），turn/end error。 */
interface FailureScript {
  readonly kind: 'failure';
  readonly attempts: number;
  readonly failure: HostLlmFailure;
}

/**
 * 卡死脚本：开 turn、吐半截字幕，但**永不发 turn/end**。
 * 模拟真机事故（2026-11-12）：事件参数形状不匹配时流永不收口，
 * 通道被单条消息永久堵死。
 */
interface HangScript {
  readonly kind: 'hang';
  readonly text: string;
}

type Script = ReplyScript | FailureScript | HangScript;

/** fake 对外的调用台账（断言用）。 */
export interface FakeHostLogEntry {
  readonly kind: string;
  readonly [key: string]: unknown;
}

export interface FakeDshHost {
  /** 释放一个活会话（测试模拟宿主重启：活句柄消失、持久层仍在）。 */
  disposeAgent(sessionId: string): Promise<void>;
  readonly services: {
    readonly agents: HostAgentsService;
    readonly workspaceRegistry: HostWorkspaceRegistry;
    readonly agentDefaultModel: HostAgentDefaultModelService;
    readonly sessionTitle: HostSessionTitleService;
    /** 最近一次 agents.create 的 meta（preset 断言用）。 */
    readonly agentsCreateMeta: { lastCreateMeta: Record<string, unknown> | undefined };
    /** 默认自带的 agentPresets 最小面（preset 全链路用例）。 */
    readonly agentPresets: {
      resolve(id?: string): Promise<{ id: string }>;
      mount(ctx: unknown, id: string): Promise<unknown>;
    };
  };
  /** 对齐 ctx.on 的事件订阅：返回卸载函数。 */
  on<E extends HostEventName>(event: E, listener: (...args: HostEventPayloads[E]) => void): () => void;
  /** 手动发射一条持久事件（测试自定义事件用）。 */
  emitSessionEvent(type: string, data: Record<string, unknown>, sessionId?: string): void;
  /** 编排 followup 后的成功回复（FIFO 消耗）。 */
  scriptReply(input: { readonly text: string; readonly chunkPauseMs?: number }): void;
  /** 编排 followup 后的失败收场（探针实测模式）。 */
  scriptFailure(input: { readonly attempts: number; readonly failure: HostLlmFailure }): void;
  /** 下一轮永不收口（只发 turn/start + 半截字幕，不发 turn/end）。 */
  scriptHang(input: { readonly text: string }): void;
  /** 下一次 agents.create 抛错（一次性）。 */
  failNextCreate(error: Error): void;
  /** 下一次 workspace.attachSession 抛错（一次性，适配层回滚测试用）。 */
  failNextAttach(error: Error): void;
  /** 下一次 agents.resume 抛错（一次性，非 NotFound 类错误注入用）。 */
  failNextResume(error: Error): void;
  /** 当前某事件的监听器数（验证适配层卸载干净）。 */
  listenerCount(event: HostEventName): number;
  /** 模型选择（agents.create 未带 agentOptions 时的兜底源）。 */
  setModelSelection(selection: { readonly provider: string; readonly model: string }): void;
  /** 归档集（可变；registry.archivedSessionIds 是同一引用的只读视图）。 */
  readonly archivedSessionIds: HostSessionId[];
  readonly log: FakeHostLogEntry[];
  /** mount 调用记录（按序）。 */
  readonly presetMounts: ReadonlyArray<{ id: string }>
}

/** 构造 followup 入参消息（与真宿主的 UserMessage 形状一致，含 role）。 */
export function userText(text: string): HostUserMessage {
  return {
    id: asHostMessageId(randomUUID()),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

interface AgentRecord {
  handle: HostAgentHandle;
  /** 当前提问的收口控制器：脚本收口（完成/失败/中止）时 resolve。 */
  idleWaiters: Array<() => void>;
  cancelRequested: HostAgentCancelCause | undefined;
  run: Promise<void> | undefined;
  status: 'idle' | 'running';
  turn: number;
}

export function makeFakeDshHost(): FakeDshHost {
  const servicesMeta: { lastCreateMeta: Record<string, unknown> | undefined } = {
    lastCreateMeta: undefined,
  };
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const agents = new Map<HostSessionId, AgentRecord>();
  /** 模拟持久层：dispose 后会话仍存在（可 resume 复活）。 */
  const persistedSessions = new Set<HostSessionId>();
  const scripts: Script[] = [];
  const workspaces: HostWorkspace[] = [];
  const archivedSessionIds: HostSessionId[] = [];
  const log: FakeHostLogEntry[] = [];
  let failNext: Error | undefined;
  let failNextAttach: Error | undefined;
  let failNextResume: Error | undefined;
  let modelSelection = { provider: 'fake-provider', model: 'fake-model' };
  let eventSeq = 0;

  // -- 事件总线 -----------------------------------------------------------

  function emit(event: HostEventName, ...args: unknown[]): void {
    const set = listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) listener(...args);
  }

  function on<E extends HostEventName>(
    event: E,
    listener: (...args: HostEventPayloads[E]) => void,
  ): () => void {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    const entry = listener as (...args: unknown[]) => void;
    set.add(entry);
    return () => set.delete(entry);
  }

  // 真宿主事实（源码 + 官方类型）：事件参数是对象不是字符串——
  // session/event 首参 Session 对象（.id），assistant-stream/status/error
  // 的 agent 是 Agent 对象（.id）。fake 必须同样传对象，否则"字符串比较"
  // 这类 bug 在单测里全绿、真机全废（2026-11-12 真实事故）。
  function sessionRef(sessionId: HostSessionId): HostSessionObject {
    return { id: sessionId } as unknown as HostSessionObject;
  }
  function agentRef(sessionId: HostSessionId): HostBareAgent {
    return { id: sessionId } as unknown as HostBareAgent;
  }

  function sessionEvent(type: string, data: Record<string, unknown>, sessionId: HostSessionId): void {
    const event = { type, seq: eventSeq++, data } as HostSessionEvent;
    emit('session/event', sessionRef(sessionId), event);
  }

  function streamFrame(sessionId: HostSessionId, frame: HostAssistantStreamFrame): void {
    emit('agent/assistant-stream', { agent: agentRef(sessionId), frame });
  }

  // -- followup 脚本执行 ---------------------------------------------------

  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      if (ms > 0) setTimeout(resolve, ms);
      else setImmediate(resolve);
    });

  async function runScript(record: AgentRecord, script: Script, message: HostUserMessage): Promise<void> {
    const sessionId = record.handle.agent.session.id;
    const turn = ++record.turn;
    // 真宿主事实：cancel 只作用于**当前活动 turn**；上一轮遗留的取消标记
    // 不能泄漏到新一轮（否则被取消/超时过的一次问话会连带取消下一次）
    record.cancelRequested = undefined;
    record.status = 'running';
    emit('agent/status', { agent: agentRef(sessionId), status: 'running' });

    // 入箱 + 开 turn + 领取（探针实测顺序）
    sessionEvent('agent/inbox/spliced', { target: 'inbox', start: 0, inserted: [message] }, sessionId);
    sessionEvent('turn/start', { turn }, sessionId);
    sessionEvent('agent/inbox/spliced', { target: 'turn', start: 0, removedCount: 1, inserted: [] }, sessionId);

    const cancelled = () => record.cancelRequested !== undefined;

    const finishTurn = (reason: unknown, extra?: () => void) => {
      extra?.();
      sessionEvent('turn/end', { turn, reason }, sessionId);
      record.status = 'idle';
      emit('agent/status', { agent: agentRef(sessionId), status: 'idle' });
      for (const resolve of record.idleWaiters.splice(0)) resolve();
    };

    if (script.kind === 'hang') {
      streamFrame(sessionId, { type: 'start', attemptId: randomUUID(), revision: 1, turn, step: 1 });
      streamFrame(sessionId, {
        type: 'chunk',
        chunk: { type: 'text-delta', text: script.text },
      } as HostAssistantStreamFrame);
      // 刻意不主动收口；只有被 cancel 时才像真宿主那样以 aborted 收尾
      while (!cancelled()) await pause(5);
      finishTurn({ kind: 'aborted' });
      return;
    }

    if (script.kind === 'reply') {
      const attemptId = randomUUID();
      streamFrame(sessionId, { type: 'start', attemptId, revision: 1, turn, step: 1 });
      const halves = splitInHalf(script.text);
      for (const text of halves) {
        const chunk: HostStreamChunk = { type: 'text-delta', index: 0, text };
        streamFrame(sessionId, { type: 'chunk', attemptId, revision: 1, index: 0, chunk });
        await pause(script.chunkPauseMs);
        if (cancelled()) break;
      }
      if (cancelled()) {
        // 源码事实（abort）：中止后流收口为 end，turn 以 aborted 结束
        streamFrame(sessionId, { type: 'end', attemptId, revision: 1, index: 0, outcome: { kind: 'abandoned' } });
        finishTurn({ kind: 'aborted', reason: record.cancelRequested });
        record.cancelRequested = undefined;
        return;
      }
      const finish: HostStreamChunk = { type: 'finish', reason: 'stop' };
      streamFrame(sessionId, { type: 'chunk', attemptId, revision: 1, index: 1, chunk: finish });
      const messageSeq = eventSeq + 1;
      streamFrame(sessionId, {
        type: 'end',
        attemptId,
        revision: 1,
        index: 2,
        outcome: { kind: 'committed', eventType: 'assistant/message', seq: messageSeq },
      });
      finishTurn(
        { kind: 'completed' },
        () =>
          sessionEvent(
            'assistant/message',
            { turn, step: 1, message: { content: [{ type: 'text', text: script.text }] } },
            sessionId,
          ),
      );
      return;
    }

    // 失败脚本：探针实测模式（N attempt + N-1 retry，最后 turn/end error）
    for (let attempt = 1; attempt <= script.attempts; attempt += 1) {
      const attemptId = randomUUID();
      streamFrame(sessionId, { type: 'start', attemptId, revision: attempt, turn, step: 1 });
      await pause(0);
      if (cancelled()) {
        streamFrame(sessionId, { type: 'end', attemptId, revision: attempt, index: 0, outcome: { kind: 'abandoned' } });
        finishTurn({ kind: 'aborted', reason: record.cancelRequested });
        record.cancelRequested = undefined;
        return;
      }
      const finish: HostStreamChunk = { type: 'finish', reason: 'error' };
      streamFrame(sessionId, { type: 'chunk', attemptId, revision: attempt, index: 0, chunk: finish });
      const attemptSeq = eventSeq + 1;
      streamFrame(sessionId, {
        type: 'end',
        attemptId,
        revision: attempt,
        index: 1,
        outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: attemptSeq },
      });
      sessionEvent('assistant/attempt', { turn, step: 1 }, sessionId);
      if (attempt < script.attempts) {
        // 非最终失败：安排一次重试（探针：attempt 与 retry 交替，最后一次不 retry）
        sessionEvent(
          'llm/retry',
          {
            retryId: randomUUID(),
            turn,
            step: 1,
            retry: attempt,
            maxRetries: script.attempts - 1,
            delayMs: 500,
            failure: script.failure,
          },
          sessionId,
        );
      }
      await pause(0);
    }
    finishTurn({ kind: 'error', error: script.failure }, () => {
      // agent/error 事件与 turn 收口同步发生（探针：LlmError + message）
      emit('agent/error', {
        agent: agentRef(sessionId),
        turn,
        step: 1,
        error: { name: 'LlmError', message: script.failure.message, code: script.failure.code },
      });
    });
  }

  // -- agents 服务 ---------------------------------------------------------

  const agentsService: HostAgentsService = {
    async create(input: HostCreateAgentInput): Promise<HostAgentHandle> {
      if (failNext) {
        const error = failNext;
        failNext = undefined;
        throw error;
      }
      const sessionId = input.sessionId ?? `session-${randomUUID()}`;
      if (agents.has(sessionId)) {
        // 探针实测：进程内面对活会话 create 是硬错误，复用需先 get
        throw new Error(`session "${sessionId}" already exists`);
      }
      log.push({
        kind: 'agents.create',
        sessionId,
        options: input.agentOptions ?? modelSelection,
        ...(input.meta === undefined ? {} : { meta: input.meta }),
        setupRan: false,
      });
      servicesMeta.lastCreateMeta = input.meta as Record<string, unknown> | undefined;
      if (typeof input.setup === 'function') {
        // 真宿主事实：setup 在注册表发布前执行（组合挂载的唯一时机）
        await input.setup({ fake: 'agent-context' } as never);
        const row = log[log.length - 1] as typeof log[number] & { setupRan?: boolean };
        if (row && 'setupRan' in row) row.setupRan = true;
      }
      const record: AgentRecord = {
        handle: undefined as unknown as AgentRecord['handle'],
        idleWaiters: [],
        cancelRequested: undefined,
        run: undefined,
        status: 'idle',
        turn: 0,
      };
      const fakeSession = { id: sessionId } as unknown as HostSessionObject;
      // 真宿主事实：get 返回的对象即增强 Agent 本体（= handle.agent），
      // 官方类型只承诺 {id}；fake 同样在本体上直接挂 id
      const agent: HostAgent & { id: HostSessionId } = {
        id: sessionId,
        session: fakeSession,
        get status() {
          return record.status;
        },
        followup(message: HostUserMessage): void {
          const script = scripts.shift() ?? { kind: 'reply', text: '', chunkPauseMs: 0 };
          const first = message.content[0];
          const text = first !== undefined && 'text' in first ? first.text : '';
          log.push({ kind: 'agent.followup', sessionId, text });
          record.run = runScript(record, script, message).finally(() => {
            record.run = undefined;
          });
        },
        cancel(cause: HostAgentCancelCause): void {
          log.push({ kind: 'agent.cancel', sessionId, cause: cause.kind });
          record.cancelRequested = cause;
        },
        whenIdle(): Promise<void> {
          if (record.status === 'idle' && record.run === undefined) return Promise.resolve();
          return new Promise<void>((resolve) => {
            record.idleWaiters.push(resolve);
          });
        },
      };
      record.handle = {
        agent,
        async dispose() {
          agents.delete(sessionId);
          persistedSessions.add(sessionId);
          log.push({ kind: 'agents.dispose', sessionId });
        },
      };
      agents.set(sessionId, record);
      persistedSessions.add(sessionId); // 创建即持久化（对齐真宿主：会话日志落盘）
      return record.handle;
    },
    get(sessionId: HostSessionId): HostBareAgent | undefined {
      // 对齐官方类型事实：返回增强 Agent 本体（类型收窄为判活面）
      return agents.get(sessionId)?.handle.agent as unknown as HostBareAgent;
    },
    async resume(input: { resumeSessionId: HostSessionId }): Promise<HostAgentHandle> {
      log.push({ kind: 'agents.resume', sessionId: input.resumeSessionId });
      if (failNextResume) {
        const error = failNextResume;
        failNextResume = undefined;
        throw error;
      }
      const sessionId = input.resumeSessionId;
      const existing = agents.get(sessionId);
      if (existing) return existing.handle; // 已活：幂等返回（探针实测 ok）
      if (!persistedSessions.has(sessionId)) {
        // 探针实测：不存在时扌 SessionPersistenceNotFoundError（判 missing 依据）
        const error = new Error(`session "${sessionId}" not found`) as Error & { name: string };
        error.name = 'SessionPersistenceNotFoundError';
        throw error;
      }
      // 冷会话复活：重建活句柄，同 id（探针实测 sameSession true）
      return agentsService.create({ sessionId });
    },
  };

  // -- workspace / 模型 / 标题 ----------------------------------------------

  const workspaceRegistry: HostWorkspaceRegistry = {
    async create(absolutePath: string): Promise<HostWorkspace> {
      const sessionIds: HostSessionId[] = [];
      const workspace: HostWorkspace = {
        path: absolutePath,
        get sessionIds() {
          return [...sessionIds];
        },
        async attachSession(sessionId) {
          if (failNextAttach) {
            const error = failNextAttach;
            failNextAttach = undefined;
            throw error;
          }
          if (!sessionIds.includes(sessionId)) sessionIds.push(sessionId);
          log.push({ kind: 'workspace.attachSession', path: absolutePath, sessionId });
        },
        async detachSession(sessionId) {
          const index = sessionIds.indexOf(sessionId);
          if (index >= 0) sessionIds.splice(index, 1);
          log.push({ kind: 'workspace.detachSession', path: absolutePath, sessionId });
        },
      };
      workspaces.push(workspace);
      log.push({ kind: 'workspaceRegistry.create', path: absolutePath });
      return workspace;
    },
    get archivedSessionIds(): ReadonlyArray<HostSessionId> {
      return archivedSessionIds;
    },
  };

  const agentDefaultModel: HostAgentDefaultModelService = {
    currentSelection() {
      return { ...modelSelection };
    },
  };

  const sessionTitle: HostSessionTitleService = {
    rename(session, title): HostRenameResult {
      const result: HostRenameResult = {
        title,
        messageSeqs: [],
        source: { kind: 'user' },
        eventSeq: eventSeq++,
        updatedAt: Date.now(),
      };
      log.push({ kind: 'sessionTitle.rename', sessionId: session.id, title });
      return result;
    },
  };

  const services: {
    agents: HostAgentsService;
    workspaceRegistry: HostWorkspaceRegistry;
    agentDefaultModel: HostAgentDefaultModelService;
    sessionTitle: HostSessionTitleService;
    agentsCreateMeta: { lastCreateMeta: Record<string, unknown> | undefined };
    agentPresets: { resolve(id?: string): Promise<{ id: string }>; mount(ctx: unknown, id: string): Promise<unknown> };
  } = { agents: agentsService, workspaceRegistry, agentDefaultModel, sessionTitle, agentsCreateMeta: servicesMeta, agentPresets: defaultPresets() };
  // 默认带 agentPresets 最小面（preset 全链路用例；注入失败走 dsh-port 测试）
  const presetMounts: Array<{ id: string }> = [];
  function defaultPresets() {
    return {
      resolve: async (id?: string) => ({ id: id ?? 'host-default' }),
      mount: async (_ctx: unknown, id: string) => {
        presetMounts.push({ id });
        return undefined;
      },
    };
  }

  return {
    services,
    presetMounts,
    on,
    async disposeAgent(sessionId: string) {
      const record = agents.get(asHostSessionId(sessionId));
      if (record) await record.handle.dispose();
    },
    emitSessionEvent(type, data, sessionId) {
      sessionEvent(type, data, asHostSessionId(sessionId ?? '(manual)'));
    },
    scriptReply(input) {
      scripts.push({ kind: 'reply', text: input.text, chunkPauseMs: input.chunkPauseMs ?? 0 });
    },
    scriptFailure(input) {
      scripts.push({ kind: 'failure', ...input });
    },
    scriptHang(input) {
      scripts.push({ kind: 'hang', text: input.text });
    },
    failNextCreate(error) {
      failNext = error;
    },
    failNextAttach(error) {
      failNextAttach = error;
    },
    failNextResume(error) {
      failNextResume = error;
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
    setModelSelection(selection) {
      modelSelection = { ...selection };
    },
    archivedSessionIds,
    log,
  };
}

/** 把文本拆成两半作为增量 chunk（空串得到两个空串，序列形状不变）。 */
function splitInHalf(text: string): [string, string] {
  const mid = Math.floor(text.length / 2);
  return [text.slice(0, mid), text.slice(mid)];
}
