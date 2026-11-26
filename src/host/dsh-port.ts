// DshPort 适配层：宿主服务（A 路线 / webhook 范式）→ core 契约。
//
// 这是内核与 DSH 框架的唯一接缝（M3 定案）：DSH rc 升级的接口漂移
// 只波及本文件与 dsh-api.ts。全部行为依据实测事实（探针互证 + 源码
// 事实，见 docs/host-integration/host-api/*.md）：
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
import { asSessionId, IMAGE_PLACEHOLDER } from '@/core/types/dsh';
import type {
  AskInput,
  AskPart,
  AskStream,
  DshPort,
  SessionId,
  SessionStatus,
} from '@/core/types/dsh';
import type {
  HostAgent,
  HostImageBlock,
  HostMessageId,
  HostSessionId,
  HostSessionObject,
  HostUserMessage,
} from '@/host/dsh-api';
import type {
  HostAgentsService,
  HostAgentDefaultModelService,
  HostAttachmentsService,
  HostEventPayloads,
  HostLlmFailure,
  HostSessionEvent,
  HostSystemPromptService,
  HostToolsService,
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
/** agentPresets 服务最小面（无该服务的宿主上 undefined = 用宿主默认预设）。 */
export interface HostAgentPresetsService {
  /** 解析预设 id（undefined = 默认）；不存在时抛错。 */
  resolve(id?: string): Promise<{ readonly id: string }>;
  /** 把预设组合挂到 agent 上下文（人设生效的唯一路径）。 */
  mount(agentContext: unknown, id: string): Promise<unknown>;
}

export interface DshPortServices {
  readonly agents: HostAgentsService;
  readonly workspaceRegistry: HostWorkspaceRegistry;
  readonly agentDefaultModel: HostAgentDefaultModelService;
  readonly sessionTitle: HostSessionTitleService;
  /** 可选：预设注册表（进程内服务，apply 期取一次即可）。 */
  readonly agentPresets?: HostAgentPresetsService;
  /** 可选：附件服务（老宿主无 = 图片降级不阻塞文本，M6.1）。 */
  readonly attachments?: HostAttachmentsService;
  /** 可选：工具服务（老宿主无 = 发文件能力缺，文本不受影响，M6.2）。 */
  readonly tools?: HostToolsService;
  /** 可选：prompt 组装服务（老宿主无 = 不注入身份段，M7）。 */
  readonly systemPrompt?: HostSystemPromptService;
}

/** 单次 ask 的收口上限：宿主走失 turn/end 时兜底，防单条消息永久堵死通道。 */
export const DEFAULT_ASK_TIMEOUT_MS = 180_000;

export interface DshPortDeps {
  readonly services: DshPortServices;
  /** 事件源：真宿主传 ctx（ctx.on），测试传 fake host（签名一致）。 */
  readonly events: DshEventSource;
  /** 数据根（workspaceDir 的锚点，绝对路径）。 */
  readonly dataRoot: string;
  /** 递归建目录（默认真 fs；测试注入 no-op）。 */
  readonly mkdir?: (dir: string) => Promise<void>;
  /** 单次 ask 收口上限（默认 DEFAULT_ASK_TIMEOUT_MS）。 */
  readonly askTimeoutMs?: number;
  /** 预设降级留痕（warn；宿主侧日志或 console）。 */
  readonly log?: { warn(event: string, fields?: Record<string, unknown>): void };
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
  const mkdir =
    deps.mkdir ?? ((dir: string) => fsMkdir(dir, { recursive: true }).then(() => undefined));

  async function createSession(input: {
    workspaceDir: string;
    name: string;
    preset?: string;
  }): Promise<SessionId> {
    const absolute = join(dataRoot, input.workspaceDir);
    // 探针事实：workspaceRegistry.create 的 realpath 校验要求目录已存在
    await mkdir(absolute);
    const workspace = await services.workspaceRegistry.create(absolute);
    // 预设组合（人设生效的唯一路径）：resolve → agents.create 的
    // meta.agentPreset（持久化记账）+ setup（挂载插件组合）。
    // 源码事实：api 层 composeAgent 等价物；任何失败都降级为无预设创建
    // （预设是体验项，不许炸通道），warn 留痕。
    let agentPreset: string | undefined;
    let setup: ((agentContext: unknown) => Promise<void>) | undefined;
    if (input.preset !== undefined && input.preset !== '') {
      const presets = services.agentPresets;
      if (presets === undefined) {
        deps.log?.warn('preset-unavailable', { preset: input.preset });
      } else {
        try {
          const resolved = (await presets.resolve(input.preset)).id;
          agentPreset = resolved;
          setup = async (agentContext) => {
            await presets.mount(agentContext, resolved);
          };
        } catch (error) {
          deps.log?.warn('preset-resolve-failed', {
            preset: input.preset,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    // 会话 id 生成权归 port（M3 定案）；前缀对齐 webhook 惯例便于排查
    const sessionId = `imessage-${randomUUID()}`;
    const handle = await services.agents.create({
      sessionId: sessionId as HostSessionId,
      meta: { cwd: absolute, ...(agentPreset === undefined ? {} : { agentPreset }) },
      // 探针事实：create 必带 agentOptions，无默认兜底
      agentOptions: services.agentDefaultModel.currentSelection(),
      ...(setup === undefined ? {} : { setup: setup as never }),
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

  /** ask prompt → followup content 块（M6.1）。
   *  string 直通；image 块逐图经 attachments.saveImages 签发引用——
   *  官方 saveImages 全批校验全有全无（任一失败整调 reject），
   *  单图剔除必须逐图调用。剔除留痕 warn；服务缺失（老宿主）同款
   *  降级；块全空时占位文本兑底，避免空 content 用户消息。 */
  async function buildContent(
    prompt: string | readonly AskPart[],
  ): Promise<HostUserMessage['content']> {
    if (typeof prompt === 'string') return [{ type: 'text', text: prompt }];
    // 官方 content 是 readonly 数组；构造用本地可变数组，返回处收窄
    const content: ({ type: 'text'; text: string } | HostImageBlock)[] = [];
    let warnedNoService = false;
    for (const part of prompt) {
      if (part.type === 'text') {
        content.push({ type: 'text', text: part.text });
        continue;
      }
      const svc = services.attachments;
      if (svc === undefined) {
        // 同批多图只警告一次（避免刷屏）
        if (!warnedNoService) {
          deps.log?.warn('dsh-port.image-skipped', { reason: 'attachments-unavailable' });
          warnedNoService = true;
        }
        continue;
      }
      try {
        const refs = await svc.saveImages([
          {
            data: part.bytes,
            mediaType: part.mediaType,
            ...(part.name !== undefined ? { name: part.name } : {}),
          },
        ]);
        // 单图调用必返单引用；空返属宿主违约，按剔除处理
        const ref = refs[0];
        if (ref !== undefined) {
          // 接缝 cast：ref 运行时是官方 ImageAttachmentRef，我们只承诺最小面
          content.push({ type: 'image', attachment: ref });
        }
      } catch (err) {
        deps.log?.warn('dsh-port.image-skipped', {
          reason: 'save-failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (content.length === 0) content.push({ type: 'text', text: IMAGE_PLACEHOLDER });
    return content as HostUserMessage['content'];
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

      // 官方签名：session 是 Session 对象（不是 id 字符串）。
      // 按 turn 编号隔离：超时/取消的上一轮可能迟到 turn/end，不能让它
      // 收掉本轮（否则上一次的 aborted 会污染下一次问答）。
      let myTurn: number | undefined;
      const onEvent = (session: HostSessionObject, event: HostSessionEvent): void => {
        if (session.id !== id) return;
        const data = event.data as { turn?: number; reason?: unknown };
        if (event.type === 'turn/start') {
          // 本轮 turn 编号：进入后第一�� turn/start 即本轮
          if (myTurn === undefined && typeof data.turn === 'number') myTurn = data.turn;
          return;
        }
        if (event.type !== 'turn/end') return;
        if (myTurn === undefined || data.turn !== myTurn) return; // 迟到的旧轮收口：忽略
        queue.push({ kind: 'turn-end', reason: data.reason });
        settled = true;
        wake();
      };
      // 官方 payload：{ agent: Agent 对象, frame }
      const onFrame = (payload: HostEventPayloads['agent/assistant-stream'][number]): void => {
        const { agent: subject, frame } = payload;
        if (subject.id !== id || frame.type !== 'chunk') return;
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

      // 兜底超时：宿主走失 turn/end 时把队列标记为收口并唤醒，
      // 由循环抛 TIMEOUT（否则流永不结束，通道被这条消息堵死）
      const timer = setTimeout(() => {
        settled = true;
        // 取消宿主侧 turn：不让它继续跑（烧 token、污染会话记录）
        agent.cancel({ kind: 'user' });
        wake();
      }, deps.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS);

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
          content: await buildContent(input.prompt),
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
            if (reason?.kind === 'error')
              throw new DshAskError(
                reason.error ?? { message: 'unknown failure', code: 'UNKNOWN' },
              );
            if (reason?.kind === 'aborted') {
              // 非本方 signal 的中止（宿主侧外部取消）：按 abort 语义上抛
              throw new Error('ask aborted by host');
            }
            return; // completed / blocked / max-tokens：正常收口
          }
          if (settled && queue.length === 0) {
            // 不变量：settled 只由 turn/end（队列有项）或超时定时器产生，
            // 故走到这里必然是没有 turn/end 的超时收口
            throw new DshAskError({
              message: 'ask timed out waiting for turn/end',
              code: 'TIMEOUT',
            });
          }
        }
      } finally {
        clearTimeout(timer);
        for (const dispose of detach) dispose();
      }
    })();
  }

  return { createSession, getSessionStatus, ask };
}
