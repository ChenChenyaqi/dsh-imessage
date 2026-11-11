// 最小管理 RPC：POST /api/dsh-imessage/status（只读通道快照）。
//
// 路线（实测事实，dsh-im 先例）：ctx.connection.fetch.register 挂
// /api 路由 + 手工 client-request/server-response envelope。不走
// TypertRemoteService（客户端面需要生成产物，最小只读面不划算）。
//
// 安全面：DSH 在 handler 前已做浏览器鉴权与 Host/Origin 信任；
// 本层再加 loopback 校验作纵深（status 低敏，本地排查够用）。

import { loadState } from '@/core/stores/state-store';
import type { ChannelStatus } from '@/host/channel';

// ---------------------------------------------------------------------------
// 依赖
// ---------------------------------------------------------------------------

/** connection.fetch registry 的最小面（真宿主 ctx.connection.fetch）。 */
export interface FetchRegistry {
  register(definition: {
    readonly path: string;
    readonly methods: readonly string[];
    readonly requestBody: 'buffered';
    fetch(request: RpcRequest): Promise<Response>;
  }): () => void;
}

/** 宿主传入的请求对象（fetch API 子集）。 */
export interface RpcRequest {
  readonly method: string;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export interface StatusRpcDeps {
  /** 通道状态源（ChannelHandle.status）。 */
  readonly status: () => ChannelStatus;
  /** state 文件路径（读 cursor / 会话计数）。 */
  readonly stateFile: string;
  /** 白名单（归一化后的键；计数展示）。 */
  readonly allowlist: readonly string[];
}

// ---------------------------------------------------------------------------
// 状态载荷
// ---------------------------------------------------------------------------

export interface StatusPayload {
  readonly phase: ChannelStatus['phase'];
  readonly reason?: string;
  readonly probe?: {
    readonly disk: { readonly ok: boolean; readonly detail?: string };
    readonly automation: { readonly ok: boolean; readonly detail?: string };
  };
  readonly error?: string;
  readonly allowlistCount: number;
  readonly cursor: number | null;
  readonly sessionCount: number;
}

function buildPayload(deps: StatusRpcDeps): StatusPayload {
  const status = deps.status();
  const state = loadState(deps.stateFile);
  const payload: StatusPayload = {
    phase: status.phase,
    allowlistCount: deps.allowlist.length,
    cursor: state.cursor,
    sessionCount: Object.keys(state.sessions).length,
  };
  if (status.phase === 'stopped') {
    return { ...payload, reason: status.reason };
  }
  if (status.phase === 'probe-failed') {
    return {
      ...payload,
      probe: {
        disk: { ok: status.probe.disk.ok, detail: status.probe.disk.detail },
        automation: { ok: status.probe.automation.ok, detail: status.probe.automation.detail },
      },
    };
  }
  if (status.phase === 'start-failed') {
    return { ...payload, error: status.error };
  }
  return payload;
}

// ---------------------------------------------------------------------------
// 请求守卫
// ---------------------------------------------------------------------------

/** loopback 判定（对齐 dsh-im 实测边界：host 头解析 + localhost/127/::1）。 */
function isLoopbackAuthority(authority: string): boolean {
  try {
    const url = new URL(`http://${authority}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      return false;
    }
    const hostname = url.hostname.replace(/\.$/u, '');
    return (
      hostname === 'localhost'
      || hostname === '[::1]'
      || /^127\.\d+\.\d+\.\d+$/u.test(hostname)
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

export const STATUS_ENDPOINT = '/api/dsh-imessage/status';

/** 挂载 status 路由；返回卸载函数。 */
export function registerStatusRpc(
  registry: FetchRegistry,
  deps: StatusRpcDeps,
): () => void {
  return registry.register({
    path: STATUS_ENDPOINT,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      // 纵深防御：仅限本地访问（DSH 已在外层做浏览器鉴权）
      if (!isLoopbackAuthority(request.headers.get('host') ?? '')) {
        return new Response('forbidden', { status: 403 });
      }
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405 });
      }
      const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 });
      }
      let message: unknown;
      try {
        message = await request.json();
      } catch {
        return new Response('body is not JSON', { status: 400 });
      }
      const rpcId =
        message !== null && typeof message === 'object' && typeof (message as { rpcId?: unknown }).rpcId === 'string'
          ? (message as { rpcId: string }).rpcId
          : null;
      if (rpcId === null) {
        return new Response('body must be a client-request envelope', { status: 400 });
      }
      // 只读快照：无参数无副作用，method 名不做分支
      const value = buildPayload(deps);
      return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } });
    },
  });
}
