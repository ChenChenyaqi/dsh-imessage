import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  asSessionId,
  type DshPort,
  type SessionStatus,
} from '@/core/types/dsh';
import { makeFakeDshPort } from '../../helpers/fake-dsh-port';

// ---------------------------------------------------------------------------
// 类型契约（branded SessionId 编译期防护）
// ---------------------------------------------------------------------------

describe('SessionId typing', () => {
  const port = makeFakeDshPort();

  it('rejects plain strings where SessionId is required', () => {
    // @ts-expect-error plain string 不兼容 branded SessionId
    expect(() => port.getSessionStatus('oops')).toBeDefined();
  });

  it('asSessionId casts and stays assignable to string', () => {
    const id = asSessionId('dsh-1');
    expectTypeOf(id).toEqualTypeOf<import('@/core/types/dsh').SessionId>();
    const asPlain: string = id; // branded 是 string 的子类型
    expect(asPlain).toBe('dsh-1');
  });

  it('fake satisfies the DshPort contract', () => {
    expectTypeOf(port).toMatchTypeOf<DshPort>();
  });
});

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

describe('fake dsh port · createSession', () => {
  it('issues sequential ids registered as active', async () => {
    const port = makeFakeDshPort();
    const a = await port.createSession({ workspaceDir: 'conversations/x', name: 'imessage +861' });
    const b = await port.createSession({ workspaceDir: 'conversations/y', name: 'imessage +862' });
    expect(a).toBe('dsh-1');
    expect(b).toBe('dsh-2');
    expect(await port.getSessionStatus(a)).toBe<SessionStatus>('active');
    expect(port.createdCalls).toHaveLength(2);
    expect(port.createdCalls[0]?.name).toBe('imessage +861');
  });

  it('injects a one-shot create failure', async () => {
    const port = makeFakeDshPort();
    port.failNextCreate(new Error('boom'));
    await expect(
      port.createSession({ workspaceDir: 'conversations/x', name: 'n' }),
    ).rejects.toThrow('boom');
    const id = await port.createSession({ workspaceDir: 'conversations/x', name: 'n' });
    expect(id).toBe('dsh-1'); // 失败不占序号
  });
});

// ---------------------------------------------------------------------------
// getSessionStatus
// ---------------------------------------------------------------------------

describe('fake dsh port · getSessionStatus', () => {
  it('reports missing for unknown ids and honors manual statuses', async () => {
    const port = makeFakeDshPort();
    const id = await port.createSession({ workspaceDir: 'w', name: 'n' });
    expect(await port.getSessionStatus(asSessionId('dsh-999'))).toBe('missing');
    port.statuses.set(id, 'archived');
    expect(await port.getSessionStatus(id)).toBe('archived');
    port.statuses.delete(id);
    expect(await port.getSessionStatus(id)).toBe('missing');
  });
});

// ---------------------------------------------------------------------------
// ask（脚本队列 + 调用记录 + abort）
// ---------------------------------------------------------------------------

describe('fake dsh port · ask', () => {
  it('records the call immediately (before iteration)', async () => {
    const port = makeFakeDshPort();
    const stream = port.ask({ sessionId: asSessionId('dsh-1'), prompt: 'hi' });
    expect(port.askCalls).toHaveLength(1); // 未迭代即已记录
    expect(port.askCalls[0]?.prompt).toBe('hi');
    for await (const _ of stream) void _; // 消费掉
  });

  it('returns the default reply when no script is queued', async () => {
    const port = makeFakeDshPort();
    const chunks: string[] = [];
    for await (const c of port.ask({ sessionId: asSessionId('dsh-1'), prompt: 'hi' })) {
      chunks.push(c);
    }
    expect(chunks).toEqual(['(fake)']);
  });

  it('plays queued scripts in FIFO order with chunked output', async () => {
    const port = makeFakeDshPort();
    port.queueAsk({ chunks: ['你好', '，', '世界'] });
    port.queueAsk({ chunks: ['second'] });
    const collect = async () => {
      const out: string[] = [];
      for await (const c of port.ask({ sessionId: asSessionId('dsh-1'), prompt: 'p' })) out.push(c);
      return out.join('');
    };
    expect(await collect()).toBe('你好，世界');
    expect(await collect()).toBe('second');
  });

  it('throws after chunks when failWith is set (mid-stream failure)', async () => {
    const port = makeFakeDshPort();
    port.queueAsk({ chunks: ['partial'], failWith: new Error('stream broke') });
    const out: string[] = [];
    await expect(async () => {
      for await (const c of port.ask({ sessionId: asSessionId('dsh-1'), prompt: 'p' })) out.push(c);
    }).rejects.toThrow('stream broke');
    expect(out).toEqual(['partial']); // 断流前的片段已产出
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const port = makeFakeDshPort();
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(async () => {
      for await (const _ of port.ask({
        sessionId: asSessionId('dsh-1'),
        prompt: 'p',
        signal: controller.signal,
      })) void _;
    }).rejects.toThrow('stop');
  });

  it('can skip abort checks per script (checkAbort: false)', async () => {
    const port = makeFakeDshPort();
    const controller = new AbortController();
    port.queueAsk({ chunks: ['ok'], checkAbort: false });
    const stream = port.ask({
      sessionId: asSessionId('dsh-1'),
      prompt: 'p',
      signal: controller.signal,
    });
    controller.abort(); // 流已创建后才 abort：本脚本不检查，仍完整产出
    const out: string[] = [];
    for await (const c of stream) out.push(c);
    expect(out).toEqual(['ok']);
  });
});
