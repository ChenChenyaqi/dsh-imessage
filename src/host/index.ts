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
import type {
  HostAttachmentsService,
  HostSystemPromptService,
  HostToolsService,
} from '@/host/dsh-api';

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
  /** 分段回复开关（默认关：整段直发、零等待）。 */
  readonly chunkedReplies?: boolean | { get(): boolean };
  /** 最大分段数（默认 8；1..50）。 */
  readonly maxChunks?: number | { get(): number };
  /** 延时系数（默认 1；0 = 分段不延时，0..5）。 */
  readonly delayFactor?: number | { get(): number };
  /** agent 预设 id（空 = 未设置：装了 dafeiyu 用它，否则宿主默认）。 */
  readonly agentPreset?: string | { get(): string };
  /** M7 称呼表（归一化号码 → 称呼；volatile 活引用，readVolatile 取值）。 */
  readonly contacts?: Record<string, string> | { get(): Record<string, string> };
}

// volatile（DSH settings 事实）：设置页只渲染 volatile 字段；改动经
// loader 提交进运行引用并广播 loader/volatile-update，插件不重挂载
// 注：不加显式泛型注解——volatile 字段的 schema 输出类型自带引用语义，
// 与手写 Config 接口不再同形；运行时两种形态由 readVolatile 统一处理
export const Config = z.object({
  locale: z.string().default('zh').volatile(),
  allowlist: z.array(z.string()).default([]).volatile(),
  chunkedReplies: z.boolean().default(false).volatile(),
  maxChunks: z.number().step(1).min(1).max(50).default(8).volatile(),
  delayFactor: z.number().min(0).max(5).default(1).volatile(),
  agentPreset: z.string().default('').volatile(),
  // M7 称呼表：归一化号码 → 称呼（设置页整字段覆盖写；UI 不渲染此字段，
  // 卡片自绘编辑区；volatile 走 loader 热更链路）
  contacts: z.dict(z.string()).default({}).volatile(),
  intervalMs: z.number().step(1).min(1).default(2000),
  maxBackoffMs: z.number().step(1).min(1).default(60000),
});

// loader 广播的 volatile 更新事件（宿主有 loader 才会发；类型增广一次即可）
declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void;
  }
}

/** volatile 活引用（loader 语义）→ 当前值；非引用环境（测试/嵌入）原样返回。 */
function readVolatile<T>(value: T | { get(): T }): T {
  return typeof (value as { get?: unknown } | undefined)?.get === 'function'
    ? (value as unknown as { get(): T }).get()
    : (value as T);
}

/** agentPresets 服务最小面（进程内；无预设体系的宿主返回 undefined）。 */
function agentPresetsService(ctx: Context):
  | {
      resolve(id?: string): Promise<{ id: string }>;
      mount(ctx: unknown, id: string): Promise<unknown>;
    }
  | undefined {
  const service = (ctx as unknown as { get?(name: string): unknown }).get?.('agentPresets');
  if (service === undefined || typeof service !== 'object') return undefined;
  const candidate = service as { resolve?: unknown; mount?: unknown };
  return typeof candidate.resolve === 'function' && typeof candidate.mount === 'function'
    ? (candidate as {
        resolve(id?: string): Promise<{ id: string }>;
        mount(ctx: unknown, id: string): Promise<unknown>;
      })
    : undefined;
}

/** attachments 附件服务最小面（宿主内置；无该服务的老宿主返回 undefined
 *  = 图片降级不阻塞文本，动态注入同 agentPresets 纪律）。 */
function attachmentsService(ctx: Context): HostAttachmentsService | undefined {
  const service = (ctx as unknown as { get?(name: string): unknown }).get?.('attachments');
  if (service === undefined || typeof service !== 'object') return undefined;
  const candidate = service as { saveImages?: unknown };
  return typeof candidate.saveImages === 'function'
    ? (candidate as HostAttachmentsService)
    : undefined;
}

/** tools 服务最小面（M6.2 交付工具注册；无该服务的老宿主返回 undefined
 *  = 发文件能力缺，文本不受影响）。 */
function toolsService(ctx: Context): HostToolsService | undefined {
  const service = (ctx as unknown as { get?(name: string): unknown }).get?.('tools');
  if (service === undefined || typeof service !== 'object') return undefined;
  const candidate = service as { register?: unknown };
  return typeof candidate.register === 'function' ? (candidate as HostToolsService) : undefined;
}

/** systemPrompt 服务最小面（M7 身份上下文；无该服务的老宿主返回
 *  undefined = 不注入身份段，聊天不受影响）。 */
function systemPromptService(ctx: Context): HostSystemPromptService | undefined {
  const service = (ctx as unknown as { get?(name: string): unknown }).get?.('systemPrompt');
  if (service === undefined || typeof service !== 'object') return undefined;
  const candidate = service as { context?: unknown };
  return typeof candidate.context === 'function'
    ? (candidate as HostSystemPromptService)
    : undefined;
}

export function apply(ctx: Context, config: Config, overrides: Partial<ChannelEnv> = {}): void {
  // 宿主服务经 inject 提供；类型合并声明在上方 declare module
  const services: DshPortServices = {
    agents: ctx.agents,
    workspaceRegistry: ctx.workspaceRegistry,
    agentDefaultModel: ctx.agentDefaultModel,
    sessionTitle: ctx.sessionTitle,
    // 探针纪律（同 connection）：动态取，无该服务的宿主上 undefined =
    // 预设降级为宿主默认，通道照常
    ...(agentPresetsService(ctx) === undefined ? {} : { agentPresets: agentPresetsService(ctx)! }),
    // 附件服务同款动态获取（M6.1）：老宿主无 = 图片降级，文本照发
    ...(attachmentsService(ctx) === undefined ? {} : { attachments: attachmentsService(ctx)! }),
    // 工具服务同款动态获取（M6.2）：老宿主无 = 发文件能力缺
    ...(toolsService(ctx) === undefined ? {} : { tools: toolsService(ctx)! }),
    // prompt 组装服务同款动态获取（M7）：老宿主无 = 不注入身份段
    ...(systemPromptService(ctx) === undefined ? {} : { systemPrompt: systemPromptService(ctx)! }),
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
      // volatile 字段在真 loader 下是活引用（readVolatile 取当前值）
      locale: readVolatile(config.locale) === 'en' ? 'en' : 'zh',
      allowlist: readVolatile(config.allowlist) ?? [],
      chunkedReplies: readVolatile(config.chunkedReplies) ?? false,
      maxChunks: readVolatile(config.maxChunks) ?? 8,
      delayFactor: readVolatile(config.delayFactor) ?? 1,
      agentPreset: readVolatile(config.agentPreset) ?? '',
      contacts: readVolatile(config.contacts) ?? {},
      intervalMs: config.intervalMs,
      maxBackoffMs: config.maxBackoffMs,
    },
    env,
  );
  // 卸载时等待 pipeline 收尾（at-most-once 语义靠 stop 落盘）；
  // cordis 的 Disposable 允许返回 Promise，会被 await
  ctx.effect(() => () => channel.stop());

  // UI 改 volatile 配置 → loader 提交新引用并广播本事件 → 通道热更
  // （引用是活的：这里 .get() 即最新值；监听器抛错由宿主兜底，不影响已提交配置）
  if (typeof ctx.on === 'function') {
    ctx.on('loader/volatile-update', () => {
      try {
        channel.updateConfig({
          locale: readVolatile(config.locale) === 'en' ? 'en' : 'zh',
          allowlist: readVolatile(config.allowlist) ?? [],
          chunkedReplies: readVolatile(config.chunkedReplies) ?? false,
          maxChunks: readVolatile(config.maxChunks) ?? 8,
          delayFactor: readVolatile(config.delayFactor) ?? 1,
          agentPreset: readVolatile(config.agentPreset) ?? '',
          contacts: readVolatile(config.contacts) ?? {},
        });
      } catch (err) {
        console.error('[dsh-imessage] volatile update failed:', err);
      }
    });
  }

  // 最小管理面：POST /api/dsh-imessage/status（只读快照）。
  // cordis 探针事实：ctx 上访问未 inject 的服务属性会抛错，且静态 inject
  // 在宿主无该服务时会让插件静默等待（永不激活）；用动态注入——服务
  // 就绪才挂 RPC，无 connection 的宿主优雅降级（通道照常运行）。
  // cordis 语义（官方 inspector/cot-translation 同款）：注入的服务在**回调
  // 参数**上，不在外层 ctx——M4 初版从外层 ctx 读 connection 恒 undefined，
  // status 路由在真宿主上从未注册（M7 e2e 探针坐实后修正）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], (child: Context) => {
      const fetchRegistry = (child as unknown as { connection?: { fetch?: FetchRegistry } })
        .connection?.fetch;
      if (fetchRegistry === undefined) return;
      const disposeRpc = registerStatusRpc(fetchRegistry, {
        status: () => channel.status(),
        stateFile: (env.paths ?? resolvePaths()).stateFile,
        allowlist: () => channel.currentAllowlist(),
      });
      child.effect(() => () => disposeRpc());
    });
  }
}
