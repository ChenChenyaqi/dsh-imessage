// dsh-imessage · Step 0 真机探针（A 路线 / webhook 范式）
//
// 目标：在真 DSH 宿主进程内验证 M4 适配层依赖的全部 API 形状，
// 与源码事实（docs/host-api-facts-*.md）互证。输出脱敏 result.json：
// 只记结构（类型/字段名/长度/顺序），不落任何用户数据。
//
// 用法：dsh web --patch /tmp/dsh-probe/probe.yml

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

export const name = 'dsh-imessage-probe';
// 只硬依赖两个核心服务，其余用 typeof 探测（缺服务不卡启动）
export const inject = ['agents', 'workspaceRegistry', 'agentDefaultModel', 'sessionTitle', 'agentPresets', 'permissionPresets'];

const OUT = '/tmp/dsh-probe/result.json';
const t0 = Date.now();

function shape(value, depth = 0) {
  // 脱敏序列化：字符串记长度，数组记元素形状（首 3 个），对象记字段名与递归形状
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') return { s: value.length };
  if (t === 'number' || t === 'boolean') return value;
  if (Array.isArray(value)) {
    return { a: value.length, items: value.slice(0, 3).map((v) => shape(v, depth + 1)) };
  }
  if (t === 'object') {
    if (depth >= 3) return { keys: Object.keys(value) };
    const out = { keys: Object.keys(value) };
    for (const k of Object.keys(value)) out[k] = shape(value[k], depth + 1);
    return out;
  }
  if (t === 'function') return { fn: value.name || '(anon)' };
  return t;
}

async function run(ctx, result) {
  // -- 1. 服务存在性 -------------------------------------------------------
  const services = [
    'agents', 'workspaceRegistry', 'sessionTitle', 'agentPresets',
    'permissionPresets', 'agentDefaultModel', 'sessions', 'logger',
  ];
  for (const n of services) {
    try { result.services[n] = shape(ctx[n], 1); } catch (e) { result.services[n] = `throw: ${e?.message}`; }
  }
  result.serviceMethods = {
    agents: ctx.agents ? Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.agents)).filter((m) => m !== 'constructor') : null,
    workspaceRegistry: ctx.workspaceRegistry
      ? Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.workspaceRegistry)).filter((m) => m !== 'constructor')
      : null,
    agent: null, // 创建后补
  };

  // -- 2. 默认模型与 preset（可失败：记录错误形态即达标）--------------------
  try { result.defaultModel = shape(ctx.agentDefaultModel?.currentSelection?.(), 2); } catch (e) { result.defaultModel = err(e); }
  try {
    const p = await ctx.agentPresets?.resolve?.('default');
    result.agentPresetDefault = shape(p, 2);
  } catch (e) { result.agentPresetDefault = err(e); }

  // -- 3. workspaceRegistry.create ----------------------------------------
  const wsDir = `/tmp/dsh-probe/ws-${randomUUID().slice(0, 8)}`;
  mkdirSync(wsDir, { recursive: true }); // realpath 校验要求目录已存在
  const ws = await ctx.workspaceRegistry.create(wsDir);
  result.workspaceCreate = shape(ws, 1);
  result.workspaceMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(ws)).filter((m) => m !== 'constructor');

  // -- 4. agents.create + attach + title -----------------------------------
  // 模型必配：webhook 范式从 agentDefaultModel 拿当前选择
  const selection = ctx.agentDefaultModel.currentSelection();
  result.modelSelection = shape(selection, 2);
  const sessionId = `imessage-probe-${randomUUID()}`;
  const createdIds = [sessionId];
  const handle = await ctx.agents.create({
    sessionId,
    meta: { cwd: wsDir },
    agentOptions: { ...selection },
  });
  result.agentsCreateHandle = shape({ hasAgent: !!handle.agent, disposeType: typeof handle.dispose }, 2);
  result.serviceMethods.agent = Object.getOwnPropertyNames(Object.getPrototypeOf(handle.agent)).filter((m) => m !== 'constructor');
  try { await ws.attachSession(sessionId); result.attachSession = 'ok'; } catch (e) { result.attachSession = err(e); }
  try {
    const r = ctx.sessionTitle?.rename?.(handle.agent.session, 'imessage probe');
    result.sessionTitle = r instanceof Promise ? 'async' : shape(r, 2);
  } catch (e) { result.sessionTitle = err(e); }

  // -- 5. followup + 事件收集（监听已在外层提前挂好）------------------------
  const prompt = 'Reply with exactly: PROBE-OK';
  handle.agent.followup({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  });
  result.followupQueuedAt = Date.now() - t0;

  // -- 6. whenIdle（90s 兜底）----------------------------------------------
  await Promise.race([
    handle.agent.whenIdle(),
    new Promise((resolve) => setTimeout(resolve, 90_000)),
  ]);
  result.idleAt = Date.now() - t0;

  // -- 7. 归档面（getSessionStatus 的数据源）-------------------------------
  try {
    const registry = ctx.workspaceRegistry;
    const archived = registry.archivedSessionIds;
    result.archivedSessionIds = Array.isArray(archived) ? { a: archived.length, sample: shape(archived[0]) } : shape(archived);
    result.archivedContainsProbe = archived?.includes?.(sessionId) ?? 'no-method';
  } catch (e) { result.archivedSessionIds = err(e); }

  // -- 8. 活会话重入（进程内面：get vs create 已存在）------------------------
  try {
    const live = ctx.agents.get(sessionId);
    const sess = live?.session;
    result.agentsGetLive = { found: !!live, sessionType: typeof sess, sessionIsId: sess === sessionId, sessionIdShape: sess?.id ? shape(sess.id) : 'no-id-field', sessionKeys: sess && typeof sess === 'object' ? Object.keys(sess).slice(0, 12) : null, status: live?.status };
  } catch (e) { result.agentsGetLive = err(e); }
  try {
    const h2 = await ctx.agents.create({ sessionId }); // 同 id、已有 turn
    const id2 = h2?.agent?.session?.id;
    result.recreateSameId = { sameSession: id2 === sessionId, idType: typeof h2?.agent?.session };
    await h2.dispose?.();
  } catch (e) { result.recreateSameId = err(e); }

  // -- 9. 新 id create（全新会话，正常路径二次采样）-------------------------
  try {
    const id3 = `imessage-probe-${randomUUID()}`;
    const h3 = await ctx.agents.create({ sessionId: id3, meta: { cwd: wsDir } });
    result.createFresh = { ok: true };
    createdIds.push(id3);
    await h3.dispose?.();
  } catch (e) { result.createFresh = err(e); }

  // -- 10. 冷会话实验：dispose 后 get/resume 的真实形态（getSessionStatus 依据）
  try {
    const live = ctx.agents.get(sessionId);
    result.coldBefore = { getFound: !!live };
    await handle.dispose?.(); // 模拟 agent 结束：会话持久存在、活句柄消失
    const afterDispose = ctx.agents.get(sessionId);
    result.coldAfterDispose = { getFound: !!afterDispose };
    const resumed = await ctx.agents.resume({ resumeSessionId: sessionId });
    result.coldResume = {
      ok: true,
      sameSession: resumed?.agent?.session?.id === sessionId,
      status: resumed?.agent?.status,
    };
  } catch (e) { result.coldResume = err(e); }
  try {
    // resume 不存在的 id：错误形态（适配层判 missing 的依据）
    await ctx.agents.resume({ resumeSessionId: `imessage-probe-ghost-${randomUUID()}` });
    result.coldResumeGhost = { ok: true, unexpected: true };
  } catch (e) { result.coldResumeGhost = err(e); }

  result.createdIds = createdIds;
}

function err(e) {
  return { error: e?.message ?? String(e), name: e?.name, code: e?.code ?? e?.failure?.code, keys: e ? Object.keys(e) : [] };
}

export function apply(ctx) {
  const result = {
    startedAt: new Date().toISOString(),
    services: {},
    sessionEvents: [],   // (session, event)：持久事件序列
    streamFrames: [],    // assistant-stream：token 流帧序列
    agentEvents: [],     // agent/error、agent/status
  };

  // 事件监听先于一切动作挂好（事件是 fake 宿主的直接素材）
  const disposers = [
    ctx.on('session/event', (session, event) => {
      result.sessionEvents.push({
        type: event?.type,
        seq: event?.seq,
        dataKeys: event?.data ? Object.keys(event.data) : [],
        // 关键事件的深度形状（脱敏）
        detail: event?.type === 'assistant/message'
          ? { turn: shape(event.data?.turn), blocks: event.data?.message?.content?.map((b) => b.type), interrupted: event.data?.interrupted }
          : event?.type === 'turn/end'
            ? { turn: shape(event.data?.turn), reasonKind: event.data?.reason?.kind, reasonKeys: event.data?.reason ? Object.keys(event.data.reason) : [] }
            : event?.type === 'llm/retry'
              ? { provider: event.data?.provider, mode: event.data?.mode, retry: event.data?.retry, maxRetries: event.data?.maxRetries, failure: shape(event.data?.failure, 2) }
              : undefined,
      });
    }),
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      result.streamFrames.push({
        frameType: frame?.type,
        chunkType: frame?.chunk?.type,
        textLen: typeof frame?.chunk?.text === 'string' ? frame.chunk.text.length : undefined,
        index: frame?.index,
        outcome: frame?.outcome ? { kind: frame.outcome.kind, eventType: frame.outcome.eventType } : undefined,
      });
    }),
    ctx.on('agent/error', (payload) => {
      result.agentEvents.push({ kind: 'agent/error', errorName: payload?.error?.name, message: payload?.error?.message?.slice(0, 120) });
    }),
    ctx.on('agent/status', ({ agent, status }) => {
      result.agentEvents.push({ kind: 'agent/status', status });
    }),
  ];

  const finish = (status, error) => {
    result.status = status;
    result.error = error ?? null;
    result.elapsedMs = Date.now() - t0;
    result.eventCounts = {
      session: result.sessionEvents.length,
      stream: result.streamFrames.length,
      agent: result.agentEvents.length,
    };
    try {
      writeFileSync(OUT, JSON.stringify(result, null, 1));
      console.log(`[dsh-imessage-probe] ${status} -> ${OUT}`);
    } catch (e) {
      console.log(`[dsh-imessage-probe] WRITE FAILED: ${e?.message}`);
    }
  };

  // 全局兜底：3 分钟必退
  const kill = setTimeout(() => { finish('timeout'); process.exit(1); }, 180_000);

  run(ctx, result)
    .then(async () => {
      // 给尾随事件（turn/end 等 post-commit 推送）一点到达时间
      await new Promise((r) => setTimeout(r, 1_500));
      clearTimeout(kill);
      for (const d of disposers) typeof d === 'function' ? d() : d?.();
      finish('ok');
      process.exit(0);
    })
    .catch((e) => {
      clearTimeout(kill);
      finish('failed', err(e));
      process.exit(1);
    });
}
