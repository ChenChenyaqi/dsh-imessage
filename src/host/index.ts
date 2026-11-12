// DeepSeek Harness 的 cordis 插件入口。
//
// 装配逻辑在 ./channel.ts（独立可测）；本文件只做三件事：
// 插件清单（name/inject）、Config schema（D9：设置页自动渲染）、
// apply 生命周期（组装 + effect 注册停止）。

import type { Context } from '@deepseek-ai/cordis';
// 官方宿主包的 Context 类型增强（type-only；devDep 随 DSH 版本升级）
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-session-title';
import type {} from '@deepseek-ai/dsh-workspace';
import z from '@deepseek-ai/schemastery';

import { resolvePaths } from '@/core/paths';
import { PLUGIN_ID } from '@/core/version';
import { startImessageChannel } from '@/host/channel';
import type { ChannelEnv } from '@/host/channel';
import { registerStatusRpc } from '@/host/rpc';
import type { FetchRegistry } from '@/host/rpc';
import type { DshPortServices } from '@/host/dsh-port';

export const name = PLUGIN_ID;

// 宿主服务类型来自官方包的 Context 模块增强（devDep：
// @deepseek-ai/dsh-{agent,workspace,agent-default-model,session-title}）；
// 我们与官方契约的兼容性由 tests/host/type-compat.test.ts 在编译期守护。
// 官方类型面比 dsh-api.ts 子集宽（readonly/多成员），运行时行为由 inject 保证。

// 探针事实：这些服务必须 inject 声明，否则 ctx 上访问直接抛错
// 探针事实：这些服务必须 inject 声明，否则 ctx 上访问直接抛错；
// connection 不在此列——部分宿主无该服务，走动态注入降级（见 apply）
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
  // cordis 探针事实：ctx 上访问未 inject 的服务属性会抛错，且静态 inject
  // 在宿主无该服务时会让插件静默等待（永不激活）；用动态注入——服务
  // 就绪才挂 RPC，无 connection 的宿主优雅降级（通道照常运行）
  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], () => {
      // 回调触发时服务已注入 ctx（cordis 惯例：闭包直取）
      const fetchRegistry = (ctx as unknown as { connection?: { fetch?: FetchRegistry } }).connection
        ?.fetch;
      if (fetchRegistry === undefined) return;
      const disposeRpc = registerStatusRpc(fetchRegistry, {
        status: () => channel.status(),
        stateFile: (env.paths ?? resolvePaths()).stateFile,
        allowlist: config.allowlist ?? [],
      });
      ctx.effect(() => () => disposeRpc());
    });
  }
}
