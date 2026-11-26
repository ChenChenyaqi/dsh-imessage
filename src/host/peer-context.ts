// M7 身份上下文的宿主侧注册（分叉②α：systemPrompt.context 官方管道）。
//
// dsh-im imessage-peer.mjs installPeerContext 的本仓版：注册一个
// PromptContext，text 回调按组装现场的 session id 查 PeerRegistry——
// 未发布的会话（桌面/web 直连、诊断组装）拿空串，官方语义
// "Empty text contributes nothing"，对非目标会话天然不可见。
//
// order 沿用 dsh-im 的 124（IMESSAGE_PEER_ORDER：身份段在 source/
// sticker 类上下文之前）；interpolate 显式关掉——称呼是用户输入，
// 含 {{...}} 时不应被变量插值吞掉或报错（官方默认 strict 插值）。

import { PeerRegistry } from '@/core/identity/peer-registry';
import { asSessionId } from '@/core/types/dsh';
import type { HostPromptAssembly, HostSystemPromptService } from './dsh-api';

/** 注册名（宿主内全局唯一；重复注册会抛官方错）。 */
export const PEER_CONTEXT_NAME = 'dsh-imessage:peer';

/** 组装排序档（dsh-im IMESSAGE_PEER_ORDER 同值：先于 source/sticker）。 */
export const PEER_CONTEXT_ORDER = 124;

/**
 * 注册 peer 上下文。服务缺失（老宿主动态探测失败）→ no-op，返回
 * 可调用 disposer（channel 生命周期统一调用，无需判空）。
 */
export function installPeerContext(
  service: HostSystemPromptService | undefined,
  registry: PeerRegistry,
): () => void {
  if (service === undefined) return () => undefined;
  return service.context({
    name: PEER_CONTEXT_NAME,
    order: PEER_CONTEXT_ORDER,
    interpolate: false,
    text: (assembly: HostPromptAssembly) =>
      registry.get(asSessionId(assembly?.agent?.session?.id ?? '')) ?? '',
  });
}
