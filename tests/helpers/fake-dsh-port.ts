// 可编程 fake DshPort：M3 内核全链路测试的地基（真实现 M4 接 apiProxy）。
//
// 能力面按测试需求设计：
// - createSession：自增 id（dsh-1、dsh-2 …），建后即 active；可注入失败；
// - getSessionStatus：statuses Map 为数据源（未登记 = missing）；
// - ask：脚本队列 FIFO——默认回 '(fake)'，queueAsk 可指定 chunk 序列、
//   中途失败、以及是否检查 abort；
// - 全部调用被记录（createdCalls / askCalls）供断言。

import {
  asSessionId,
  type AskInput,
  type CreateSessionInput,
  type DshPort,
  type SessionId,
  type SessionStatus,
} from '@/core/types/dsh';

export interface AskScript {
  /** 依次产出的文本片段。 */
  readonly chunks: readonly string[];
  /** 产出全部 chunk 后抛出（模拟回答中途断流）。 */
  readonly failWith?: Error;
  /** true = 检查 signal.aborted（默认 true）。 */
  readonly checkAbort?: boolean;
  /** 全部 chunk 产出后回调（测试用：在"刚处理完一条"的时机制造中止）。 */
  readonly onEnd?: () => void;
}

export interface FakeDshPort extends DshPort {
  /** createSession 调用记录（按序）。 */
  readonly createdCalls: CreateSessionInput[];
  /** ask 调用记录（按序，不含流内容）。 */
  readonly askCalls: AskInput[];
  /** 会话状态数据源（createSession 自动写 active）。 */
  readonly statuses: Map<SessionId, SessionStatus>;
  /** 下一次 createSession 抛出（一次性注入）。 */
  failNextCreate(err: Error): void;
  /** 排队一个 ask 脚本（FIFO；不排则用默认回复）。 */
  queueAsk(script: AskScript): void;
  /** 给 createSession 加延迟（并发窗口测试）。 */
  setCreateDelay(ms: number): void;
}

export function makeFakeDshPort(): FakeDshPort {
  const createdCalls: CreateSessionInput[] = [];
  const askCalls: AskInput[] = [];
  const statuses = new Map<SessionId, SessionStatus>();
  const scripts: AskScript[] = [];
  let createFailure: Error | null = null;
  let createDelayMs = 0;
  let seq = 0;

  return {
    createdCalls,
    askCalls,
    statuses,

    failNextCreate(err) {
      createFailure = err;
    },

    queueAsk(script) {
      scripts.push(script);
    },

    setCreateDelay(ms) {
      createDelayMs = ms;
    },

    async createSession(input) {
      createdCalls.push(input);
      if (createDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, createDelayMs));
      }
      if (createFailure) {
        const err = createFailure;
        createFailure = null;
        throw err;
      }
      seq += 1;
      const id = asSessionId(`dsh-${seq}`);
      statuses.set(id, 'active');
      return id;
    },

    async getSessionStatus(sessionId) {
      return statuses.get(sessionId) ?? 'missing';
    },

    ask(input) {
      // 调用即记录/弹脚本（async generator 惰性，不能等首次迭代）
      askCalls.push(input);
      const script = scripts.shift() ?? { chunks: ['(fake)'] };
      return (async function* () {
        if (script.checkAbort !== false && input.signal?.aborted) {
          throw input.signal.reason ?? new Error('aborted');
        }
        for (const chunk of script.chunks) {
          if (script.checkAbort !== false && input.signal?.aborted) {
            throw input.signal.reason ?? new Error('aborted');
          }
          yield chunk;
        }
        script.onEnd?.();
        if (script.failWith) throw script.failWith;
      })();
    },
  };
}
