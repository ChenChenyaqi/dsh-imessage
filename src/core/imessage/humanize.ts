// 拟人化发送编排（仅服务 AI 路径；系统路径零延迟直发，不经本模块）。
//
// 分段哲学（dsh-im 验证过的事实，D7）：一行 = 一条气泡（iMessage 原生
// 习惯）；空行丢弃；代码块（``` 围栏）整体保留永不切断（用户复制友好）。
// 每段前都等待（含末段）：真人连发多条气泡，条与条之间也有打字间隔。
//
// 延迟参数（dsh-im 实测节奏，数值直接借用）：
// - 首段前 600–1800ms（「思考」）；
// - 段间基础 250ms + 按段长度 4 字/秒的打字时间；
// - ±25% 抖动后夹逼到 [250ms, 5000ms]；
// - 代码块视为「粘贴」：300–800ms 平坦延迟（没人手打代码）。
//
// 随机源与等待均可注入（测试确定性）；abort 信号贯穿等待与发送之间。

import type { ImessageSender } from './sender';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

/** 拟人节奏参数（值来自 dsh-im 实测，冻结防漂移）。 */
export const HUMANIZE_DEFAULTS = Object.freeze({
  firstReplyMinMs: 600,
  firstReplyMaxMs: 1_800,
  baseDelayMs: 250,
  charsPerSecond: 4,
  minDelayMs: 250,
  maxDelayMs: 5_000,
  jitterRatio: 0.25,
  pasteMinMs: 300,
  pasteMaxMs: 800,
});

// ---------------------------------------------------------------------------
// 分段（纯函数）
// ---------------------------------------------------------------------------

/**
 * 把回复文本切成 iMessage 气泡段：
 * - 逐行输出（trim），空行丢弃；
 * - ``` 围栏内的行合并为一段（未闭合的围栏到文末同样保持一体）；
 * - 无有效行时返回 [原文 trim()]（至少一段，空文本则 ['']，由调用方
 *   的空文本校验兜底）。
 */
export function splitReplyParts(text: string): string[] {
  const parts: string[] = [];
  let block: string[] | null = null;
  for (const line of text.split('\n')) {
    if (block) {
      block.push(line);
      if (line.trim().startsWith('```')) {
        parts.push(block.join('\n'));
        block = null;
      }
      continue;
    }
    if (line.trim().startsWith('```')) {
      block = [line];
      continue;
    }
    const plain = line.trim();
    if (plain) parts.push(plain);
  }
  if (block) parts.push(block.join('\n'));
  return parts.length > 0 ? parts : [text.trim()];
}

// ---------------------------------------------------------------------------
// 回复风格（配置驱动：分段开关 / 最大分段数 / 延时系数）
// ---------------------------------------------------------------------------

/** 一条回复的发送风格。 */
export interface ReplyStyle {
  /** false = 整段一条直发、零等待；true = 按分段哲学切气泡。 */
  readonly chunked: boolean;
  /** 分段数上限：超出部分换行并入最后一段（0/负数视为 1）。 */
  readonly maxChunks: number;
  /** 延时系数：计算出的延迟 × 系数；0 = 分段但不等待。 */
  readonly delayFactor: number;
}

/** 未注入风格时的默认（保留历史行为：分段、不设上限、原速延迟）。 */
export const LEGACY_STYLE: ReplyStyle = Object.freeze({
  chunked: true,
  maxChunks: Number.POSITIVE_INFINITY,
  delayFactor: 1,
});

/** 分段数封顶：超出上限的段落并入最后一段（换行连接，内容不丢）。 */
export function capParts(parts: readonly string[], maxChunks: number): string[] {
  const cap = Math.max(1, Math.floor(maxChunks));
  if (parts.length <= cap) return [...parts];
  const head = parts.slice(0, cap - 1);
  return [...head, parts.slice(cap - 1).join('\n')];
}

// ---------------------------------------------------------------------------
// 延迟计算（纯函数）
// ---------------------------------------------------------------------------

export interface DelayOptions {
  /** 是否首段（首段前有「思考」区间）。 */
  readonly isFirst?: boolean;
  /** 随机源注入（测试固定值）。 */
  readonly random?: () => number;
}

/** 计算发送下一段前的等待毫秒。 */
export function computeTypingDelayMs(nextText: string, options: DelayOptions = {}): number {
  const d = HUMANIZE_DEFAULTS;
  const random = options.random ?? Math.random;
  const rand = (min: number, max: number) => min + random() * (max - min);

  let base: number;
  if (nextText.trim().startsWith('```')) {
    base = rand(d.pasteMinMs, d.pasteMaxMs); // 粘贴行为：平坦短延迟
  } else {
    base =
      (options.isFirst ? rand(d.firstReplyMinMs, d.firstReplyMaxMs) : d.baseDelayMs) +
      (Array.from(nextText).length / d.charsPerSecond) * 1_000;
  }
  const jitter = 1 + rand(-d.jitterRatio, d.jitterRatio);
  return Math.min(d.maxDelayMs, Math.max(d.minDelayMs, Math.round(base * jitter)));
}

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------

export interface HumanizeDeps {
  /** 等待实现（默认 setTimeout；测试注入假钟）。 */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** abort 感知的 sleep（默认实现）。 */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    // 提前 abort：还没定时器可清，直接拒绝（不能走 abort 闭包——
    // 那里 clearTimeout(timer) 会碰到未初始化的 timer）
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('humanized send aborted'));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('humanized send aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export interface SendHumanizedOptions extends DelayOptions {
  readonly signal?: AbortSignal;
  readonly deps?: HumanizeDeps;
  readonly random?: () => number;
  /** 回复风格（默认 LEGACY_STYLE：分段、不封顶、原速延迟）。 */
  readonly style?: ReplyStyle;
}

/**
 * 拟人化发送：按风格分段 → 每段「等待（打字节奏 × 系数）→ 发送」。
 * 关闭分段时整段一条直发、零等待。返回发出的段数。
 * 发送失败（SendError）直接向上抛——已发出的段无法撤回，重试/放弃
 * 策略归 pipeline。
 */
export async function sendHumanized(
  sender: ImessageSender,
  address: string,
  text: string,
  options: SendHumanizedOptions = {},
): Promise<number> {
  const deps = options.deps ?? { sleep: defaultSleep };
  const style = options.style ?? LEGACY_STYLE;
  // 不分段：整段一条、零等待（含首段思考延迟也不做）
  if (!style.chunked) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error('humanized send aborted');
    }
    await sender.sendText(address, text.trim());
    return 1;
  }
  const parts = capParts(splitReplyParts(text), style.maxChunks);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error('humanized send aborted');
    }
    const base = computeTypingDelayMs(part, {
      isFirst: index === 0,
      random: options.random,
    });
    // 系数先乘、再夹回节奏上限：clamp 只发生在乘之前会让大系数把
    // 单段等待放大到上限的 N 倍（真机踩过：系数 5 → 25s）
    const delay = Math.min(HUMANIZE_DEFAULTS.maxDelayMs, Math.round(base * style.delayFactor));
    // 系数 0 = 分段但不等待：连 sleep 调用都不发生
    if (delay > 0) await deps.sleep(delay, options.signal);
    await sender.sendText(address, part);
  }
  return parts.length;
}
