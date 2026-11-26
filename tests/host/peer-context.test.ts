// host/peer-context.ts 契约测试（M7 Step B · 测试先行）。
//
// fake 的 systemPrompt 服务照官方形状造（防再犯④：不照我们声明造）：
// deepseek-harness packages/core/system-prompt/src/index.ts:520
// `context(PromptContext): () => void`；PromptContext 字段 :80-90
// （name/order/text/interpolate/required）；text 回调的 assembly 官方
// 基础面 {scope?, signal?}（:42-48）+ agent 包模块扩充 agent?
// （agent/src/runtime-types.ts:19-24，session.id 是我们消费的唯一字段）。

import { describe, expect, it } from 'vitest';

import { PeerRegistry } from '@/core/identity/peer-registry';
import { buildPeerNote } from '@/core/identity/peer-note';
import { asSessionId } from '@/core/types/dsh';
import { installPeerContext, PEER_CONTEXT_NAME, PEER_CONTEXT_ORDER } from '@/host/peer-context';
import type { HostPromptAssembly, HostSystemPromptService } from '@/host/dsh-api';

/** 照官方 SystemPrompt.context 的注册记录器（fake）。 */
function makeFakeSystemPrompt() {
  const registrations: Array<Record<string, unknown>> = [];
  const disposed: string[] = [];
  const service: HostSystemPromptService = {
    context(entry) {
      registrations.push({ ...entry });
      return () => disposed.push(String(entry.name));
    },
  };
  return { service, registrations, disposed };
}

describe('installPeerContext · registration shape', () => {
  it('registers one context under our name and order', () => {
    const { service, registrations } = makeFakeSystemPrompt();
    installPeerContext(service, new PeerRegistry());
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({
      name: PEER_CONTEXT_NAME,
      order: PEER_CONTEXT_ORDER,
    });
    expect(typeof registrations[0]!.text).toBe('function');
  });

  it('disables variable interpolation (literal peer names survive)', () => {
    const { service, registrations } = makeFakeSystemPrompt();
    installPeerContext(service, new PeerRegistry());
    expect(registrations[0]!.interpolate).toBe(false);
  });
});

describe('installPeerContext · text resolution', () => {
  function resolveText(registry: PeerRegistry, assembly: HostPromptAssembly): string {
    const { service, registrations } = makeFakeSystemPrompt();
    installPeerContext(service, registry);
    const text = registrations[0]!.text as (a: HostPromptAssembly) => string;
    return text(assembly);
  }

  it('returns the published note for the assembling session', () => {
    const registry = new PeerRegistry();
    registry.publish(asSessionId('s1'), buildPeerNote({ handle: '+8613800000000', name: '小陈' }));
    const note = resolveText(registry, { agent: { session: { id: 's1' } } });
    expect(note).toContain('小陈');
  });

  it('returns empty text for sessions that were never published', () => {
    const registry = new PeerRegistry();
    registry.publish(asSessionId('s1'), 'note');
    expect(resolveText(registry, { agent: { session: { id: 'other' } } })).toBe('');
  });

  it('tolerates assemblies without agent/session (diagnostics, non-iMessage)', () => {
    const registry = new PeerRegistry();
    registry.publish(asSessionId('s1'), 'note');
    expect(resolveText(registry, {})).toBe('');
    expect(resolveText(registry, { agent: undefined })).toBe('');
    expect(resolveText(registry, { agent: { session: undefined } })).toBe('');
    expect(resolveText(registry, { agent: { session: { id: undefined } } })).toBe('');
  });
});

describe('installPeerContext · degradation', () => {
  it('is a no-op without the systemPrompt service (old hosts)', () => {
    expect(() => installPeerContext(undefined, new PeerRegistry())).not.toThrow();
    // no-op 也返回可调用 disposer（channel 生命周期统一调用）
    const dispose = installPeerContext(undefined, new PeerRegistry());
    expect(() => dispose()).not.toThrow();
  });

  it('forwards the service disposer', () => {
    const { service, disposed } = makeFakeSystemPrompt();
    const dispose = installPeerContext(service, new PeerRegistry());
    dispose();
    expect(disposed).toEqual([PEER_CONTEXT_NAME]);
  });
});
