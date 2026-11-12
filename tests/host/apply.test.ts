// host/index.ts apply() 生命周期测试（M4 Step 4）。
//
// apply 是插件与宿主的边界：ctx → env 映射、通道启动、effect 注册
// （stop 与 status 路由卸载）。用最小 fake ctx 驱动，验证接线正确、
// 卸载干净——不重复测 channel/rpc 的内部行为（各有专测）。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// env 覆盖：让 resolvePaths 落到临时目录（apply 内部自解析路径）
const tempRoot = mkdtempSync(join(tmpdir(), 'apply-test-'));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));
process.env['DSH_IMESSAGE_HOME'] = tempRoot;

const { apply } = await import('@/host/index');
const { makeFakeDshHost } = await import('../helpers/fake-dsh-api');

/** 探测失败（不碰真 macOS IO）。 */
const failingProbe = {
  statFile: () => false,
  readFileHead: () => undefined,
  runAppleScript: () => undefined,
};

// 探测依赖一律注入（真 osascript 会触发 TCC 弹窗，测试禁止碰）。
// 默认注入"探测失败"，聚焦验证接线：effect 注册、status 路由挂载、
// 卸载不抛错——也覆盖真实宿主里权限缺失时的降级路径。
type RouteHandler = (request: {
  method: string;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}) => Promise<Response>;

function makeCtx(options: { connectionFetch?: unknown } = {}) {
  const host = makeFakeDshHost();
  const disposers: Array<() => unknown> = [];
  const routes: string[] = [];
  const handlers = new Map<string, RouteHandler>();
  const fetchRegistry = {
    register(definition: { path: string; fetch: RouteHandler }) {
      routes.push(definition.path);
      handlers.set(definition.path, definition.fetch);
      return () => {
        routes.splice(routes.indexOf(definition.path), 1);
        handlers.delete(definition.path);
      };
    },
  };
  const connectionService =
    'connectionFetch' in options && options.connectionFetch === undefined
      ? { fetch: undefined }
      : { fetch: fetchRegistry };
  const ctx: Record<string, unknown> = {
    agents: host.services.agents,
    workspaceRegistry: host.services.workspaceRegistry,
    agentDefaultModel: host.services.agentDefaultModel,
    sessionTitle: host.services.sessionTitle,
    effect(fn: () => () => unknown) {
      disposers.push(fn());
    },
    // 模拟 cordis 动态注入：服务挂上（getter → value）再回调——
    // 真 cordis 保证回调触发时属性可访问
    inject(names: readonly string[], callback: () => unknown) {
      if (!names.includes('connection')) return;
      Object.defineProperty(ctx, 'connection', {
        value: connectionService,
        enumerable: true,
        configurable: true,
      });
      void callback();
    },
  };
  // 真 cordis 语义（实测事实）：访问未 inject 声明的服务属性直接抛错，
  // 不是返回 undefined——顶层直接访问 ctx.connection 的写法在单测里
  // 必须同样炸掉（防止"单测全绿、真机必炸"的回归）
  Object.defineProperty(ctx, 'connection', {
    get() {
      throw new Error('cannot get property "connection" without inject');
    },
    enumerable: true,
    configurable: true,
  });

  /** 调一次已挂载的 status 路由（触发惰性 status 回调）。 */
  const callStatus = async (): Promise<{ ok: boolean; value: Record<string, unknown> }> => {
    const handler = handlers.get('/api/dsh-imessage/status');
    if (!handler) throw new Error('status route not registered');
    const response = await handler({
      method: 'POST',
      headers: {
        get: (name) =>
          name.toLowerCase() === 'host'
            ? 'localhost:3080'
            : name.toLowerCase() === 'content-type'
              ? 'application/json'
              : null,
      },
      json: async () => ({ type: 'client-request', rpcId: 'r1', payload: {} }),
    });
    const envelope = (await response.json()) as {
      result: { ok: boolean; value: Record<string, unknown> };
    };
    return envelope.result;
  };
  return { ctx, disposers, routes, callStatus };
}

describe('apply · wiring', () => {
  it('registers the status route and an effect disposer', () => {
    const { ctx, disposers, routes } = makeCtx();

    apply(ctx as never, { locale: 'zh', allowlist: ['+8613800000000'] }, { probe: failingProbe });

    expect(routes).toEqual(['/api/dsh-imessage/status']);
    expect(disposers).toHaveLength(2); // channel.stop + rpc unregister
  });

  it('skips the route when the connection service has no fetch registry', () => {
    // 服务挂载了但 fetch registry 缺失：动态注入回调内部降级返回
    const { ctx, disposers, routes } = makeCtx({ connectionFetch: undefined });

    apply(ctx as never, { locale: 'zh', allowlist: [] }, { probe: failingProbe });

    expect(routes).toEqual([]);
    expect(disposers).toHaveLength(1); // 仅 channel.stop
  });

  it('disposers run without throwing and clean up the route', async () => {
    const { ctx, disposers, routes } = makeCtx();
    apply(ctx as never, { locale: 'zh', allowlist: [] }, { probe: failingProbe });

    for (const dispose of [...disposers].reverse()) {
      await dispose();
    }

    expect(routes).toEqual([]);
  });

  it('exposes the live channel status through the route', async () => {
    const { ctx, disposers, callStatus } = makeCtx();
    apply(ctx as never, { locale: 'zh', allowlist: ['+8613800000000'] }, { probe: failingProbe });

    const result = await callStatus();

    // 注入的探测必然失败 → probe-failed 快照（惰性 status 回调被调用）
    expect(result.value).toMatchObject({ phase: 'probe-failed', allowlistCount: 1 });
    for (const dispose of disposers) void dispose();
  });

  it('accepts the en locale and a missing allowlist field', async () => {
    const { ctx, disposers, callStatus } = makeCtx();
    // locale 'en' 走收窄分支；allowlist 缺省走 ?? [] 兜底
    apply(ctx as never, { locale: 'en' }, { probe: failingProbe });

    const result = await callStatus();

    expect(result.value).toMatchObject({ phase: 'probe-failed', allowlistCount: 0 });
    for (const dispose of disposers) void dispose();
  });

  it('treats a non-en locale as zh', () => {
    const { ctx, disposers } = makeCtx();
    // schema 层是宽松 string：非法值应在 apply 处收窄为 zh（i18n 回退一致）
    expect(() => apply(ctx as never, { locale: 'fr', allowlist: [] }, { probe: failingProbe })).not.toThrow();
    for (const dispose of disposers) void dispose();
  });
});
