import { describe, expect, it } from 'vitest';

import type { ChatDbRow } from '@/core/imessage/chatdb';
import { SendError } from '@/core/imessage/sender';
import { runPipeline, type PipelineOptions } from '@/core/router/pipeline';
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
  /** 跑到 idle（fetch 队列耗尽）返回 RunResult。可覆盖 options（测试边角分支用）。 */
  run(overrides?: Partial<PipelineOptions>): ReturnType<typeof runPipeline>;
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
  readonly logLines: Array<{ level: string; event: string; fields?: Record<string, unknown> }>;
  setMaxRowId(n: number): void;
  /** 一次性注入下一次落盘失败（claim persist 同步抛错 → fatal 分支）。 */
  failNextSave(): void;
}

type ChannelStateDraft = import('@/core/types/state').ChannelState;

function makeHarness(initialMaxRowId = 4): Harness {
  let state: ChannelStateDraft = makeChannelState();
  const port = makeFakeDshPort();
  const sender = makeFakeSender();
  // 落盘统一走这里：failNextSave 注入的一次性失败对 router/pipeline 都生效
  let failSave = false;
  const saveState = (s: ChannelStateDraft) => {
    if (failSave) {
      failSave = false;
      throw new Error('disk full');
    }
    state = s;
  };
  const router = makeSessionRouter({
    port,
    loadState: () => state,
    saveState,
  });
  const policy = makePolicy(['+8613800000000']);
  // 拉取脚本：喂入顺序 = 消费顺序（错误/数据交替可精确编排）
  const fetchPlan: Array<
    | { kind: 'rows'; rows: ChatDbRow[] }
    | { kind: 'error'; err: Error }
  > = [];
  const sleeps: number[] = [];
  const fetchCursors: number[] = [];
  const logLines: Harness['logLines'] = [];
  let maxRowId = initialMaxRowId;

  // 记录字段：链路日志的断言依赖 guid/key/chars/耗时等
  const log: Logger = {
    debug: () => {},
    info: (event, fields) => logLines.push({ level: 'info', event, ...(fields === undefined ? {} : { fields }) }),
    warn: (event, fields) => logLines.push({ level: 'warn', event, ...(fields === undefined ? {} : { fields }) }),
    error: (event, fields) => logLines.push({ level: 'error', event, ...(fields === undefined ? {} : { fields }) }),
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
    failNextSave: () => {
      failSave = true;
    },
    feed(rows) {
      fetchPlan.push({ kind: 'rows', rows });
    },
    feedFetchError(err) {
      fetchPlan.push({ kind: 'error', err });
    },
    mutate(fn) {
      state = fn(state);
    },
    run: (overrides: Partial<PipelineOptions> = {}) => {
      // 一次 run = 一次进程生命周期：独立的 abort 信号（idle 停机不污染下一次）
      const controller = new AbortController();
      return runPipeline(
        {
          fetchRows: (cursor, _limit) => {
            fetchCursors.push(cursor);
            // 脚本耗尽 = 真正 idle（所有消息处理完后的空拉）→ 停机。
            // 打字延迟期间不会拉取，不会误停。
            if (fetchPlan.length === 0) {
              controller.abort(new Error('idle-stop'));
            }
            const step = fetchPlan.shift();
            if (step?.kind === 'error') throw step.err;
            return step?.kind === 'rows' ? step.rows : [];
          },
          currentMaxRowId: () => maxRowId,
          sender,
          port,
          router,
          policy,
          sessionSwitchedText: SWITCHED_TEXT,
          replyUnavailableText: UNAVAILABLE_TEXT,
          loadState: () => state,
          saveState,
          log,
        },
        {
          signal: controller.signal,
          intervalMs: 10,
          sleep: async (ms, sig) => {
            sleeps.push(ms);
            if (sig?.aborted) throw sig.reason ?? new Error('aborted');
          },
          ...overrides, // 传 sleep: undefined 可显式切回 runPipeline 内联的默认实现
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
// 全链路可观测性（可定位"卡在哪一步"）
// ---------------------------------------------------------------------------

/** 取出某个事件的字段（断言用）。 */
function fieldsOf(h: Harness, event: string): Record<string, unknown> | undefined {
  return h.logLines.find((l) => l.event === event)?.fields;
}

describe('pipeline · trace logs', () => {
  it('records fetch → claim → ask → reply-sent → done for one message', async () => {
    const h = makeHarness();
    h.feed([R5({ text: '在吗' })]);
    h.port.queueAsk({ chunks: ['你好'] });

    await h.run();

    const events = h.logLines.map((l) => l.event);
    // 顺序即链路：一眼能看出停在哪一步
    expect(events).toEqual([
      'pipeline.cursor-initialized',
      'pipeline.fetch',
      'pipeline.message-claimed',
      'pipeline.ask-start',
      'pipeline.ask-done',
      'pipeline.reply-sent',
      'pipeline.message-done',
    ]);

    expect(fieldsOf(h, 'pipeline.fetch')).toMatchObject({ fetched: 1 });
    expect(fieldsOf(h, 'pipeline.message-claimed')).toMatchObject({
      guid: 'm5',
      rowId: 5,
      key: '+8613800000000',
      chars: 2,
    });
    // 耗时字段存在且为数字（首字延迟 + 总耗时）
    const asked = fieldsOf(h, 'pipeline.ask-done');
    expect(typeof asked?.['firstDeltaMs']).toBe('number');
    expect(typeof asked?.['totalMs']).toBe('number');
    expect(fieldsOf(h, 'pipeline.reply-sent')).toMatchObject({ parts: 1, chars: 2 });
    expect(fieldsOf(h, 'pipeline.message-done')).toMatchObject({ guid: 'm5', rowId: 5 });
  });

  it('records a skipped message with the reason (answers "why no reply")', async () => {
    const h = makeHarness();
    h.feed([
      makeRow({
        rowid: 6, guid: 'm6', text: '陌生人',
        handleText: '+8613900000000', chatGuid: 'iMessage;-;+8613900000000',
      }),
    ]);

    await h.run();

    expect(fieldsOf(h, 'pipeline.message-skipped')).toMatchObject({
      guid: 'm6',
      rowId: 6,
      reason: 'not-allowlisted',
    });
    // 白名单拒绝不进入 ask 链路
    expect(h.logLines.some((l) => l.event === 'pipeline.ask-start')).toBe(false);
  });

  it('records already-seen skips separately from allowlist rejections', async () => {
    const h = makeHarness();
    h.mutate((s) => ({ ...s, cursor: 4, seenIds: ['m5'] }));
    h.feed([R5()]);

    await h.run();

    expect(fieldsOf(h, 'pipeline.message-skipped')).toMatchObject({ reason: 'already-seen' });
  });

  it('returns the processed count when shutdown lands between batches', async () => {
    // 真机场景：第一条处理完、正在发送时用户退出 → 下一轮循环顶部才发现中止。
    // 这必须作为"正常停机"返回（带 processed），不是 reject。
    const h = makeHarness();
    const controller = new AbortController();
    h.feed([R5()]);
    h.port.queueAsk({ chunks: ['好'], onEnd: () => controller.abort(new Error('shutdown')) });

    const result = await h.run({ signal: controller.signal });

    expect(result).toEqual({ reason: 'aborted', processed: 1 });
  });

  it('reports firstDeltaMs as null when the reply stream yields nothing', async () => {
    const h = makeHarness();
    h.feed([R5()]);
    h.port.queueAsk({ chunks: [] }); // 空回复：没有首字

    await h.run();

    expect(fieldsOf(h, 'pipeline.ask-done')).toMatchObject({ firstDeltaMs: null, chars: 0 });
  });

  it('does not log fetch for an empty batch (no 2s heartbeat noise)', async () => {
    const h = makeHarness();
    await h.run();

    expect(h.logLines.some((l) => l.event === 'pipeline.fetch')).toBe(false);
  });

  it('never writes message text into the log (privacy)', async () => {
    const h = makeHarness();
    h.feed([R5({ text: '我的银行卡密码是123456' })]);
    h.port.queueAsk({ chunks: ['收到'] });

    await h.run();

    const dump = JSON.stringify(h.logLines);
    expect(dump).not.toContain('银行卡');
    expect(dump).not.toContain('收到');
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
    expect(h.logLines).toContainEqual(expect.objectContaining({ level: 'warn', event: 'pipeline.send-failed' }));
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
    expect(h.logLines).toContainEqual(expect.objectContaining({ level: 'error', event: 'pipeline.permission-stopped' }));
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

  it('terminates with fetch-exhausted after consecutive failures reach the cap', async () => {
    const h = makeHarness();
    for (let i = 0; i < 10; i++) h.feedFetchError(new Error('db gone'));

    const result = await h.run();

    expect(result).toEqual({ reason: 'fetch-exhausted', processed: 0 });
    expect(h.logLines).toContainEqual(expect.objectContaining({ level: 'error', event: 'pipeline.fetch-exhausted' }));
    expect(h.sleeps).toHaveLength(9); // 第 10 次失败直接终止，不再等待
    // 退避节奏：10 → 20 → 40 → …，第 5 次起夹逼在 60s
    expect(h.sleeps.slice(0, 5)).toEqual([10, 20, 40, 80, 160]);
  });

  it('resets the failure streak after a successful fetch', async () => {
    const h = makeHarness();
    // 9 连败 → 一批真消息（拉取成功，通道复活清零）→ 再 9 连败：未达上限
    for (let i = 0; i < 9; i++) h.feedFetchError(new Error('db flaky'));
    h.feed([R5()]);
    h.port.queueAsk({ chunks: ['ok'] });
    for (let i = 0; i < 9; i++) h.feedFetchError(new Error('db flaky'));

    const result = await h.run();

    expect(result).toEqual({ reason: 'aborted', processed: 1 }); // 消息也正常答了
    expect(h.logLines.filter((l) => l.event === 'pipeline.fetch-exhausted')).toHaveLength(0);
    // 两段各 9 次 fetch-failed，中间成功一次（共 19 次拉取）
    expect(h.logLines.filter((l) => l.event === 'pipeline.fetch-failed')).toHaveLength(18);
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
    expect(h.logLines).toContainEqual(expect.objectContaining({ level: 'warn', event: 'pipeline.retry-exhausted' }));

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
    expect(h.logLines).toContainEqual(expect.objectContaining({ level: 'warn', event: 'pipeline.notify-failed' }));
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
// 崩溃 / 重启恢复专测（M3 验收：不丢、不重——定案后语义为 at-most-once：
// 不重是硬保证；崩溃窗口内可能吞一条，用户重发即愈）
// ---------------------------------------------------------------------------

describe('pipeline · crash recovery matrix', () => {
  it('crash after reply sent: restart never answers twice', async () => {
    const h = makeHarness();
    // 生命周期 1：完整回答（reply 已发出，但崩溃发生在 cursor 落盘前）
    h.feed([R5()]);
    h.port.queueAsk({ chunks: ['答完了'] });
    await h.run();
    expect(h.sender.sent).toHaveLength(1);

    // 人为回退 cursor 模拟「落盘前崩溃」（seen 保留、cursor 停在原地）
    h.mutate((s) => ({ ...s, cursor: 4 }));
    h.sender.sent.length = 0;
    h.port.askCalls.length = 0;

    // 生命周期 2（重启）：重拉 m5 → already-seen → 只补推 cursor
    h.feed([R5()]);
    const second = await h.run();
    expect(second.processed).toBe(1);
    expect(h.sender.sent).toHaveLength(0); // 不再回复
    expect(h.port.askCalls).toHaveLength(0); // 不再问
    expect(h.state().cursor).toBe(5);
  });

  it('crash mid-reply (partial segments sent): restart does not resume sending', async () => {
    const h = makeHarness();
    // 生命周期 1：多段回复只发出第一段后崩溃（humanize 内部异常）
    h.feed([R5()]);
    h.port.queueAsk({ chunks: ['第一段\n第二段'] });
    h.sender.failTextAt(1, new Error('crash mid-segments'));
    await h.run();
    // 只有第一段到了手机；第二段发送失败 → 终态吞（at-most-once 的代价：
    // 部分回复，不补发不重发）
    expect(h.sender.sent.map((s) => s.text)).toEqual(['第一段']);

    // 重启重拉：already-seen 挡住，不补发不重发
    h.mutate((s) => ({ ...s, cursor: 4 }));
    h.sender.sent.length = 0;
    h.feed([R5()]);
    await h.run();
    expect(h.sender.sent).toHaveLength(0);
  });

  it('crash before batch-tail persist: skipped rows are re-filtered idempotently', async () => {
    const h = makeHarness();
    // 生命周期 1：批内只有 skipped 行（搭车推进未落盘即崩溃）
    h.feed([makeRow({ rowid: 4, guid: 'm4', isFromMe: 1 })]);
    const first = await h.run();
    expect(first.processed).toBe(0);
    // idle 停机前的 batch 尾落盘会带出 cursor=4 —— 用 mutate 模拟崩溃回退
    h.mutate((s) => ({ ...s, cursor: 3 }));

    // 生命周期 2：重拉 m4（fromMe）再被 normalize 拒，无副作用
    h.feed([
      makeRow({ rowid: 4, guid: 'm4', isFromMe: 1 }),
      R5({ text: '新消息' }),
    ]);
    h.port.queueAsk({ chunks: ['回复'] });
    const second = await h.run();
    expect(second.processed).toBe(1);
    expect(h.state().cursor).toBe(5);
    expect(h.state().seenIds).toEqual(['m5']);
  });

  it('crash between claim and ask: the message is swallowed exactly once, ledger stays consistent', async () => {
    const h = makeHarness();
    // 生命周期 1：claim 已落盘，ask 未发生即崩溃（无 ask 脚本也行——直接断电式）
    h.mutate((s) => ({ ...s, cursor: 4, seenIds: ['m5'] }));

    // 生命周期 2：重拉 → already-seen 终态补推 → 不问不答（at-most-once 窗口）
    h.feed([R5()]);
    const result = await h.run();
    expect(result.processed).toBe(1);
    expect(h.port.askCalls).toHaveLength(0);
    expect(h.state()).toMatchObject({ cursor: 5, seenIds: ['m5'] });
  });
});

// ---------------------------------------------------------------------------
// 边角分支补覆盖：fatal / 纯 skipped 批尾落盘 / 内联默认 sleep
// ---------------------------------------------------------------------------

describe('pipeline · edge coverage', () => {
  it('returns fatal when saveState throws during claim persist', async () => {
    const h = makeHarness();
    // 预置 cursor：跳过首启初始化落盘（那一步的 saveState 在循环 try/catch
    // 之外，抛错会直接 reject 而非走 fatal 分支）
    h.mutate((s) => ({ ...s, cursor: 4 }));
    h.feed([R5()]); // 端口不排脚本：默认回复
    h.failNextSave(); // claim persist 同步抛错，先于下一轮 fetch 的 idle abort

    const result = await h.run();

    expect(result).toEqual({ reason: 'fatal', processed: 0 });
    expect(h.state().seenIds).toEqual([]); // 账本未被污染
    expect(h.logLines).toContainEqual(expect.objectContaining({ level: 'error', event: 'pipeline.fatal' }));
  });

  it('persists the piggybacked cursor at batch tail for an all-skipped batch', async () => {
    const h = makeHarness(3); // 首启水位 3 < 批内最大 rowid：搭车 cursor 才有推进量
    h.feed([makeRow({ rowid: 4, guid: 'm4', isFromMe: 1 })]); // from-me：被 normalize 滤掉

    const result = await h.run();

    expect(result).toEqual({ reason: 'aborted', processed: 0 });
    expect(h.state().cursor).toBe(4); // 批尾落盘把搭车 cursor 带出
    expect(h.state().seenIds).toEqual([]);
  });

  it('waits empty batches with the built-in default sleep (no injected sleep)', async () => {
    const h = makeHarness();
    h.feed([]); // 空批：本轮无产出 → 内联默认 sleep 真 timer 等待 intervalMs
    const controller = new AbortController();
    // 在等待窗口内 abort（5ms < 50ms，定时器到期序确定）：命中默认 sleep 的
    // abort 监听路径（清 timer + reject）→ catch 转成 aborted 停机。
    // 注：不能用 harness 的 idle-stop（它在 fetch 时机 abort，此时 sleep
    // 尚未挂监听，事后监听不会补发 → 循环顶 throw 变 reject 而非 aborted）
    setTimeout(() => controller.abort(new Error('idle-stop')), 5);

    const result = await h.run({ signal: controller.signal, intervalMs: 50, sleep: undefined });

    expect(result).toEqual({ reason: 'aborted', processed: 0 });
    expect(h.sleeps).toHaveLength(0); // 假 sleep 完全未介入
  });

  it('returns aborted when the backoff wait itself is interrupted', async () => {
    const h = makeHarness();
    // 两次拉取失败；第二次的退避等待被外部中断 → catch 转 aborted
    h.feedFetchError(new Error('db locked'));
    h.feedFetchError(new Error('db locked'));
    let calls = 0;
    const result = await h.run({
      sleep: async () => {
        calls += 1;
        if (calls === 2) throw new Error('interrupted mid-backoff');
      },
    });

    expect(result).toEqual({ reason: 'aborted', processed: 0 });
    expect(h.logLines.filter((l) => l.event === 'pipeline.fetch-failed')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function permissionErr(): Error {
  return new SendError('automation-permission', '+8613800000000', new Error('-1743'));
}
