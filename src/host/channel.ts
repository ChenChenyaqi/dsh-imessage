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

export interface ChannelHandle {
  /** 当前通道状态（RPC 查询面，Step 4 消费）。 */
  status(): ChannelStatus;
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
  const paths = env.paths ?? resolvePaths();
  const log: Logger = makeLogger({
    sink: env.logSink ?? makeFileSink(paths.logDir),
  });

  // -- 权限门卫：两项探测任一失败都不启动（半瘫防线） --------------
  const probe = probeEnvironment(env.chatDbPath ?? defaultChatDbPath(), env.probe ?? nodeProbeDeps);
  if (!probe.disk.ok || !probe.automation.ok) {
    log.error('channel.probe-failed', {
      disk: probe.disk.detail ?? 'ok',
      automation: probe.automation.detail ?? 'ok',
    });
    return {
      status: () => ({ phase: 'probe-failed', probe }),
      stop: async () => undefined,
    };
  }

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
      stop: async () => undefined,
    };
  }

  // -- 全组件组装 -------------------------------------------------------
  const sender = env.sender ?? makeSender();
  const t = makeT(config.locale ?? 'zh');
  const stateFile = paths.stateFile;
  const controller = new AbortController();

  const port = makeDshPort({
    services: env.services,
    events: env.events,
    dataRoot: paths.root,
  });
  const router = makeSessionRouter({
    port,
    loadState: () => loadState(stateFile),
    saveState: (state) => saveState(stateFile, state),
    log,
  });

  const run = runPipeline(
    {
      fetchRows: (cursor, limit) => fetchBatch(db, cursor, limit),
      currentMaxRowId: () => readMaxRowId(db) ?? 0,
      sender,
      port,
      router,
      policy: { allowlist: config.allowlist ?? [] },
      sessionSwitchedText: t('session.switched'),
      replyUnavailableText: t('reply.unavailable'),
      loadState: () => loadState(stateFile),
      saveState: (state) => saveState(stateFile, state),
      log,
    },
    {
      signal: controller.signal,
      intervalMs: config.intervalMs,
      maxBackoffMs: config.maxBackoffMs,
      sleep: env.sleep,
    },
  );

  // pipeline 的 fatal 形态：RunResult 或 reject（首启 cursor-init 落盘
  // 在循环 try 外）——两种都收敛为 stopped 状态，不区分展示
  let status: ChannelStatus = { phase: 'running' };
  const settled = run.then(
    (result) => {
      status = { phase: 'stopped', reason: result.reason };
      if (result.reason !== 'aborted') {
        log.warn('channel.stopped-unexpectedly', { reason: result.reason });
      }
      return result;
    },
    (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      // 我们主动 stop 触发的顶层抛出（abort 原因）是正常收尾，不是 fatal
      const reason = controller.signal.aborted ? 'aborted' : 'fatal';
      status = { phase: 'stopped', reason };
      if (reason === 'fatal') log.error('channel.fatal', { error: detail });
      throw error;
    },
  );
  // 防 unhandledRejection：fatal 时 settled 已有消费方（stop/无人 stop）
  settled.catch(() => undefined);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
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
    stop,
  };
}
