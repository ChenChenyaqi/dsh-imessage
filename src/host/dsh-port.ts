// DshPort 适配层：宿主服务（A 路线 / webhook 范式）→ core 契约。
//
// 这是内核与 DSH 框架的唯一接缝（M3 定案）：DSH rc 升级的接口漂移
// 只波及本文件与 dsh-api.ts。全部行为依据实测事实（探针互证 + 源码
// 事实，见 docs/host-api-facts-*.md）：
// - createSession：mkdir 先行 → workspace.create → agents.create（必带
//   agentOptions）→ attach → rename（收 Session 对象）；attach/rename
//   失败回滚 dispose（不留孤儿活 agent）
// - getSessionStatus：归档集优先（与活动状态独立）→ 活句柄 → 冷会话
//   resume 试探（SessionPersistenceNotFoundError = missing）
// - ask：text-delta 增量透传；turn/end error → 结构化 code；abort →
//   cancel({kind:'user'}) 后抛 signal 原因；监听器随流结束/中断卸载

import { randomUUID } from 'node:crypto';
import { mkdir as fsMkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { asSessionId } from '@/core/types/dsh';
import type { AskInput, AskStream, DshPort, SessionId, SessionStatus } from '@/core/types/dsh';
import type { HostAgent, HostMessageId, HostSessionId } from '@/host/dsh-api';
import type {
  HostAgentsService,
  HostAgentDefaultModelService,
  HostEventPayloads,
  HostLlmFailure,
  HostSessionEvent,
  HostSessionTitleService,
  HostWorkspaceRegistry,
} from '@/host/dsh-api';

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

/** ask 收场失败（turn/end error）：携带 LLM 中性稳定码供归因与日志。 */
export class DshAskError extends Error {
  readonly code: string;

  constructor(failure: HostLlmFailure) {
    super(failure.message);
    this.name = 'DshAskError';
    this.code = failure.code;
  }
}

// ---------------------------------------------------------------------------
// 依赖
// ---------------------------------------------------------------------------

/** 适配层需要的宿主服务子集（inject 声明与之一致）。 */
export interface DshPortServices {
  readonly agents: HostAgentsService;
  readonly workspaceRegistry: HostWorkspaceRegistry;
  readonly agentDefaultModel: HostAgentDefaultModelService;
  readonly sessionTitle: HostSessionTitleService;
}

export interface DshPortDeps {
  readonly services: DshPortServices;
  /** 事件源：真宿主传 ctx（ctx.on），测试传 fake host（签名一致）。 */
  readonly events: DshEventSource;
  /** 数据根（workspaceDir 的锚点，绝对路径）。 */
  readonly dataRoot: string;
  /** 递归建目录（默认真 fs；测试注入 no-op）。 */
  readonly mkdir?: (dir: string) => Promise<void>;
}

/** 事件订阅源（宿主 ctx.on 的最小面；与 fake 的 on 同签名）。 */
export interface DshEventSource {
  on<E extends keyof HostEventPayloads>(
    event: E,
    listener: (...args: HostEventPayloads[E]) => void,
  ): () => void;
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

export function makeDshPort(deps: DshPortDeps): DshPort {
  const { services, dataRoot } = deps;
  const mkdir = deps.mkdir ?? ((dir: string) => fsMkdir(dir, { recursive: true }).then(() => undefined));

  async function createSession(input: { workspaceDir: string; name: string }): Promise<SessionId> {
    const absolute = join(dataRoot, input.workspaceDir);
    // 探针事实：workspaceRegistry.create 的 realpath 校验要求目录已存在
    await mkdir(absolute);
    const workspace = await services.workspaceRegistry.create(absolute);
    // 会话 id 生成权归 port（M3 定案）；前缀对齐 webhook 惯例便于排查
    const sessionId = `imessage-${randomUUID()}`;
    const handle = await services.agents.create({
      sessionId: sessionId as HostSessionId,
      meta: { cwd: absolute },
      // 探针事实：create 必带 agentOptions，无默认兜底
      agentOptions: services.agentDefaultModel.currentSelection(),
    });
    try {
      await workspace.attachSession(sessionId as HostSessionId);
      // 探针事实：rename 收 Session 对象（不是 id 字符串）
      services.sessionTitle.rename(handle.agent.session, input.name);
    } catch (error) {
      // 回滚：不留孤儿活 agent（预绑定事务失败时 router 不会记录绑定，
      // 下次来消息重走 create，孤儿 agent 会白占宿主资源）
      await handle.dispose().catch(() => undefined);
      throw error;
    }
    return asSessionId(sessionId);
  }

  async function getSessionStatus(sessionId: SessionId): Promise<SessionStatus> {
    const id: string = sessionId;
    // 归档集优先（源码事实：归档与活动状态独立，活着的归档会话也算 archived）
    const hostId = id as HostSessionId;
    if (services.workspaceRegistry.archivedSessionIds.includes(hostId)) return 'archived';
    if (services.agents.get(hostId) !== undefined) return 'active';
    try {
      // 冷会话：resume 试探（探针事实：持久存在则复活同 id 活句柄）
      await services.agents.resume({ resumeSessionId: hostId });
      return 'active';
    } catch (error) {
      // 探针事实：不存在时 name === 'SessionPersistenceNotFoundError'
      if ((error as { name?: string }).name === 'SessionPersistenceNotFoundError') {
        return 'missing';
      }
      // 其余失败（磁盘 IO 等）原样上抛：懒验证把它当 route 失败处理
      throw error;
    }
  }

  async function acquireAgent(id: string): Promise<HostAgent> {
    const hostId = id as HostSessionId;
    const live = services.agents.get(hostId);
    // 官方类型事实：get 返回的 Agent 与 handle.agent 是同一对象，
    // 运行时带完整增强面（followup/cancel/whenIdle，探针证实），
    // 类型只承诺判活面，故此处收窄
    if (live) return live as unknown as HostAgent;
    const handle = await services.agents.resume({ resumeSessionId: hostId });
    return handle.agent;
  }

  /**
   * 事件队列：把宿主的推送式事件转成拉取式迭代。turn/end 是收口信号。
   * 消费方提前退出（break/throw）时经 generator 的 return 钩子卸载监听。
   */
  function ask(input: AskInput): AskStream {
    const id: string = input.sessionId;
    const signal = input.signal;
    return (async function* () {
      const agent = await acquireAgent(id);

      type Item = { kind: 'delta'; text: string } | { kind: 'turn-end'; reason: unknown };
      const queue: Item[] = [];
      let settled = false;
      let wake: () => void = () => undefined;

      const onEvent = (session: string, event: HostSessionEvent): void => {
        if (session !== id || event.type !== 'turn/end') return;
        queue.push({ kind: 'turn-end', reason: (event.data as { reason?: unknown }).reason });
        settled = true;
        wake();
      };
      const onFrame = (payload: HostEventPayloads['agent/assistant-stream'][number]): void => {
        const { agent: agentId, frame } = payload;
        if (agentId !== id || frame.type !== 'chunk') return;
        const chunk = frame.chunk;
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          queue.push({ kind: 'delta', text: chunk.text });
          wake();
        }
      };
      const onAbort = (): void => {
        // 源码事实：cancel({kind:'user'}) 中止活动 turn，且 turn/end
        // 永远会追加（finally 兜底）——收口仍由 turn/end 事件驱动，
        // 这里只 cancel + 唤醒等待者，不直接置 settled（否则会在
        // turn/end 未到时误走正常收口路径）
        agent.cancel({ kind: 'user' });
        wake();
      };

      const detach = new Set<() => void>();
      detach.add(deps.events.on('session/event', onEvent));
      detach.add(deps.events.on('agent/assistant-stream', onFrame));
      signal?.addEventListener('abort', onAbort, { once: true });
      detach.add(() => signal?.removeEventListener('abort', onAbort));

      try {
        // 入队一条独占 turn 的用户消息（fire-and-forget，源码事实）
        agent.followup({
          id: randomUUID() as HostMessageId,
          role: 'user',
          content: [{ type: 'text', text: input.prompt }],
          source: { kind: 'user' },
        });

        for (;;) {
          while (queue.length === 0 && !settled) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          for (const item of queue.splice(0)) {
            if (item.kind === 'delta') {
              yield item.text;
              continue;
            }
            // turn/end：按 reason 收口（源码事实：五态）
            const reason = item.reason as { kind?: string; error?: HostLlmFailure } | undefined;
            if (signal?.aborted) throw signal.reason ?? new Error('ask aborted');
            if (reason?.kind === 'error') throw new DshAskError(reason.error ?? { message: 'unknown failure', code: 'UNKNOWN' });
            if (reason?.kind === 'aborted') {
              // 非本方 signal 的中止（宿主侧外部取消）：按 abort 语义上抛
              throw new Error('ask aborted by host');
            }
            return; // completed / blocked / max-tokens：正常收口
          }
          if (settled && queue.length === 0) return;
        }
      } finally {
        for (const dispose of detach) dispose();
      }
    })();
  }

  return { createSession, getSessionStatus, ask };
}
