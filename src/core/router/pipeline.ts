// pipeline：M3 总装——耳朵（fetch/normalize）→ 门卫（gate）→ 管理员
// （router）→ DSH（ask 流）→ 嘴巴（humanize/sender）的单向流。
//
// 状态机（每条 accepted 消息；崩溃语义 = at-most-once，防重复 > 防丢）：
//   gate 评估
//     ├─ already-seen / 白名单拒绝 → 终态：cursor 推进（不 mark）
//     └─ pass → claim：markSeen 落盘（先记账后处理）
//          route（懒验证/建会话；归档换绑走系统路径告知）
//          ask（流式收集）
//          sendHumanized（AI 路径）
//          终态：cursor 推进落盘
//
// 失败分层（定案：send 失败不重试、不重复回复）：
//   - pre-ask 失败（route/告知/ask 流）：unmarkSeen 落盘，cursor 不动
//     → 下轮重拉重试（零副作用失败才配重试）；
//   - send 阶段失败：保持 claim + cursor 推进 → 这条算处理完（吞），
//     日志留痕，绝不重发；
//   - SendError(automation-permission)：权限被收回，重试只会刷屏
//     -1743 → 停轮询等人工，RunResult.permission-stopped。
//
// cursor 推进时机（与 M2 定案一致：覆盖所有拉出行，含被滤的）：
// normalize skipped 行只推进内存 cursor（搭车下一条/batch 尾落盘），
// 崩溃重拉后 normalize 幂等再拒，无副作用。
//
// 轮询与退避：intervalMs 起步，拉取抛错逐次翻倍至 maxBackoffMs，
// 成功一轮重置；单条消息处理失败不计入（已就地消化）。

import type { ChatDbRow } from '../imessage/chatdb';
import { normalizeRows } from '../imessage/normalize';
import type { LoadImagesResult } from '../imessage/media';
import { type ImessageSender, SendError } from '../imessage/sender';
import { stageOutboundFile, sweepStaleOutbound, type OutboundDeps } from '../imessage/outbound';
import type { ArtifactCollector } from './artifacts';
import { sendHumanized, LEGACY_STYLE, type ReplyStyle } from '../imessage/humanize';
import type { Logger } from '../log/jsonl';
import type { AccessPolicy } from '../types/policy';
import type { AskPart, DshPort } from '../types/dsh';
import { IMAGE_PLACEHOLDER } from '../types/dsh';
import type { MessageAttachment, NormalizedMessage } from '../types/messages';
import type { ChannelState } from '../types/state';
import { evaluateGate, markSeen, unmarkSeen } from './gate';
import type { SessionRouter } from './session-router';

/** 单条消息 ask 失败的最大尝试次数（首答 + 重试），超过即吞 + 告知（定案 B+）。 */
export const MAX_ASK_RETRIES = 3;

/** 拉取连续失败上限：达到即终止（退避节奏下约 6 分钟全故障 = 读通道真死）。 */
export const MAX_FETCH_FAILURES = 10;

// ---------------------------------------------------------------------------
// 依赖与选项
// ---------------------------------------------------------------------------

export interface PipelineDeps {
  /** 拉一批增量行（组装层闭包 db；pipeline 不碰数据库对象）。 */
  readonly fetchRows: (cursor: number, limit: number) => ChatDbRow[];
  /** 当前库最大 ROWID（cursor=null 首次初始化用，不回放历史）。 */
  readonly currentMaxRowId: () => number;
  readonly sender: ImessageSender;
  readonly port: DshPort;
  readonly router: SessionRouter;
  readonly policy: AccessPolicy;
  /** 归档换绑告知文案（i18n 已渲染）。 */
  readonly sessionSwitchedText: string;
  /** 重试耗尽告知文案（i18n 已渲染）。 */
  readonly replyUnavailableText: string;
  /** 附件发送失败告知（M6.2）：入参文件名，返回完整通知文本。 */
  readonly fileFailedNotice: (fileName: string) => string;
  /** 回复风格（分段开关/上限/延时系数）。用时读 → UI 热改立即生效。 */
  readonly replyStyle?: () => ReplyStyle;
  /** 媒体加载（M6.1 收图；已绑定 IO deps 的高阶面，host 组装层注入）。
   *  缺省时图片路径降级：纯文本照发、纯图退占位（老环境/测试）。 */
  readonly media?: { load(attachments: readonly MessageAttachment[]): Promise<LoadImagesResult> };
  /** 外发交付（M6.2）：缺省 = 无发文件能力，队列残留由下一轮 open 清走。 */
  readonly collector?: ArtifactCollector;
  /** 外发暂存 IO（stage/sweep；注入同 media 纪律）。 */
  readonly outbound?: OutboundDeps;
  readonly loadState: () => ChannelState;
  readonly saveState: (state: ChannelState) => void;
  readonly log?: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export interface PipelineOptions {
  readonly signal?: AbortSignal;
  /** 轮询间隔（默认 2s）。 */
  readonly intervalMs?: number;
  /** 退避上限（默认 60s）。 */
  readonly maxBackoffMs?: number;
  /** 单批拉取上限（默认 50）。 */
  readonly batchLimit?: number;
  /** 等待实现（测试假钟）。 */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 时间源（测试假钟；默认 Date.now）。 */
  readonly now?: () => number;
}

export interface RunResult {
  /** 停止原因。fetch-exhausted = 拉取连续失败到上限（读通道死亡，宿主层处理）。 */
  readonly reason: 'aborted' | 'permission-stopped' | 'fetch-exhausted' | 'fatal';
  /** 完整走完（含吞掉）的消息数。 */
  readonly processed: number;
}

// ---------------------------------------------------------------------------
// 内部：单条消息处理
// ---------------------------------------------------------------------------

const isPermissionError = (err: unknown): boolean =>
  err instanceof Error && (err as SendError).kind === 'automation-permission';

export interface MessageOutcome {
  readonly kind: 'done' | 'retry' | 'permission-stopped';
}

// ---------------------------------------------------------------------------
// 总装
// ---------------------------------------------------------------------------

export async function runPipeline(
  deps: PipelineDeps,
  options: PipelineOptions = {},
): Promise<RunResult> {
  const { fetchRows, sender, port, router, loadState, saveState, log } = deps;
  // policy / 文案不解构定格：每次使用时读 deps（通道热更换白名单/语言
  // 即改 deps 字段，运行中的循环立即生效——见 hot config swap 测试）
  const signal = options.signal;
  const intervalMs = options.intervalMs ?? 2_000;
  const maxBackoffMs = options.maxBackoffMs ?? 60_000;
  const batchLimit = options.batchLimit ?? 50;
  const sleep =
    options.sleep ??
    (async (ms, sig) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        sig?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(sig.reason ?? new Error('aborted'));
          },
          { once: true },
        );
      });
    });

  const aborted = () => (signal?.aborted === true ? (signal.reason ?? new Error('aborted')) : null);

  /** 时间源（测试注入假钟；core 层不直接读真时钟）。 */
  const now = options.now ?? Date.now;

  let processed = 0;
  /** ask 失败计数（内存态：重启清零 = 干预后再给满额机会）。 */
  const retryCounts = new Map<string, number>();
  /** 拉取连续失败计数（成功一次即清零）。 */
  let fetchFailStreak = 0;

  // cursor=null = 首次启动：定位当前水位，不回放历史（M2 定案）
  const initialCursor = loadState().cursor;
  let cursor: number;
  if (initialCursor === null) {
    cursor = deps.currentMaxRowId();
    saveState({ ...loadState(), cursor });
    log?.info('pipeline.cursor-initialized', { cursor });
  } else {
    cursor = initialCursor;
  }

  /** 组装 ask prompt（M6.1）：文本 + 图片内容块。
   *  图片级失败只剔该图（media 层已结构化）；全失败且无文本 → 占位
   *  兜底（分叉②：空 prompt 会吞消息语义）；media 未装配同款降级。 */
  const buildPrompt = async (msg: NormalizedMessage): Promise<string | readonly AskPart[]> => {
    const textFallback = () => (msg.text === '' ? IMAGE_PLACEHOLDER : msg.text);
    if (!msg.attachments || msg.attachments.length === 0) return textFallback();
    if (!deps.media) return textFallback();
    let media: LoadImagesResult;
    try {
      media = await deps.media.load(msg.attachments);
    } catch (err) {
      // 防御：loadImages 契约永不抛，但 fake/未来实现可能破坏契约
      log?.warn('pipeline.media-failed', {
        guid: msg.guid,
        attachments: msg.attachments.length,
        error: err instanceof Error ? err.message : String(err),
      });
      return textFallback();
    }
    // 仅有附件的消息打点（空批不打点原则不变）；内容永不入日志
    const reasons: Record<string, number> = {};
    for (const s of media.skipped) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
    log?.info('pipeline.media-loaded', {
      guid: msg.guid,
      loaded: media.loaded.length,
      skipped: media.skipped.length,
      ...(Object.keys(reasons).length > 0 ? { reasons } : {}),
      bytes: media.loaded.reduce((sum, im) => sum + im.bytes.length, 0),
    });
    if (media.loaded.length === 0) return textFallback();
    const parts: AskPart[] = [];
    if (msg.text !== '') parts.push({ type: 'text', text: msg.text }); // 分叉④：纯图不加 text 块
    for (const im of media.loaded) {
      parts.push({
        type: 'image',
        bytes: im.bytes,
        mediaType: im.mediaType,
        ...(im.name !== null ? { name: im.name } : {}),
      });
    }
    return parts;
  };

  /** 处理一条 accepted 消息（claim 已落盘前提下的后半程）。 */
  const processAccepted = async (msg: NormalizedMessage): Promise<MessageOutcome> => {
    const { conversationKey: key, guid, text } = msg;
    let asked = false; // send 阶段前始终保持可重试
    const askStart = now();
    try {
      const routed = await router.route(key);
      if (routed.reason === 'rebind-archived') {
        // 归档换绑告知走系统路径；失败按 pre-ask 处理（重试不再告知）
        await sender.sendSystem(key, deps.sessionSwitchedText);
      }
      log?.info('pipeline.ask-start', {
        guid,
        key,
        sessionId: routed.sessionId,
        chars: text.length,
      });
      // 外发交付队列开轮：清上轮残留（异常中断未取走的旧文件永不混入本轮）
      deps.collector?.open(routed.sessionId);
      const prompt = await buildPrompt(msg);
      const chunks: string[] = [];
      let firstDeltaMs: number | undefined;
      for await (const chunk of port.ask({ sessionId: routed.sessionId, prompt, signal })) {
        firstDeltaMs ??= now() - askStart; // 首字延迟：卡顿归因的关键指标
        chunks.push(chunk);
      }
      asked = true;
      const reply = chunks.join('');
      log?.info('pipeline.ask-done', {
        guid,
        firstDeltaMs: firstDeltaMs ?? null,
        totalMs: now() - askStart,
        chars: reply.length,
      });
      const sendStart = now();
      // 打字延迟等待复用注入的 sleep（测试假钟；生产同款 abort 语义）
      // 风格与时序同源热更：不注入时保留历史行为（分段、不封顶、原速）
      const parts = await sendHumanized(sender, key, reply, {
        signal,
        deps: { sleep },
        style: deps.replyStyle?.() ?? LEGACY_STYLE,
      });
      log?.info('pipeline.reply-sent', {
        guid,
        parts,
        totalMs: now() - sendStart,
        chars: reply.length,
      });
      // 外发附件交付（M6.2）：文本先行已送；工具声明的文件保序逐个补发。
      // collector/outbound 缺一（测试/老组装）= 无交付能力：不 take，
      // 队列留在原地由下一轮 open 清走（不丢不重）。
      const deliver = deps.collector !== undefined && deps.outbound !== undefined;
      const artifacts = deliver ? deps.collector!.take(routed.sessionId) : [];
      if (deliver && artifacts.length > 0) {
        // 暂存清扫只在确有交付时做一次（纪律：下次发送时顺带，非定时）
        const swept = await sweepStaleOutbound(deps.outbound!, { now });
        if (swept.deleted > 0) log?.info('outbound.swept', { deleted: swept.deleted });
      }
      for (const artifact of artifacts) {
        let staged: Awaited<ReturnType<typeof stageOutboundFile>>;
        try {
          staged = await stageOutboundFile(artifact.bytes, artifact.fileName, deps.outbound!, {
            now,
          });
        } catch (err) {
          // at-most-once：暂存失败不重试，继续后续文件（定案同 send）
          log?.warn('outbound.stage-failed', {
            guid,
            key,
            name: artifact.fileName,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        log?.info('outbound.staged', {
          guid,
          name: artifact.fileName,
          bytes: artifact.bytes.length,
        });
        try {
          await sender.sendFile(key, staged.path);
        } catch (err) {
          // at-most-once：发送失败不重试、不断后续；通知文本是 Step C
          log?.warn('file-send-failed', {
            guid,
            key,
            name: artifact.fileName,
            code: err instanceof SendError ? err.kind : 'unknown',
          });
          // 分叉 4 定案：告知对方才能补救；系统路径（[dsh] 前缀 instant）。
          // 通知自身失败不翻案（at-most-once）；权限错误上抛停通道。
          try {
            await sender.sendSystem(key, deps.fileFailedNotice(artifact.fileName));
          } catch (notifyErr) {
            if (isPermissionError(notifyErr)) throw notifyErr;
            log?.warn('pipeline.notify-failed', {
              guid,
              name: artifact.fileName,
              error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
            });
          }
          continue;
        }
        log?.info('file-sent', {
          guid,
          key,
          name: artifact.fileName,
          bytes: artifact.bytes.length,
        });
      }
      return { kind: 'done' };
    } catch (err) {
      if (isPermissionError(err)) return { kind: 'permission-stopped' };
      if (asked) {
        // send 阶段失败：终态吞（定案：不重试不重复回复）
        log?.warn('pipeline.send-failed', {
          guid,
          key,
          error: err instanceof Error ? err.message : String(err),
        });
        return { kind: 'done' };
      }
      // pre-ask 失败：零副作用，恢复重试
      log?.warn('pipeline.message-failed', {
        guid,
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return { kind: 'retry' };
    }
  };

  let backoffMs = intervalMs;

  while (true) {
    const abortErr = aborted();
    // 正常停机（卸载/宿主关闭/权限停机后的收尾）：返回结果而非 reject，
    // 这样 processed 计数能进日志，且与"sleep 期间中止"走同一路径
    if (abortErr) return { reason: 'aborted', processed };

    const batchStart = cursor;
    let persisted = true; // 内存 cursor 是否已落盘（skipped 搭车后置 false）

    let rows: ChatDbRow[];
    try {
      rows = fetchRows(cursor, batchLimit);
      fetchFailStreak = 0; // 拉到（哪怕空批）= 通道活着，清零
      // 空批不打点：2 秒一条心跳会把日志刷爆
      if (rows.length > 0)
        log?.info('pipeline.fetch', { fetched: rows.length, cursor: batchStart });
    } catch (err) {
      fetchFailStreak += 1;
      log?.error('pipeline.fetch-failed', {
        error: err instanceof Error ? err.message : String(err),
        streak: fetchFailStreak,
        retryInMs: backoffMs,
      });
      if (fetchFailStreak >= MAX_FETCH_FAILURES) {
        // 连续失败到上限：读通道真死（文件被删/权限被收等），不无限耗着
        log?.error('pipeline.fetch-exhausted', { failures: fetchFailStreak });
        return { reason: 'fetch-exhausted', processed };
      }
      try {
        await sleep(backoffMs, signal);
      } catch {
        return { reason: 'aborted', processed };
      }
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      continue;
    }

    /** 落盘：seenIds 换新 + cursor 推到给定值（当前内存位置或终态行）。 */
    const persist = (nextCursor: number, nextSeen: readonly string[]) => {
      saveState({ ...loadState(), cursor: nextCursor, seenIds: nextSeen });
      if (nextCursor >= cursor) cursor = nextCursor;
      persisted = true;
    };

    try {
      for (const result of normalizeRows(rows)) {
        if (result.status === 'skipped') {
          cursor = Math.max(cursor, result.rowId); // 搭车推进，随下次落盘带出
          persisted = false;
          continue;
        }
        const msg = result.message;
        const seenNow = () => loadState().seenIds;

        const verdict = evaluateGate(deps.policy, seenNow(), msg);
        if (!verdict.pass && verdict.reason === 'already-seen') {
          // 终态恢复（上次崩溃在 claim 后/吞后）：cursor 补推进即完成
          log?.info('pipeline.message-skipped', {
            guid: msg.guid,
            rowId: msg.rowId,
            key: msg.conversationKey,
            reason: 'already-seen',
          });
          persist(msg.rowId, seenNow());
          processed += 1;
          continue;
        }
        if (!verdict.pass) {
          // 白名单拒绝：直接回答"为什么没回"
          log?.info('pipeline.message-skipped', {
            guid: msg.guid,
            rowId: msg.rowId,
            key: msg.conversationKey,
            reason: 'not-allowlisted',
          });
          persist(msg.rowId, seenNow()); // cursor 过、不 mark
          continue;
        }

        // claim：先记账落盘（at-most-once）。cursor 停在当前位不动
        // ——保留重拉窗口，ask 失败重试才拉得到这条。
        const claimAt = now();
        persist(cursor, markSeen(seenNow(), msg.guid));
        log?.info('pipeline.message-claimed', {
          guid: msg.guid,
          rowId: msg.rowId,
          key: msg.conversationKey,
          chars: msg.text.length,
        });

        const outcome = await processAccepted(msg);
        if (outcome.kind === 'permission-stopped') {
          log?.error('pipeline.permission-stopped', { guid: msg.guid });
          persist(msg.rowId, loadState().seenIds); // 停机前把状态收干净
          processed += 1;
          return { reason: 'permission-stopped', processed };
        }
        if (outcome.kind === 'retry') {
          const failures = (retryCounts.get(msg.guid) ?? 0) + 1;
          retryCounts.set(msg.guid, failures);
          if (failures < MAX_ASK_RETRIES) {
            // unmark + cursor 不动 + 中断本批：同批后继行不能把 cursor
            // 带过去（否则这条永远拉不到）。下轮从 cursor 重拉。
            persist(cursor, unmarkSeen(loadState().seenIds, msg.guid));
            break;
          }
          // 重试耗尽（定案 B+）：吞 — 保持 claim + cursor 推进，本批
          // 继续处理后续消息（不堵塞）；best-effort 系统告知后即经。
          persist(msg.rowId, loadState().seenIds);
          processed += 1;
          retryCounts.delete(msg.guid);
          log?.warn('pipeline.retry-exhausted', {
            guid: msg.guid,
            key: msg.conversationKey,
            attempts: failures,
          });
          try {
            await sender.sendSystem(msg.conversationKey, deps.replyUnavailableText);
          } catch (err) {
            if (isPermissionError(err)) {
              log?.error('pipeline.permission-stopped', { guid: msg.guid });
              return { reason: 'permission-stopped', processed };
            }
            // 告知失败不翻案：终态已落盘，仅留痕
            log?.warn('pipeline.notify-failed', {
              guid: msg.guid,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          continue;
        }
        persist(msg.rowId, loadState().seenIds); // 终态（成功或 send 失败吞）
        retryCounts.delete(msg.guid);
        processed += 1;
        log?.info('pipeline.message-done', {
          guid: msg.guid,
          rowId: msg.rowId,
          totalMs: now() - claimAt,
        });
      }
    } catch (err) {
      if (aborted()) return { reason: 'aborted', processed };
      log?.error('pipeline.fatal', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { reason: 'fatal', processed };
    }

    if (!persisted && cursor !== batchStart) {
      saveState({ ...loadState(), cursor, seenIds: loadState().seenIds });
    }

    if (rows.length === 0) {
      try {
        await sleep(intervalMs, signal);
      } catch {
        return { reason: 'aborted', processed };
      }
    } else {
      backoffMs = intervalMs; // 有产出即重置退避
    }
  }
}
