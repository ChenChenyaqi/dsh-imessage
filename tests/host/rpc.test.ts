// host/rpc.ts 管理面的规格测试（M4 Step 4 · 测试先行）。
//
// 路线（实测事实，dsh-im 先例）：ctx.connection.fetch.register 挂
// POST /api/<endpoint> 路由，手工处理 client-request envelope →
// server-response。不走 TypertRemoteService——其客户端面需要生成
// 产物（Client Remote 拒绝挂载 SRC 描述符），对最小只读面过重。
//
// 安全面（对齐 dsh-im 事实）：DSH 在 handler 前已做浏览器鉴权与
// Host/Origin 信任；本层再加 loopback 校验（仅限本地访问）作纵深。
// status 为只读低敏数据（phase/probe/cursor/计数）。

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerStatusRpc } from '@/host/rpc';
import type { ChannelStatus } from '@/host/channel';

// ---------------------------------------------------------------------------
// fake connection.fetch registry
// ---------------------------------------------------------------------------

interface RegisteredRoute {
  readonly path: string;
  readonly methods: string[];
  fetch(request: FakeRequest): Promise<Response>;
}

interface FakeRequest {
  readonly method: string;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

function makeRegistry() {
  let route: RegisteredRoute | undefined;
  const disposeSpy = { calls: 0 };
  return {
    get path() {
      return route?.path;
    },
    get methods() {
      return route?.methods;
    },
    disposeSpy,
    /** 直接以原始请求对象调 handler（覆盖 json() 抛错等边界）。 */
    callRaw(request: FakeRequest): Promise<Response> {
      if (!route) throw new Error('no route registered');
      return route.fetch(request);
    },
    /** 以给定请求调一次 handler（headers 对齐真 Headers 的 get 接口）。 */
    call(method: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
      if (!route) throw new Error('no route registered');
      return route.fetch({
        method,
        headers: {
          get(name: string): string | null {
            return headers[name.toLowerCase()] ?? headers[name] ?? null;
          },
        },
        json: async () => body,
      });
    },
    registry: {
      register(definition: {
        path: string;
        methods: string[];
        fetch(request: FakeRequest): Promise<Response>;
      }) {
        route = definition;
        return () => {
          disposeSpy.calls += 1;
          route = undefined;
        };
      },
    },
  };
}

function makeDeps(overrides: { status?: ChannelStatus } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rpc-test-'));
  const stateFile = join(root, 'state.json');
  writeFileSync(
    stateFile,
    // 完整合法形状（isChannelState 守卫：version/bindHistory 必需）
    JSON.stringify({
      version: 1,
      cursor: 42,
      seenIds: ['a'],
      sessions: {
        '+8613800000000': { sessionId: 's1', workspaceDir: 'w', bindHistory: ['s1'] },
      },
    }),
    'utf8',
  );
  return {
    root,
    deps: {
      // 对齐 ChannelHandle.status()：是 getter 函数而非值
      status: () => overrides.status ?? { phase: 'running' },
      stateFile,
      allowlist: () => ['+8613800000000', '+8613900000000'],
    },
  };
}

const JSON_HEADERS = { 'content-type': 'application/json', host: 'localhost:3080' };
const OK_BODY = { type: 'client-request', rpcId: 'rpc-1', method: 'dsh-imessage/status', payload: {} };

// ---------------------------------------------------------------------------
// 规格
// ---------------------------------------------------------------------------

describe('rpc · registration', () => {
  it('registers a POST route under /api/dsh-imessage/status and unregisters on dispose', () => {
    const reg = makeRegistry();
    const { deps } = makeDeps();

    const dispose = registerStatusRpc(reg.registry as never, deps);

    expect(reg.path).toBe('/api/dsh-imessage/status');
    expect(reg.methods).toEqual(['POST']);

    dispose();
    expect(reg.disposeSpy.calls).toBe(1);
    expect(reg.path).toBeUndefined();
  });
});

describe('rpc · status endpoint', () => {
  it('answers a valid client-request with the channel snapshot', async () => {
    const reg = makeRegistry();
    const { deps } = makeDeps();

    registerStatusRpc(reg.registry as never, deps);

    const response = await reg.call('POST', JSON_HEADERS, OK_BODY);
    const envelope = (await response.json()) as {
      type: string;
      rpcId: string;
      result: { ok: boolean; value: Record<string, unknown> };
    };

    expect(response.status).toBe(200);
    expect(envelope).toMatchObject({ type: 'server-response', rpcId: 'rpc-1' });
    expect(envelope.result.ok).toBe(true);
    expect(envelope.result.value).toMatchObject({
      phase: 'running',
      allowlistCount: 2,
      cursor: 42,
      sessionCount: 1,
    });
  });

  it('includes probe details in the payload when probe failed', async () => {
    const reg = makeRegistry();
    const { deps } = makeDeps({
      status: {
        phase: 'probe-failed',
        probe: {
          chatDbPath: '/x/chat.db',
          disk: { ok: false, detail: 'chat.db not found' },
          automation: { ok: true },
        },
      },
    });

    registerStatusRpc(reg.registry as never, deps);

    const response = await reg.call('POST', JSON_HEADERS, OK_BODY);
    const envelope = (await response.json()) as { result: { value: Record<string, unknown> } };

    expect(envelope.result.value).toMatchObject({
      phase: 'probe-failed',
      probe: {
        disk: { ok: false, detail: 'chat.db not found' },
        automation: { ok: true },
      },
    });
  });

  it('includes the stop reason when stopped', async () => {
    const reg = makeRegistry();
    const { deps } = makeDeps({ status: { phase: 'stopped', reason: 'fetch-exhausted' } });

    registerStatusRpc(reg.registry as never, deps);

    const response = await reg.call('POST', JSON_HEADERS, OK_BODY);
    const envelope = (await response.json()) as { result: { value: Record<string, unknown> } };

    expect(envelope.result.value).toMatchObject({ phase: 'stopped', reason: 'fetch-exhausted' });
  });

  it('includes the error when start failed', async () => {
    const reg = makeRegistry();
    const { deps } = makeDeps({ status: { phase: 'start-failed', error: 'unable to open database file' } });

    registerStatusRpc(reg.registry as never, deps);

    const response = await reg.call('POST', JSON_HEADERS, OK_BODY);
    const envelope = (await response.json()) as { result: { value: Record<string, unknown> } };

    expect(envelope.result.value).toMatchObject({
      phase: 'start-failed',
      error: 'unable to open database file',
    });
  });

  it('reports a null cursor when state has never been written', async () => {
    const reg = makeRegistry();
    const { deps, root } = makeDeps();
    // 清空 state 文件内容 → loadState 返回初始空态（cursor null）
    const { loadState } = await import('@/core/stores/state-store');
    deps.stateFile = join(root, 'missing.json');

    registerStatusRpc(reg.registry as never, deps);

    const response = await reg.call('POST', JSON_HEADERS, OK_BODY);
    const envelope = (await response.json()) as { result: { value: Record<string, unknown> } };
    expect(envelope.result.value).toMatchObject({ cursor: null });
    expect(loadState(deps.stateFile).cursor).toBeNull();
  });
});

describe('rpc · request guards', () => {  it('rejects non-POST methods with 405', async () => {
    const reg = makeRegistry();
    const { deps } = makeDeps();
    registerStatusRpc(reg.registry as never, deps);

    const response = await reg.call('GET', JSON_HEADERS, OK_BODY);

    expect(response.status).toBe(405);
  });

  it('rejects non-json content type with 415', async () => {
    const reg = makeRegistry();
    const { deps } = makeDeps();
    registerStatusRpc(reg.registry as never, deps);

    const response = await reg.call('POST', { 'content-type': 'text/plain', host: 'localhost:3080' }, OK_BODY);

    expect(response.status).toBe(415);
  });

  it('rejects non-loopback hosts with 403', async () => {
    const reg = makeRegistry();
    const { deps } = makeDeps();
    registerStatusRpc(reg.registry as never, deps);

    const response = await reg.call('POST', { 'content-type': 'application/json', host: 'example.com:3080' }, OK_BODY);

    expect(response.status).toBe(403);
  });

  it('rejects loopback-looking authorities that carry credentials or paths', async () => {
    const reg = makeRegistry();
    const { deps } = makeDeps();
    registerStatusRpc(reg.registry as never, deps);

    const withCreds = await reg.call('POST', { ...JSON_HEADERS, host: 'user:pw@localhost:3080' }, OK_BODY);
    const withPath = await reg.call('POST', { ...JSON_HEADERS, host: 'localhost:3080/x' }, OK_BODY);

    expect(withCreds.status).toBe(403);
    expect(withPath.status).toBe(403);
  });

  it('rejects an unparseable host header with 403', async () => {
    const reg = makeRegistry();
    const { deps } = makeDeps();
    registerStatusRpc(reg.registry as never, deps);

    // 空 host / 非法 authority → URL 解析失败 → 拒绝
    const response = await reg.call('POST', { ...JSON_HEADERS, host: '' }, OK_BODY);

    expect(response.status).toBe(403);
  });

  it('accepts 127.x loopback hosts', async () => {
    const reg = makeRegistry();
    const { deps } = makeDeps();
    registerStatusRpc(reg.registry as never, deps);

    const response = await reg.call('POST', { ...JSON_HEADERS, host: '127.0.0.1:3080' }, OK_BODY);

    expect(response.status).toBe(200);
  });

  it('rejects an envelope without rpcId with 400', async () => {
    const reg = makeRegistry();
    const { deps } = makeDeps();
    registerStatusRpc(reg.registry as never, deps);

    const response = await reg.call('POST', JSON_HEADERS, { type: 'client-request', payload: {} });

    expect(response.status).toBe(400);
  });

  it('rejects malformed json body with 400', async () => {
    const reg = makeRegistry();
    const { deps } = makeDeps();
    registerStatusRpc(reg.registry as never, deps);

    const response = await reg.call('POST', JSON_HEADERS, 'not-an-object');

    expect(response.status).toBe(400);
  });

  it('rejects a body whose json() throws with 400', async () => {
    const reg = makeRegistry();
    const { deps } = makeDeps();
    registerStatusRpc(reg.registry as never, deps);
    // 直接构造路由请求：json() 抛错（真实 fetch 对非法 JSON 即如此）
    const route = (reg as unknown as { registry: { register(d: never): unknown } });
    void route;

    const response = await reg.callRaw({
      method: 'POST',
      headers: { get: (n: string) => (n.toLowerCase() === 'host' ? 'localhost:3080' : 'application/json') },
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    });

    expect(response.status).toBe(400);
  });

  it('reads the allowlist count lazily (hot config update reflected)', async () => {
    let allowlist = ['+8613800000000'];
    const { deps } = makeDeps();
    deps.allowlist = () => allowlist;
    const reg = makeRegistry();
    registerStatusRpc(reg.registry as never, deps);

    const count = async (): Promise<number> => {
      const response = await reg.call('POST', JSON_HEADERS, OK_BODY);
      const body = (await response.json()) as { result: { value: { allowlistCount: number } } };
      return body.result.value.allowlistCount;
    };
    expect(await count()).toBe(1);

    // 通道热更白名单后，status 不需重挂载即反映新计数
    allowlist = ['+8613800000000', '+8613900000000'];
    expect(await count()).toBe(2);
  });
});

