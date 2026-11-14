// fake 宿主（A 路线 / webhook 范式）的行为规格测试。
//
// 这是 M4 Step 1 的「测试先行」载体：先写规格（本文件），再写
// tests/helpers/fake-dsh-api.ts 的实现让本文件转绿。fake 是 Step 2
// （host/dsh-port.ts 适配层）测试的宿主模拟器，规格来源：
// - docs/host-api/plugin.md（服务面、inject、生命周期）
// - docs/host-api/ask.md（事件协议、abort、错误形态）
// - docs/host-api/rpc.md（workspace、归档判定）
// - /tmp/dsh-probe 两轮真机探针（行为语义互证，见各断言旁标注）
//
// fake 只模拟 DshPort 适配层会消费的面：事件序列保真到适配层关心的
// 子集（inbox/turn/stream/assistant-message/turn-end），不追求协议复读。

import { describe, expect, it } from 'vitest';
import { asHostSessionId } from '@/host/dsh-api';
import type { HostEventName } from '@/host/dsh-api';
import { makeFakeDshHost, userText } from '../helpers/fake-dsh-api';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 收集事件的监听器（挂到 host.on，返回 [数组, 卸载函数]）。 */
function collector<T>(host: ReturnType<typeof makeFakeDshHost>, event: HostEventName): [T[], () => void] {
  const out: T[] = [];
  // 取回调最后一个参数：session/event 为 (session, event) 两参，其余为单 payload
  // —— 与真宿主 ctx.on 的回调签名保持一致
  const dispose = host.on(event, (...args: unknown[]) => out.push(args[args.length - 1] as T));
  return [out, dispose];
}

/** 等一个宏任务间隙（让 fake 的脚本推进一帧）。 */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('fake host · agents service', () => {
  it('creates a new agent with the given session id and idle status', async () => {
    const host = makeFakeDshHost();

    const handle = await host.services.agents.create({
      sessionId: asHostSessionId('s1'),
      agentOptions: { provider: 'p', model: 'm' },
    });

    expect(handle.agent.session.id).toBe('s1');
    expect(handle.agent.status).toBe('idle');
    expect(host.log.map((c) => c.kind)).toContain('agents.create');
  });

  it('throws already-exists when creating a live session id again', async () => {
    // 探针实测：进程内面对已存在的活会话，create 是硬错误而非复用
    const host = makeFakeDshHost();
    await host.services.agents.create({ sessionId: asHostSessionId('s1'), agentOptions: { provider: 'p', model: 'm' } });

    await expect(
      host.services.agents.create({ sessionId: asHostSessionId('s1') }),
    ).rejects.toThrow(/already exists/u);
  });

  it('returns the live handle from get() and undefined for unknown ids', async () => {
    const host = makeFakeDshHost();
    const created = await host.services.agents.create({
      sessionId: asHostSessionId('s1'),
      agentOptions: { provider: 'p', model: 'm' },
    });

    const live = host.services.agents.get(asHostSessionId('s1'));
    // 官方类型事实：get 只承诺裸 Agent（判活面），断言 id 即可
    expect(live?.id).toBe(created.agent.session.id);
    expect(host.services.agents.get(asHostSessionId('nope'))).toBeUndefined();
  });

  it('can fail the next create for fault injection', async () => {
    const host = makeFakeDshHost();
    host.failNextCreate(new Error('boom'));

    await expect(
      host.services.agents.create({ sessionId: asHostSessionId('s1'), agentOptions: { provider: 'p', model: 'm' } }),
    ).rejects.toThrow('boom');
    // 一次性：第二次恢复正常
    await expect(
      host.services.agents.create({ sessionId: asHostSessionId('s1'), agentOptions: { provider: 'p', model: 'm' } }),
    ).resolves.toBeTruthy();
  });
});

describe('fake host · conversation scripting', () => {
  it('emits stream frames and session events in probed wire order on followup', async () => {
    // 探针互证的事件顺序：inbox 入箱 → turn/start → inbox 领取 → 流三帧
    // → assistant/message → turn/end(completed)
    const host = makeFakeDshHost();
    host.scriptReply({ text: 'Hello' });
    const [events, disposeE] = collector<{ type: string; data?: { reason?: { kind?: string } } }>(host, 'session/event');
    const [frames] = collector<{ frame: { type: string; chunk?: { type?: string; text?: string } } }>(host, 'agent/assistant-stream');

    const handle = await host.services.agents.create({
      sessionId: asHostSessionId('s1'),
      agentOptions: { provider: 'p', model: 'm' },
    });
    handle.agent.followup(userText('hi'));
    await handle.agent.whenIdle();

    expect(events.map((e) => e.type)).toEqual([
      'agent/inbox/spliced',
      'turn/start',
      'agent/inbox/spliced',
      'assistant/message',
      'turn/end',
    ]);
    expect(events.at(-1)?.data?.reason).toEqual({ kind: 'completed' }); // 源码事实：成功态 completed
    // 流帧：start → text-delta ×2 → finish → end(committed assistant/message)
    expect(frames.map((f) => f.frame.type)).toEqual(['start', 'chunk', 'chunk', 'chunk', 'end']);
    const chunkTypes = frames.filter((f) => f.frame.type === 'chunk').map((f) => f.frame.chunk?.type);
    expect(chunkTypes).toEqual(['text-delta', 'text-delta', 'finish']);
    disposeE();
  });

  it('splits scripted reply text into ordered text-delta chunks', async () => {
    const host = makeFakeDshHost();
    host.scriptReply({ text: 'Hello' });
    const [frames, disposeF] = collector<{ frame: { chunk?: { text?: string; type?: string } } }>(host, 'agent/assistant-stream');

    const handle = await host.services.agents.create({
      sessionId: asHostSessionId('s1'),
      agentOptions: { provider: 'p', model: 'm' },
    });
    handle.agent.followup(userText('hi'));
    await handle.agent.whenIdle();

    const deltas = frames
      .filter((f) => f.frame.chunk?.type === 'text-delta')
      .map((f) => f.frame.chunk?.text)
      .join('');
    expect(deltas).toBe('Hello'); // 增量拼接语义（源码事实：text-delta 需拼接）
    disposeF();
  });

  it('carries the full text block in assistant/message', async () => {
    const host = makeFakeDshHost();
    host.scriptReply({ text: 'Hello' });
    const [events, disposeE] = collector<{
      type: string;
      data?: { message?: { content?: Array<{ type: string; text?: string }> } };
    }>(host, 'session/event');

    const handle = await host.services.agents.create({
      sessionId: asHostSessionId('s1'),
      agentOptions: { provider: 'p', model: 'm' },
    });
    handle.agent.followup(userText('hi'));
    await handle.agent.whenIdle();

    const msg = events.find((e) => e.type === 'assistant/message');
    expect(msg?.data?.message?.content).toEqual([{ type: 'text', text: 'Hello' }]);
    disposeE();
  });

  it('flips agent status running then idle around the turn', async () => {
    const host = makeFakeDshHost();
    host.scriptReply({ text: 'ok' });
    const handle = await host.services.agents.create({
      sessionId: asHostSessionId('s1'),
      agentOptions: { provider: 'p', model: 'm' },
    });
    const statuses: string[] = [];
    host.on('agent/status', ({ status }: { status: string }) => statuses.push(status));

    handle.agent.followup(userText('hi'));
    expect(handle.agent.status).toBe('running');
    await handle.agent.whenIdle();
    expect(handle.agent.status).toBe('idle');
    expect(statuses).toEqual(['running', 'idle']); // 探针实测：status 事件只发翻转沿
  });

  it('resolves whenIdle immediately for an idle agent', async () => {
    const host = makeFakeDshHost();
    const handle = await host.services.agents.create({
      sessionId: asHostSessionId('s1'),
      agentOptions: { provider: 'p', model: 'm' },
    });
    await expect(handle.agent.whenIdle()).resolves.toBeUndefined();
  });

  it('queues multiple scripted replies in FIFO order', async () => {
    // 适配层测试常编排连续问答：脚本队列按 feed 顺序消耗
    const host = makeFakeDshHost();
    host.scriptReply({ text: 'first' });
    host.scriptReply({ text: 'second' });
    const [events, disposeE] = collector<{ type: string; data?: { message?: { content?: Array<{ text?: string }> } } }>(host, 'session/event');

    const handle = await host.services.agents.create({
      sessionId: asHostSessionId('s1'),
      agentOptions: { provider: 'p', model: 'm' },
    });
    handle.agent.followup(userText('q1'));
    await handle.agent.whenIdle();
    handle.agent.followup(userText('q2'));
    await handle.agent.whenIdle();

    const answers = events
      .filter((e) => e.type === 'assistant/message')
      .map((e) => e.data?.message?.content?.[0]?.text);
    expect(answers).toEqual(['first', 'second']);
    disposeE();
  });
});

describe('fake host · failure paths', () => {
  it('replays the measured transport-failure pattern', async () => {
    // 探针实测的失败序列：每次尝试 assistant/attempt（流三帧收口为
    // committed→attempt）+ llm/retry，N 次后 turn/end(error) + agent/error
    const host = makeFakeDshHost();
    host.scriptFailure({ attempts: 2, failure: { message: 'DeepSeek Messages transport failed', code: 'TRANSPORT' } });
    const [events, disposeE] = collector<{
      type: string;
      data?: { reason?: { kind?: string; error?: { code?: string } }; retry?: number; maxRetries?: number; failure?: { code?: string } };
    }>(host, 'session/event');
    const [frames] = collector<{ type: string }>(host, 'agent/assistant-stream');
    const [agentErrors, disposeA] = collector<{ error: { name?: string; message?: string; code?: string } }>(host, 'agent/error');

    const handle = await host.services.agents.create({
      sessionId: asHostSessionId('s1'),
      agentOptions: { provider: 'p', model: 'm' },
    });
    handle.agent.followup(userText('hi'));
    await handle.agent.whenIdle();

    expect(events.map((e) => e.type)).toEqual([
      'agent/inbox/spliced',
      'turn/start',
      'agent/inbox/spliced',
      'assistant/attempt',
      'llm/retry',
      'assistant/attempt',
      'turn/end',
    ]);
    // 探针精确模式：N 次 attempt 只伴随 N-1 次 retry（最后一次失败不再重试）
    // llm/retry 的 failure 形态（探针：message 34 字符 + code TRANSPORT）
    const retry = events.find((e) => e.type === 'llm/retry');
    expect(retry?.data?.failure?.code).toBe('TRANSPORT');
    // 收口：turn/end error 携带结构化 LlmFailure
    const end = events.at(-1);
    expect(end?.data?.reason).toEqual({
      kind: 'error',
      error: { message: 'DeepSeek Messages transport failed', code: 'TRANSPORT' },
    });
    // 每次失败尝试都有流三帧（start/finish-chunk/end committed→attempt）
    expect(frames.length).toBe(2 * 3);
    expect(agentErrors[0]?.error?.message).toContain('transport failed'); // agent/error 事件同步发生
    disposeE();
    disposeA();
  });

  it('ends the turn as aborted when cancelled mid-script and stays clean for the next followup', async () => {
    // 源码事实（abort）：cancel 后 turn/end(aborted)，会话不被污染，
    // 下一条 followup 正常开新 turn
    const host = makeFakeDshHost();
    host.scriptReply({ text: 'never finishes', chunkPauseMs: 50 });
    host.scriptReply({ text: 'after cancel' });
    const [events, disposeE] = collector<{ type: string; data?: { reason?: { kind?: string } } }>(host, 'session/event');

    const handle = await host.services.agents.create({
      sessionId: asHostSessionId('s1'),
      agentOptions: { provider: 'p', model: 'm' },
    });
    handle.agent.followup(userText('hi'));
    await tick(); // 让脚本开始跑
    handle.agent.cancel({ kind: 'user' });
    await handle.agent.whenIdle();

    const firstTurnEnd = events.find((e) => e.type === 'turn/end');
    expect(firstTurnEnd?.data?.reason?.kind).toBe('aborted');

    // 中止后新消息正常（waking-after-abort 不污染）
    handle.agent.followup(userText('again'));
    await handle.agent.whenIdle();
    const ends = events.filter((e) => e.type === 'turn/end').map((e) => e.data?.reason?.kind);
    expect(ends).toEqual(['aborted', 'completed']);
    disposeE();
  });
});

describe('fake host · workspace & registry', () => {
  it('registers workspaces and tracks attached sessions', async () => {
    const host = makeFakeDshHost();
    const ws = await host.services.workspaceRegistry.create('/tmp/ws-a');

    expect(ws.path).toBe('/tmp/ws-a');
    expect(ws.sessionIds).toEqual([]);

    await ws.attachSession(asHostSessionId('s1'));
    expect(ws.sessionIds).toEqual(['s1']);

    await ws.detachSession(asHostSessionId('s1'));
    expect(ws.sessionIds).toEqual([]);
  });

  it('exposes a mutable archivedSessionIds array shared with the registry', async () => {
    // 探针实测：archivedSessionIds 可直读（数组），includes 判归档
    const host = makeFakeDshHost();
    host.archivedSessionIds.push(asHostSessionId('old-session'));

    expect(host.services.workspaceRegistry.archivedSessionIds.includes(asHostSessionId('old-session'))).toBe(true);
    expect(host.services.workspaceRegistry.archivedSessionIds.includes(asHostSessionId('s1'))).toBe(false);
  });

  it('reports model selection from setModelSelection', () => {
    const host = makeFakeDshHost();
    host.setModelSelection({ provider: 'deepseek-official', model: 'deepseek-chat' });

    expect(host.services.agentDefaultModel.currentSelection()).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
    });
  });

  it('records rename calls and returns the probed result shape', () => {
    // 探针实测返回：{ title, messageSeqs, source, eventSeq, updatedAt }
    const host = makeFakeDshHost();

    const result = host.services.sessionTitle.rename({ id: asHostSessionId('s1') } as never, 'imessage +8613800000000');

    expect(result.title).toBe('imessage +8613800000000');
    expect(typeof result.eventSeq).toBe('number');
    expect(host.log).toContainEqual(
      expect.objectContaining({ kind: 'sessionTitle.rename', title: 'imessage +8613800000000' }),
    );
  });
});

describe('fake host · event bus', () => {
  it('delivers events to listeners until disposed', async () => {
    const host = makeFakeDshHost();
    const seen: string[] = [];
    // session/event 是两参回调 (Session 对象, event)，与真宿主一致
    const dispose = host.on('session/event', (_session, e) => seen.push(e.type));

    host.emitSessionEvent('custom/one', {});
    dispose();
    host.emitSessionEvent('custom/two', {});

    expect(seen).toEqual(['custom/one']);
  });
});
