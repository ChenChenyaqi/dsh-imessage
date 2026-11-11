// DeepSeek Harness 的 cordis 插件入口。
//
// 装配逻辑在 ./channel.ts（独立可测）；本文件只做三件事：
// 插件清单（name/inject）、Config schema（D9：设置页自动渲染）、
// apply 生命周期（组装 + effect 注册停止）。

import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

import { resolvePaths } from '@/core/paths';
import { PLUGIN_ID } from '@/core/version';
import { startImessageChannel } from '@/host/channel';
import type { ChannelEnv } from '@/host/channel';
import { registerStatusRpc } from '@/host/rpc';
import type { FetchRegistry } from '@/host/rpc';
import type { DshPortServices } from '@/host/dsh-port';
import type {
  HostAgentDefaultModelService,
  HostAgentsService,
  HostSessionTitleService,
  HostWorkspaceRegistry,
} from '@/host/dsh-api';

export const name = PLUGIN_ID;

// 宿主服务的类型合并（DSH 插件惯例：消费方声明自己用到的服务面）。
// 宿主侧 dsh-* 包的完整声明不在本包依赖里，这里以 dsh-api.ts 的子集
// 形状声明——接口面由适配层（dsh-port）旱鸭验证，运行时行为由 inject 保证。
declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly agents: HostAgentsService;
    readonly workspaceRegistry: HostWorkspaceRegistry;
    readonly agentDefaultModel: HostAgentDefaultModelService;
    readonly sessionTitle: HostSessionTitleService;
  }
}

// 探针事实：这些服务必须 inject 声明，否则 ctx 上访问直接抛错
export const inject = ['agents', 'workspaceRegistry', 'agentDefaultModel', 'sessionTitle'];

/** 插件配置（宿主设置页经 Config schema 自动渲染并写回 patch）。 */
export interface Config {
  /** iMessage 回复文案语言（zh/en；非法值由 i18n 层回退 zh）。 */
  readonly locale?: string;
  /** 白名单（原始号码写法，装载时归一化为 E.164 键；默认空 = 全拒）。 */
  readonly allowlist?: string[];
  /** 轮询间隔 ms（默认 2s）。 */
  readonly intervalMs?: number;
  /** 退避上限 ms（默认 60s）。 */
  readonly maxBackoffMs?: number;
}

export const Config: z<Config> = z.object({
  locale: z.string().default('zh'),
  allowlist: z.array(z.string()).default([]),
  intervalMs: z.number().step(1).min(1).default(2000),
  maxBackoffMs: z.number().step(1).min(1).default(60000),
});

export function apply(ctx: Context, config: Config, overrides: Partial<ChannelEnv> = {}): void {
  // 宿主服务经 inject 提供；类型合并声明在上方 declare module
  const services: DshPortServices = {
    agents: ctx.agents,
    workspaceRegistry: ctx.workspaceRegistry,
    agentDefaultModel: ctx.agentDefaultModel,
    sessionTitle: ctx.sessionTitle,
  };
  const env: ChannelEnv = {
    services,
    events: ctx as unknown as ChannelEnv['events'],
    // 测试/嵌入注入点（cordis 只传前两参）；未注入时走真 macOS IO
    ...overrides,
  };
  const channel = startImessageChannel(
    {
      // Config schema 层是宽松 string；i18n 层对非法值回退 zh，这里显式收窄类型
      locale: config.locale === 'en' ? 'en' : 'zh',
      allowlist: config.allowlist ?? [],
      intervalMs: config.intervalMs,
      maxBackoffMs: config.maxBackoffMs,
    },
    env,
  );
  // 卸载时等待 pipeline 收尾（at-most-once 语义靠 stop 落盘）；
  // cordis 的 Disposable 允许返回 Promise，会被 await
  ctx.effect(() => () => channel.stop());

  // 最小管理面：POST /api/dsh-imessage/status（只读快照）。
  // connection 服务缺失时降级为无管理面（不阻断通道运行）
  const connection = (ctx as unknown as { connection?: { fetch?: FetchRegistry } }).connection;
  if (connection?.fetch !== undefined) {
    const disposeRpc = registerStatusRpc(connection.fetch, {
      status: () => channel.status(),
      stateFile: (env.paths ?? resolvePaths()).stateFile,
      allowlist: config.allowlist ?? [],
    });
    ctx.effect(() => () => disposeRpc());
  }
}
