import { describe, expect, it } from 'vitest';

import type { ChatDbRow } from '@/core/imessage/chatdb';
import { SendError } from '@/core/imessage/sender';
import { runPipeline } from '@/core/router/pipeline';
import { makeSessionRouter } from '@/core/router/session-router';
import { makePolicy } from '@/core/types/policy';
import { makeChannelState, type ChannelState } from '@/core/types/state';
import { makeFakeDshPort } from '../../helpers/fake-dsh-port';
import { makeFakeSender } from '../../helpers/fake-sender';
import { makeRow } from '../../helpers/chatdb-rows';
import type { Logger } from '@/core/log/jsonl';

// ---------------------------------------------------------------------------
// 测试组装：真 router/gate + fake IO 边界。run() 到 fetch 队列耗尽即
// idle-abort（一轮 run = 一次「进程生命周期」，两轮 run = 重启恢复）。
// ---------------------------------------------------------------------------

const SWITCHED_TEXT = '上一个对话已被归档，我开启了新对话继续聊';
const UNAVAILABLE_TEXT = '这条我暂时回不了，稍后再问一次吧';

interface Harness {
  /** 跑到 idle（fetch 队列耗尽）返回 RunResult。 */
  run(): ReturnType<typeof runPipeline>;
  /** 预填一批行（按序消费）。 */
  feed(rows: ChatDbRow[]): void;
  /** 预置 fetch 抛错（按序消费）。 */
  feedFetchError(err: Error): void;
  /** 直接改内存 state（预置崩溃现场等）。 */
  mutate(replace: (current: ChannelState) => ChannelState): void;
  readonly port: ReturnType<typeof makeFakeDshPort>;
  readonly sender: ReturnType<typeof makeFakeSender>;
  readonly state: () => import('@/core/types/state').ChannelState;
  readonly sleeps: number[];
  readonly fetchCursors: number[];
  readonly logLines: Array<{ level: string; event: string }>;
  setMaxRowId(n: number): void;
}

type ChannelStateDraft = import('@/core/types/state').ChannelState;

function makeHarness(initialMaxRowId = 4): Harness {
  let state: ChannelStateDraft = makeChannelState();
  const port = makeFakeDshPort();
  const sender = makeFakeSender();
  const router = makeSessionRouter({
    port,
    loadState: () => state,
    saveState: (s) => {
      state = s;
    },
  });
  const policy = makePolicy(['+8613800000000']);
  const fetchQueue: ChatDbRow[][] = [];
  const fetchErrors: Error[] = [];
  const sleeps: number[] = [];
  const fetchCursors: number[] = [];
  const logLines: Harness['logLines'] = [];
  let maxRowId = initialMaxRowId;

  const log: Logger = {
    debug: () => {},
    info: (event) => logLines.push({ level: 'info', event }),
    warn: (event) => logLines.push({ level: 'warn', event }),
    error: (event) => logLines.push({ level: 'error', event }),
  };

  return {
    port,
    sender,
    state: () => state,
    sleeps,
    fetchCursors,
    logLines,
    setMaxRowId: (n) => {
      maxRowId = n;
    },
    feed(rows) {
      fetchQueue.push(rows);
    },
    feedFetchError(err) {
      fetchErrors.push(err);
    },
    mutate(fn) {
      state = fn(state);
    },
    run: () => {
      // 一次 run = 一次进程生命周期：独立的 abort 信号（idle 停机不污染下一次）
      const controller = new AbortController();
      return runPipeline(
        {
          fetchRows: (cursor, _limit) => {
            fetchCursors.push(cursor);
            // idle 检测只属于拉取：连续空批 = 所有消息处理完（打字延迟
            // 期间不会拉取，不会误停）
            if (fetchQueue.length === 0 && fetchErrors.length === 0) {
              controller.abort(new Error('idle-stop'));
            }
            if (fetchErrors.length > 0) throw fetchErrors.shift()!;
            return fetchQueue.shift() ?? [];
          },
          currentMaxRowId: () => maxRowId,
          sender,
          port,
          router,
          policy,
          sessionSwitchedText: SWITCHED_TEXT,
          replyUnavailableText: UNAVAILABLE_TEXT,
          loadState: () => state,
          saveState: (s) => {
            state = s;
          },
          log,
        },
        {
          signal: controller.signal,
          intervalMs: 10,
          sleep: async (ms, sig) => {
            sleeps.push(ms);
            if (sig?.aborted) throw sig.reason ?? new Error('aborted');
          },
        },
      );
    },
  };
}

const R5 = (over: Partial<ChatDbRow> = {}) => makeRow({ rowid: 5, guid: 'm5', ...over });

// ---------------------------------------------------------------------------
// 全链路
// ---------------------------------------------------------------------------

describe('pipeline · happy path', () => {
  it('answers one message end to end and persists the cursor', async () => {
    const h = makeHarness();
    h.feed([R5({ text: '在吗' })]);
    h.port.queueAsk({ chunks: ['你', '好', '呀'] });

    const result = await h.run();

    expect(result).toEqual({ reason: 'aborted', processed: 1 });
    expect(h.sender.sent).toEqual([
      { kind: 'text', address: '+8613800000000', text: '你好呀' },
    ]);
    expect(h.port.askCalls[0]?.prompt).toBe('在吗');
    expect(h.state().cursor).toBe(5);
    expect(h.state().seenIds).toEqual(['m5']);
  });

  it('initializes the cursor to the current max row id on first start (no history replay)', async () => {
    const h = makeHarness(42);
    h.setMaxRowId(42);
    await h.run();
    expect(h.state().cursor).toBe(42);
    expect(Math.min(...h.fetchCursors)).toBe(42); // 从未用更小的 cursor 拉过
  });
});

// ---------------------------------------------------------------------------
// 崩溃 / 重启恢复（两次 run = 重启）
// ---------------------------------------------------------------------------

describe('pipeline · ask failure retries after restart', () => {
  it('leaves the cursor in place and unmarks, then succeeds on the next run', async () => {
    const h = makeHarness();
    h.feed([R5()]);
    h.port.queueAsk({ chunks: [], failWith: new Error('dsh timeout') });

    // 第一次生命周期：ask 失败 → retry → 本批中断 → idle 停机
    const first = await h.run();
    expect(first).toEqual({ reason: 'aborted', processed: 0 });
    expect(h.state().cursor).toBe(4); // cursor 停在原地 → 重启后能重拉
    expect(h.state().seenIds).toEqual([]); // unmark：账本已释放
    expect(h.sender.sent).toHaveLength(0);

    // 第二次生命周期（重启）：重拉同一条，成功
    h.feed([R5()]);
    h.port.queueAsk({ chunks: ['好了'] });
    const second = await h.run();
    expect(second).toEqual({ reason: 'aborted', processed: 1 });
    expect(h.sender.sent).toEqual([
      { kind: 'text', address: '+8613800000000', text: '好了' },
    ]);
    expect(h.state().cursor).toBe(5);
    expect(h.port.askCalls).toHaveLength(2); // 总共问过两次（1 失败 + 1 成功）
  });
});

describe('pipeline · send failure swallows (no retry, no duplicate)', () => {
  it('keeps the claim and advances the cursor — the message is done', async () => {
    const h = makeHarness();
    h.feed([R5()]);
    h.sender.failTextAt(0, new Error('osascript died'));

    const result = await h.run();

    expect(result).toEqual({ reason: 'aborted', processed: 1 });
    expect(h.state().cursor).toBe(5);
    expect(h.state().seenIds).toEqual(['m5']); // claim 保留
    expect(h.logLines).toContainEqual({ level: 'warn', event: 'pipeline.send-failed' });
  });
});

describe('pipeline · permission loss stops the loop', () => {
  it('persists state cleanly and reports permission-stopped', async () => {
    const h = makeHarness();
    h.feed([R5()]);
    h.sender.failTextAt(0, permissionErr());

    const result = await h.run();

    expect(result).toEqual({ reason: 'permission-stopped', processed: 1 });
    expect(h.state().cursor).toBe(5);
    expect(h.state().seenIds).toEqual(['m5']);
    expect(h.logLines).toContainEqual({ level: 'error', event: 'pipeline.permission-stopped' });
  });
});

// ---------------------------------------------------------------------------
// gate 交互
// ---------------------------------------------------------------------------

describe('pipeline · gate rejections', () => {
  it('ignores non-allowlisted senders without marking', async () => {
    const h = makeHarness();
    h.feed([R5({ handleText: '+8613900000000' })]);

    const result = await h.run();

    expect(result.processed).toBe(0);
    expect(h.port.askCalls).toHaveLength(0);
    expect(h.state().cursor).toBe(5);
    expect(h.state().seenIds).toEqual([]);
  });

  it('resumes a crashed claim via already-seen (cursor catch-up)', async () => {
    const h = makeHarness();
    // 崩溃现场：claim 已落盘（seen 有 m5）但 cursor 没推进
    h.mutate((current) => ({ ...current, seenIds: ['m5'] }));
    h.feed([R5()]);

    const result = await h.run();

    expect(result.processed).toBe(1);
    expect(h.port.askCalls).toHaveLength(0); // 不再回答
    expect(h.state().cursor).toBe(5); // cursor 补推进完成终态
  });
});

// ---------------------------------------------------------------------------
// 归档换绑告知
// ---------------------------------------------------------------------------

describe('pipeline · archived rebind notification', () => {
  it('notifies via the system path before answering', async () => {
    const h = makeHarness();
    h.feed([R5()]);
    await h.run(); // 第一次：建立绑定

    const bound = h.state().sessions['+8613800000000']!;
    h.sender.sent.length = 0;
    h.port.statuses.set(bound.sessionId, 'archived'); // 会话被归档

    h.feed([makeRow({ rowid: 6, guid: 'm6', text: '还在吗' })]);
    h.port.queueAsk({ chunks: ['在的'] });
    await h.run();

    expect(h.sender.sent.map((s) => s.kind)).toEqual(['system', 'text']);
    expect(h.sender.sent[0]).toEqual({
      kind: 'system',
      address: '+8613800000000',
      text: SWITCHED_TEXT,
    });
    expect(h.sender.sent[1]?.text).toBe('在的');
  });
});

// ---------------------------------------------------------------------------
// skipped 搭车 / 退避
// ---------------------------------------------------------------------------

describe('pipeline · bookkeeping', () => {
  it('carries skipped rows along with the next persist', async () => {
    const h = makeHarness();
    h.feed([
      makeRow({ rowid: 4, guid: 'm4', isFromMe: 1 }), // skipped: from-me
      R5(),
    ]);
    h.port.queueAsk({ chunks: ['ok'] });
    await h.run();
    expect(h.state().cursor).toBe(5);
    expect(h.state().seenIds).toEqual(['m5']);
  });

  it('backs off exponentially on fetch errors and resets after success', async () => {
    const h = makeHarness();
    h.feedFetchError(new Error('db locked'));
    h.feedFetchError(new Error('db locked'));
    h.feed([R5()]);
    h.port.queueAsk({ chunks: ['ok'] });

    await h.run();

    // 两次退避翻倍（10 → 20）；处理消息期间有人打字延迟（随机值，不断言）；
    // 成功后重置——最后的 idle 间隔回到 10
    expect(h.sleeps.slice(0, 2)).toEqual([10, 20]);
    expect(h.sleeps[h.sleeps.length - 1]).toBe(10);
    expect(h.logLines.filter((l) => l.event === 'pipeline.fetch-failed')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// ask 重试上限（定案 B+：3 连败吞 + 系统告知，不堵塞通道）
// ---------------------------------------------------------------------------

describe('pipeline · ask retry budget', () => {
  it('retries twice, then swallows with a notification on the third failure', async () => {
    const h = makeHarness();
    // 单进程长跑模拟：一个 run 内连续三批重拉（计数在进程内存里累计）
    for (let i = 0; i < 3; i++) h.feed([R5()]);
    for (let i = 0; i < 3; i++) {
      h.port.queueAsk({ chunks: [], failWith: new Error('dsh down') });
    }
    const result = await h.run(); // 三连败：前两次重试，第三次吞 + 告知
    expect(result).toEqual({ reason: 'aborted', processed: 1 });
    expect(h.state().cursor).toBe(5); // 通道解堵
    expect(h.state().seenIds).toEqual(['m5']);
    expect(h.sender.sent).toEqual([
      { kind: 'system', address: '+8613800000000', text: UNAVAILABLE_TEXT },
    ]);
    expect(h.logLines).toContainEqual({ level: 'warn', event: 'pipeline.retry-exhausted' });

    // 后续新消息正常处理（不因历史耗尽受影响）
    h.feed([makeRow({ rowid: 6, guid: 'm6', text: '新消息' })]);
    h.port.queueAsk({ chunks: ['新回复'] });
    const fourth = await h.run();
    expect(fourth).toEqual({ reason: 'aborted', processed: 1 });
    expect(h.sender.sent[1]).toEqual({ kind: 'text', address: '+8613800000000', text: '新回复' });
  });

  it('keeps the swallowed state when the notification itself fails', async () => {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) h.feed([R5()]);
    for (let i = 0; i < 3; i++) {
      h.port.queueAsk({ chunks: [], failWith: new Error('dsh down') });
    }
    h.sender.failNextSystem(new Error('notify boom'));
    await h.run();
    // 终态已落盘，告知失败仅留痕
    expect(h.state().cursor).toBe(5);
    expect(h.state().seenIds).toEqual(['m5']);
    expect(h.logLines).toContainEqual({ level: 'warn', event: 'pipeline.notify-failed' });
  });

  it('stops with permission-stopped if the notification hits a permission error', async () => {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) h.feed([R5()]);
    for (let i = 0; i < 3; i++) {
      h.port.queueAsk({ chunks: [], failWith: new Error('dsh down') });
    }
    h.sender.failNextSystem(permissionErr());
    const result = await h.run();
    expect(result).toEqual({ reason: 'permission-stopped', processed: 1 });
    expect(h.state().cursor).toBe(5);
    expect(h.state().seenIds).toEqual(['m5']);
  });

  it('resets the budget per message (success clears the counter)', async () => {
    const h = makeHarness();
    // 单进程内五批：m5 先败后成；m6 连续三败（计数不继承 m5 的那 1 败）
    h.feed([R5()]);
    h.port.queueAsk({ chunks: [], failWith: new Error('flaky') }); // m5 第 1 败
    h.feed([R5()]);
    h.port.queueAsk({ chunks: ['好了'] }); // m5 成（计数清）
    for (let i = 0; i < 3; i++) {
      h.feed([makeRow({ rowid: 6, guid: 'm6' })]);
      h.port.queueAsk({ chunks: [], failWith: new Error('dsh down') });
    }
    const result = await h.run();
    expect(result.processed).toBe(2); // m5 答 + m6 吞
    expect(h.state().cursor).toBe(6);
    expect(h.state().seenIds).toEqual(['m6', 'm5']);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function permissionErr(): Error {
  return new SendError('automation-permission', '+8613800000000', new Error('-1743'));
}
