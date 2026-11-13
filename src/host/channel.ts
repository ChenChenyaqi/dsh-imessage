// 通道装配：core 全组件 + 宿主适配层 → 一条可启停的 iMessage 通道。
//
// apply(ctx) 是本模块的薄壳（ctx → env 映射 + effect 注册 stop），
// 装配逻辑全部在此独立可测。规格见 tests/host/channel.test.ts。
//
// 启动门卫（M4 定案）：
// - 权限探测失败 → 不启动轮询（半瘫防线：轮询能跑但发送必失败，
//   消息会被 claim 掉却回不出去——宁可不动，等人工修权限后重载插件）
// - 探测通过但 db 打不开 → start-failed（与权限失败分开归因）

import type { DatabaseSync } from 'node:sqlite';
import type { Locale } from '@/core/i18n';
import { makeT } from '@/core/i18n';
import type { ReplyStyle } from '@/core/imessage/humanize';
import { DEFAULT_CONFIG } from '@/core/types/config';
import type { ImessageSender } from '@/core/imessage/sender';
import { makeSender } from '@/core/imessage/sender';
import { defaultChatDbPath, nodeProbeDeps, probeEnvironment } from '@/core/imessage/env';
import type { ProbeDeps } from '@/core/imessage/env';
import { fetchBatch, openChatDb, readMaxRowId } from '@/core/imessage/chatdb';
import type { LogSink, Logger } from '@/core/log/jsonl';
import { makeFileSink, makeLogger } from '@/core/log/jsonl';
import { resolvePaths } from '@/core/paths';
import type { Paths } from '@/core/paths';
import { runPipeline } from '@/core/router/pipeline';
import { makeSessionRouter } from '@/core/router/session-router';
import { loadState, saveState } from '@/core/stores/state-store';
import type { EnvProbe } from '@/core/imessage/env';
import { makeDshPort } from '@/host/dsh-port';
import type { DshEventSource, DshPortServices } from '@/host/dsh-port';

// ---------------------------------------------------------------------------
// 配置与环境
// ---------------------------------------------------------------------------

/** 通道配置（apply 侧由 Config schema 校验并填默认后传入）。 */
export interface ChannelConfig {
  readonly locale?: Locale;
  readonly allowlist?: readonly string[];
  readonly intervalMs?: number;
  readonly maxBackoffMs?: number;
  /** 分段回复开关（缺省 false：整段直发、零等待）。 */
  readonly chunkedReplies?: boolean;
  /** 最大分段数（缺省 8）。 */
  readonly maxChunks?: number;
  /** 延时系数（缺省 1；0 = 分段不延时）。 */
  readonly delayFactor?: number;
  /** agent 预设 id（人设组合；缺省内置预设 dafeiyu，仅新建会话生效）。 */
  readonly agentPreset?: string;
}

/** 装配环境：宿主面必填，macOS IO 可注入（默认 node 实现）。 */
export interface ChannelEnv {
  /** DSH 宿主服务（真宿主来自 inject；测试来自 fake host）。 */
  readonly services: DshPortServices;
  /** 事件源（真宿主传 ctx；测试传 fake host）。 */
  readonly events: DshEventSource;
  /** 数据根解析结果（默认 resolvePaths()；测试注入临时目录）。 */
  readonly paths?: Paths;
  /** 权限探测依赖（默认 nodeProbeDeps）。 */
  readonly probe?: ProbeDeps;
  /** 发送器（默认 makeSender() 走真 osascript；测试注入 fake）。 */
  readonly sender?: ImessageSender;
  /** chat.db 打开（默认 openChatDb；测试注入内存库）。 */
  readonly openDb?: (path: string) => DatabaseSync;
  /** chat.db 路径（默认 defaultChatDbPath）。 */
  readonly chatDbPath?: string;
  /** 日志 sink（默认按天滚动的文件 sink）。 */
  readonly logSink?: LogSink;
  /** 轮询/打字 sleep（默认真 sleep；测试注入 no-op）。 */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

// ---------------------------------------------------------------------------
// 状态与句柄
// ---------------------------------------------------------------------------

export type ChannelStatus =
  | { readonly phase: 'probe-failed'; readonly probe: EnvProbe }
  | { readonly phase: 'start-failed'; readonly error: string }
  | { readonly phase: 'running' }
  | { readonly phase: 'stopped'; readonly reason: string };

/** 热更新载荷（UI 改 volatile 字段 → loader/volatile-update）。 */
export interface HotConfigPatch {
  readonly locale?: Locale;
  readonly allowlist?: readonly string[];
  readonly chunkedReplies?: boolean;
  readonly maxChunks?: number;
  readonly delayFactor?: number;
  readonly agentPreset?: string;
}

export interface ChannelHandle {
  /** 当前通道状态（RPC 查询面，Step 4 消费）。 */
  status(): ChannelStatus;
  /** 热更新配置：不重启通道立即生效（白名单/语言），并留痕日志。 */
  updateConfig(patch: HotConfigPatch): void;
  /** 当前生效白名单（RPC 活读；probe-failed 通道也可答）。 */
  currentAllowlist(): readonly string[];
  /** 当前生效回复风格（RPC 活读；probe-failed 通道也可答）。 */
  currentStyle(): ReplyStyle;
  /** 停止：abort → 等收尾 → 关库。幂等。 */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

export function startImessageChannel(
  config: ChannelConfig,
  env: ChannelEnv,
): ChannelHandle {
  // 生效配置的活容器：updateConfig 改它 + deps 字段（运行中的循环
  // 用时读 deps，立即生效）；probe-failed 也能答"当前配置"
  const live: {
    locale: Locale;
    allowlist: readonly string[];
    intervalMs?: number;
    maxBackoffMs?: number;
    style: ReplyStyle;
    agentPreset: string;
  } = {
    locale: config.locale ?? 'zh',
    allowlist: config.allowlist ?? [],
    intervalMs: config.intervalMs,
    maxBackoffMs: config.maxBackoffMs,
    style: {
      chunked: config.chunkedReplies ?? false,
      maxChunks: config.maxChunks ?? DEFAULT_CONFIG.maxChunks,
      delayFactor: config.delayFactor ?? DEFAULT_CONFIG.delayFactor,
    },
    agentPreset: config.agentPreset ?? DEFAULT_CONFIG.agentPreset,
  };
  // 生效意图：未设置 = dafeiyu（未装则 dsh-port 降级宿主默认并 warn）

  // 可变 deps：运行中通道才登记（probe-failed 保持 undefined，热更新仅记录）
  // 运行中通道才登记（probe-failed 保持 undefined，热更新仅记录）
  const mutableDeps: {
    current: {
      policy: { allowlist: readonly string[] };
      sessionSwitchedText: string;
      replyUnavailableText: string;
      replyStyle: () => ReplyStyle;
    } | undefined;
  } = { current: undefined };

  const paths = env.paths ?? resolvePaths();
  const log: Logger = makeLogger({
    sink: env.logSink ?? makeFileSink(paths.logDir),
  });

/** 热更新落点：改 live 容器 + 运行中的 deps 字段，打一行留痕日志。 */
  function applyHotConfig(patch: HotConfigPatch): void {
    const changed: string[] = [];
    if (patch.locale !== undefined && patch.locale !== live.locale) changed.push('locale');
    // 白名单按元素比较：顺序即用户输入顺序，长度或任一位不同才算变
    const sameAllowlist = patch.allowlist !== undefined
      && patch.allowlist.length === live.allowlist.length
      && patch.allowlist.every((entry, index) => entry === live.allowlist[index]);
    if (patch.allowlist !== undefined && !sameAllowlist) changed.push('allowlist');
    if (patch.locale !== undefined) live.locale = patch.locale;
    if (patch.allowlist !== undefined) live.allowlist = patch.allowlist;
    if (patch.chunkedReplies !== undefined && patch.chunkedReplies !== live.style.chunked) {
      changed.push('chunkedReplies');
    }
    if (patch.maxChunks !== undefined && patch.maxChunks !== live.style.maxChunks) {
      changed.push('maxChunks');
    }
    if (patch.delayFactor !== undefined && patch.delayFactor !== live.style.delayFactor) {
      changed.push('delayFactor');
    }
    if (patch.chunkedReplies !== undefined
      || patch.maxChunks !== undefined
      || patch.delayFactor !== undefined) {
      live.style = {
        chunked: patch.chunkedReplies ?? live.style.chunked,
        maxChunks: patch.maxChunks ?? live.style.maxChunks,
        delayFactor: patch.delayFactor ?? live.style.delayFactor,
      };
    }
    if (patch.agentPreset !== undefined && patch.agentPreset !== live.agentPreset) {
      changed.push('agentPreset');
    }
    if (patch.agentPreset !== undefined) live.agentPreset = patch.agentPreset;
    // 运行中的 pipeline 用时读 deps：直接改字段即热生效
    if (mutableDeps.current !== undefined) {
      const t = makeT(live.locale);
      if (patch.allowlist !== undefined) mutableDeps.current.policy = { allowlist: patch.allowlist };
      mutableDeps.current.sessionSwitchedText = t('session.switched');
      mutableDeps.current.replyUnavailableText = t('reply.unavailable');
    }
    log.info('channel.config-updated', {
      locale: live.locale,
      allowlistCount: live.allowlist.length,
      agentPreset: live.agentPreset,
      chunkedReplies: live.style.chunked,
      maxChunks: live.style.maxChunks,
      delayFactor: live.style.delayFactor,
      changed,
    });
  }

  // -- 权限门卫：两项探测任一失败都不启动（半瘫防线） --------------
  const probe = probeEnvironment(env.chatDbPath ?? defaultChatDbPath(), env.probe ?? nodeProbeDeps);
  if (!probe.disk.ok || !probe.automation.ok) {
    log.error('channel.probe-failed', {
      disk: probe.disk.detail ?? 'ok',
      automation: probe.automation.detail ?? 'ok',
    });
    return {
      status: () => ({ phase: 'probe-failed', probe }),
      updateConfig: (patch) => applyHotConfig(patch),
      currentAllowlist: () => live.allowlist,
      currentStyle: () => live.style,
      stop: async () => undefined,
    };
  }

  // 探测通过：把真实探测结果留痕（权限问题的第一现场）
  log.info('channel.probe-ok', {
    chatDbPath: probe.chatDbPath,
    disk: probe.disk.ok,
    automation: probe.automation.ok,
  });

  // -- 打开 chat.db（探测与打开之间的竞态单独归因） ------------------
  const dbPath = env.chatDbPath ?? defaultChatDbPath();
  let db: DatabaseSync;
  try {
    db = env.openDb ? env.openDb(dbPath) : openChatDb(dbPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error('channel.start-failed', { error: detail });
    return {
      status: () => ({ phase: 'start-failed', error: detail }),
      updateConfig: (patch) => applyHotConfig(patch),
      currentAllowlist: () => live.allowlist,
      currentStyle: () => live.style,
      stop: async () => undefined,
    };
  }

  // -- 全组件组装 -------------------------------------------------------
  const sender = env.sender ?? makeSender();
  const t = makeT(live.locale);
  const stateFile = paths.stateFile;
  const controller = new AbortController();

  const port = makeDshPort({
    services: env.services,
    events: env.events,
    dataRoot: paths.root,
  });
  const router = makeSessionRouter({
    port,
    // 用时读：热更预设只影响之后新建的会话（composition 定格事实）。
    // 未设置（空）→ 意图 dafeiyu；装没装由 dsh-port 的 roster resolve 兜底
    preset: () => live.agentPreset || 'dafeiyu',
    loadState: () => loadState(stateFile),
    saveState: (state) => saveState(stateFile, state),
    log,
  });

  const deps = {
    fetchRows: (cursor: number, limit: number) => fetchBatch(db, cursor, limit),
    currentMaxRowId: () => readMaxRowId(db) ?? 0,
    sender,
    port,
    router,
    policy: { allowlist: config.allowlist ?? [] },
    sessionSwitchedText: t('session.switched'),
    replyUnavailableText: t('reply.unavailable'),
    replyStyle: () => live.style,
    loadState: () => loadState(stateFile),
    saveState: (state: Parameters<typeof saveState>[1]) => saveState(stateFile, state),
    log,
  };
  mutableDeps.current = deps;
  const run = runPipeline(deps, {
    signal: controller.signal,
    intervalMs: config.intervalMs,
    maxBackoffMs: config.maxBackoffMs,
    sleep: env.sleep,
  });

  // 启动成功：一行交代生效配置 + 起始水位（排查"配置到底生效没"）
  log.info('channel.started', {
    locale: config.locale ?? 'zh',
    allowlist: config.allowlist ?? [],
    allowlistCount: (config.allowlist ?? []).length,
    agentPreset: live.agentPreset || 'dafeiyu',
    chunkedReplies: live.style.chunked,
    maxChunks: live.style.maxChunks,
    delayFactor: live.style.delayFactor,
    intervalMs: config.intervalMs ?? null,
    maxBackoffMs: config.maxBackoffMs ?? null,
    cursor: loadState(stateFile).cursor ?? readMaxRowId(db) ?? 0,
  });

  // pipeline 的 fatal 形态：RunResult 或 reject（首启 cursor-init 落盘
  // 在循环 try 外）——两种都收敛为 stopped 状态，不区分展示
  let status: ChannelStatus = { phase: 'running' };
  const settled = run.then(
    (result) => {
      status = { phase: 'stopped', reason: result.reason };
      if (result.reason !== 'aborted') {
        log.warn('channel.stopped-unexpectedly', { reason: result.reason });
      }
      log.info('channel.stopped', { reason: result.reason, processed: result.processed });
      return result;
    },
    (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      // 我们主动 stop 触发的顶层抛出（abort 原因）是正常收尾，不是 fatal
      const reason = controller.signal.aborted ? 'aborted' : 'fatal';
      status = { phase: 'stopped', reason };
      if (reason === 'fatal') log.error('channel.fatal', { error: detail });
      log.info('channel.stopped', { reason });
      throw error;
    },
  );
  // 防 unhandledRejection：fatal 时 settled 已有消费方（stop/无人 stop）
  settled.catch(() => undefined);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // 卸载/禁用/宿主关闭都走这里：先留痕再中止
    log.info('channel.stop-requested');
    controller.abort();
    try {
      await settled;
    } catch {
      // fatal 已记录日志；stop 只负责收尾不重复抛
    }
    db.close();
  };

  return {
    status: () => status,
    updateConfig: (patch) => applyHotConfig(patch),
    currentAllowlist: () => live.allowlist,
    currentStyle: () => live.style,
    stop,
  };
}
