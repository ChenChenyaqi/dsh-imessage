// host/dsh-port.ts 适配层的规格测试（M4 Step 2 · 测试先行）。
//
// makeDshPort 把宿主服务面（src/host/dsh-api.ts，A 路线进程内范式）
// 适配成 core 的 DshPort 契约（M3 冻结：createSession/getSessionStatus/ask）。
// 规格全部来自实测事实：
// - 探针互证：活会话 get / 冷会话 resume / ghost 抛
//   SessionPersistenceNotFoundError / create 必带 agentOptions / rename 收
//   Session 对象 / attach 前目录必须存在
// - 源码事实：text-delta 增量拼接、turn/end 五态、abort 后会话不污染
//
// 测试策略：makeFakeDshHost 驱动（回调签名与真宿主一致，适配层代码
// 可无差异复用）；mkdir 注入为记录型 no-op（host 层允许真 IO，但测试
// 不落盘）。

import { describe, expect, it } from 'vitest';
import { asSessionId } from '@/core/types/dsh';
import { makeDshPort } from '@/host/dsh-port';
import { makeFakeDshHost } from '../helpers/fake-dsh-api';

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

function makePort() {
  const host = makeFakeDshHost();
  const mkdirCalls: string[] = [];
  const port = makeDshPort({
    services: host.services,
    events: host, // fake 的 on 与真宿主 ctx.on 同签名
    dataRoot: '/data/root',
    // 注入 no-op mkdir：只记录路径，不真建目录
    mkdir: async (dir) => {
      mkdirCalls.push(dir);
    },
  });
  return { host, port, mkdirCalls };
}

/** 跑完一次 ask 并收集片段。 */
async function collectAsk(
  stream: AsyncIterable<string>,
): Promise<{ parts: string[]; text: string }> {
  const parts: string[] = [];
  for await (const part of stream) parts.push(part);
  return { parts, text: parts.join('') };
}

describe('dsh-port · createSession', () => {
  it('creates workspace, session, attach and rename in order', async () => {
    const { host, port, mkdirCalls } = makePort();

    const sessionId = await port.createSession({
      workspaceDir: 'ws/+8613800000000',
      name: 'imessage +8613800000000',
    });

    // mkdir 先行（探针：realpath 校验要求目录已存在）
    expect(mkdirCalls).toEqual(['/data/root/ws/+8613800000000']);
    // 台账顺序：workspace.create → agents.create → attach → rename
    expect(host.log.map((c) => c.kind)).toEqual([
      'workspaceRegistry.create',
      'agents.create',
      'workspace.attachSession',
      'sessionTitle.rename',
    ]);
    // workspace 用的是数据根下的绝对路径
    expect(host.log[0]?.path).toBe('/data/root/ws/+8613800000000');
    // 会话命名对齐 webhook 惯例（imessage- 前缀）
    expect(String(sessionId)).toMatch(/^imessage-/u);
    expect(host.log[2]?.sessionId).toBe(sessionId);
  });

  it('creates the session with the current model selection', async () => {
    const { host, port } = makePort();
    host.setModelSelection({ provider: 'deepseek-official', model: 'deepseek-chat' });

    await port.createSession({ workspaceDir: 'ws/a', name: 'imessage a' });

    // 探针事实：agents.create 必带 agentOptions（无默认兜底）
    expect(host.log[1]?.options).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' });
  });

  it('propagates create failures as-is', async () => {
    const { host, port } = makePort();
    host.failNextCreate(new Error('boom'));

    await expect(
      port.createSession({ workspaceDir: 'ws/a', name: 'imessage a' }),
    ).rejects.toThrow('boom');
  });

  it('disposes the agent and rethrows when attach fails', async () => {
    const { host, port } = makePort();
    host.failNextAttach(new Error('attach rejected'));

    await expect(
      port.createSession({ workspaceDir: 'ws/a', name: 'imessage a' }),
    ).rejects.toThrow('attach rejected');
    // 回滚：不留孤儿活 agent（webhook 事务语义）
    expect(host.log.map((c) => c.kind)).toContain('agents.dispose');
    expect(host.services.agents.get(host.log[1]?.sessionId as string)).toBeUndefined();
  });
});

describe('dsh-port · getSessionStatus', () => {
  it('reports active for a live session', async () => {
    const { port } = makePort();
    const sessionId = await port.createSession({ workspaceDir: 'ws/a', name: 'imessage a' });

    await expect(port.getSessionStatus(sessionId)).resolves.toBe('active');
  });

  it('reports archived even when the agent is live', async () => {
    // 归档集与活动状态独立（源码事实：archived gate 只冻结模型步）
    const { host, port } = makePort();
    const sessionId = await port.createSession({ workspaceDir: 'ws/a', name: 'imessage a' });
    host.archivedSessionIds.push(String(sessionId));

    await expect(port.getSessionStatus(sessionId)).resolves.toBe('archived');
  });

  it('resumes a cold persisted session and reports active', async () => {
    const { host, port } = makePort();
    const sessionId = await port.createSession({ workspaceDir: 'ws/a', name: 'imessage a' });
    // 模拟宿主重启：活句柄消失、持久层仍在
    await host.services.agents.get(String(sessionId))?.dispose();

    await expect(port.getSessionStatus(sessionId)).resolves.toBe('active');
    // 探针事实：冷会话经 resume 复活（sameSession true）
    expect(host.log.map((c) => c.kind)).toContain('agents.resume');
  });

  it('reports missing for an unknown session id', async () => {
    const { host, port } = makePort();

    await expect(port.getSessionStatus(asSessionId('imessage-ghost'))).resolves.toBe('missing');
    // 判定路径：get 落空后 resume 试探（探针：SessionPersistenceNotFoundError）
    expect(host.log.map((c) => c.kind)).toEqual(['agents.resume']);
  });

  it('propagates non-notfound resume failures as-is', async () => {
    // 磁盘 IO 等非 NotFound 失败不能误判 missing（否则 router 会重建会话丢上下文）
    const { host, port } = makePort();
    host.failNextResume(new Error('disk io error'));

    await expect(port.getSessionStatus(asSessionId('imessage-any'))).rejects.toThrow('disk io error');
  });
});

describe('dsh-port · ask', () => {
  it('streams ordered text deltas and completes', async () => {
    const { host, port } = makePort();
    host.scriptReply({ text: 'Hello' });
    const sessionId = await port.createSession({ workspaceDir: 'ws/a', name: 'imessage a' });

    const { parts, text } = await collectAsk(port.ask({ sessionId, prompt: 'hi' }));

    // fake 把脚本文本拆两半发 text-delta：两条片段、拼接还原
    expect(parts).toEqual(['He', 'llo']);
    expect(text).toBe('Hello');
  });

  it('supports consecutive asks in fifo script order', async () => {
    const { host, port } = makePort();
    host.scriptReply({ text: 'first' });
    host.scriptReply({ text: 'second' });
    const sessionId = await port.createSession({ workspaceDir: 'ws/a', name: 'imessage a' });

    const one = await collectAsk(port.ask({ sessionId, prompt: 'q1' }));
    const two = await collectAsk(port.ask({ sessionId, prompt: 'q2' }));

    expect(one.text).toBe('first');
    expect(two.text).toBe('second');
  });

  it('throws a structured error carrying the llm failure code when the turn fails', async () => {
    const { host, port } = makePort();
    host.scriptFailure({
      attempts: 2,
      failure: { message: 'DeepSeek Messages transport failed', code: 'TRANSPORT' },
    });
    const sessionId = await port.createSession({ workspaceDir: 'ws/a', name: 'imessage a' });

    // 错误要带稳定 code（B+ 重试预算与日志按 code 归因）
    await expect(collectAsk(port.ask({ sessionId, prompt: 'hi' }))).rejects.toMatchObject({
      code: 'TRANSPORT',
      message: expect.stringContaining('transport failed') as unknown,
    });
  });

  it('cancels the agent and rejects with the abort reason when signal fires mid-stream', async () => {
    const { host, port } = makePort();
    host.scriptReply({ text: 'slow reply', chunkPauseMs: 50 });
    const sessionId = await port.createSession({ workspaceDir: 'ws/a', name: 'imessage a' });
    const controller = new AbortController();

    const stream = port.ask({ sessionId, prompt: 'hi', signal: controller.signal });
    const collected: string[] = [];
    // 迭代中途触发 abort（第一片到达后）
    const consumption = (async () => {
      for await (const part of stream) {
        collected.push(part);
        controller.abort(new Error('user stopped'));
      }
    })();

    await expect(consumption).rejects.toThrow('user stopped');
    // 宿主侧收到了 cancel（源码事实：cancel({kind:'user'}) 中止活动 turn）
    expect(host.log).toContainEqual(
      expect.objectContaining({ kind: 'agent.cancel', cause: 'user' }),
    );
  });

  it('accepts the next ask after an aborted one without pollution', async () => {
    // 源码事实（waking-after-abort）：中止后下一条消息正常开新 turn
    const { host, port } = makePort();
    host.scriptReply({ text: 'interrupted', chunkPauseMs: 50 });
    host.scriptReply({ text: 'all good' });
    const sessionId = await port.createSession({ workspaceDir: 'ws/a', name: 'imessage a' });
    const controller = new AbortController();

    const first = (async () => {
      for await (const _part of port.ask({ sessionId, prompt: 'hi', signal: controller.signal })) {
        controller.abort(new Error('stop'));
      }
    })();
    await expect(first).rejects.toThrow('stop');

    const { text } = await collectAsk(port.ask({ sessionId, prompt: 'again' }));
    expect(text).toBe('all good');
  });

  it('resumes a cold session transparently before asking', async () => {
    const { host, port } = makePort();
    host.scriptReply({ text: 'revived' });
    const sessionId = await port.createSession({ workspaceDir: 'ws/a', name: 'imessage a' });
    await host.services.agents.get(String(sessionId))?.dispose();

    const { text } = await collectAsk(port.ask({ sessionId, prompt: 'hi' }));

    expect(text).toBe('revived');
    expect(host.log.map((c) => c.kind)).toContain('agents.resume');
  });

  it('removes event listeners after the stream completes', async () => {
    const { host, port } = makePort();
    host.scriptReply({ text: 'done' });
    const sessionId = await port.createSession({ workspaceDir: 'ws/a', name: 'imessage a' });

    await collectAsk(port.ask({ sessionId, prompt: 'hi' }));

    // 监听器必须卸载：长跑进程里泄漏的监听会拖垮宿主
    expect(host.listenerCount('session/event')).toBe(0);
    expect(host.listenerCount('agent/assistant-stream')).toBe(0);
  });

  it('removes event listeners when the consumer breaks early', async () => {
    const { host, port } = makePort();
    host.scriptReply({ text: 'long reply text' });
    const sessionId = await port.createSession({ workspaceDir: 'ws/a', name: 'imessage a' });

    for await (const _part of port.ask({ sessionId, prompt: 'hi' })) {
      break; // 消费者提前退出
    }
    // AsyncGenerator 的 return 钩子也要卸载监听
    await new Promise((resolve) => setImmediate(resolve));
    expect(host.listenerCount('session/event')).toBe(0);
    expect(host.listenerCount('agent/assistant-stream')).toBe(0);
  });

  it('rejects when the host cancels the turn externally', async () => {
    // 非本方 signal 的中止（宿主侧外部取消）：按 abort 语义上抛
    const { host, port } = makePort();
    host.scriptReply({ text: 'interrupted externally', chunkPauseMs: 50 });
    const sessionId = await port.createSession({ workspaceDir: 'ws/a', name: 'imessage a' });

    const consumption = (async () => {
      for await (const _part of port.ask({ sessionId, prompt: 'hi' })) {
        // 第一片到达后从宿主侧外部取消（不经 signal）
        host.services.agents.get(String(sessionId))?.agent.cancel({ kind: 'parent' });
      }
    })();

    await expect(consumption).rejects.toThrow('ask aborted by host');
  });
});
