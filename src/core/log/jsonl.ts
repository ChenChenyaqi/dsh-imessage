// JSONL 结构化日志：一行一个 JSON，供事后 jq/grep 排查。
//
// 设计约定：
// - core 层的 makeLogger 不碰文件系统，sink 由调用方注入（D2）；
//   生产环境用 makeFileSink 指向 paths.logFile。
// - 日志写入永远不抛错：序列化失败降级写一行 log.serialize-failed，
//   记日志出问题不能影响消息管道。
// - 日志内容一律英文（event 名与字段值约定）。

import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** 业务字段：任意可 JSON 序列化的键值对，平铺进日志行。 */
export type LogFields = Readonly<Record<string, unknown>>;

/** 接收完整 JSON 行（不含换行符）的输出端。 */
export type LogSink = (line: string) => void;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  /** 输出端（必填）：文件、内存数组、stdout 均可。 */
  readonly sink: LogSink;
  /** 最低输出级别，默认 info。 */
  readonly minLevel?: LogLevel;
  /** 时间源注入（测试用），默认 Date.now。 */
  readonly now?: () => number;
}

/** 校验事件名：非空字符串，否则抛 TypeError（程序员错误要尽早暴露）。 */
function assertEvent(event: string): void {
  if (typeof event !== 'string' || event === '') {
    throw new TypeError('log event must be a non-empty string');
  }
}

/** 创建 logger。写入永不抛错（除事件名非法）。 */
export function makeLogger(opts: LoggerOptions): Logger {
  const { sink } = opts;
  const minLevel = LEVEL_ORDER[opts.minLevel ?? 'info'];
  const now = opts.now ?? Date.now;

  const write = (level: LogLevel, event: string, fields?: LogFields): void => {
    assertEvent(event);
    if (LEVEL_ORDER[level] < minLevel) return;
    const entry = { ts: now(), level, event, ...fields };
    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      // 序列化失败（循环引用、BigInt 等）：降级，不炸主流程
      line = JSON.stringify({
        ts: now(),
        level,
        event: 'log.serialize-failed',
        rawEvent: event,
      });
    }
    try {
      sink(line);
    } catch {
      // sink 故障（如磁盘满）同样吞掉：日志不阻塞消息管道
    }
  };

  return {
    debug: (e, f) => write('debug', e, f),
    info: (e, f) => write('info', e, f),
    warn: (e, f) => write('warn', e, f),
    error: (e, f) => write('error', e, f),
  };
}

/** 文件 sink：按天滚动（imessage-YYYYMMDD.jsonl）+ 惰性清理。
 *  无定时器无后台任务——只在 sink 创建与跨天切换时顺带删过期文件。 */
export function makeFileSink(
  logDir: string,
  opts: { keepDays?: number; now?: () => Date } = {},
): LogSink {
  const keepDays = opts.keepDays ?? 7;
  const now = opts.now ?? (() => new Date());
  const filePattern = /^imessage-(\d{4})(\d{2})(\d{2})\.jsonl$/;

  mkdirSync(logDir, { recursive: true });

  /** 本地时区 YYYYMMDD（用户视角的“一天”）。 */
  const dateKey = (d: Date): string =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
      d.getDate(),
    ).padStart(2, '0')}`;

  /** 删掉早于保留窗口的日期文件；不匹配模式的文件一律不动（保守）。 */
  const cleanup = (today: Date): void => {
    const threshold = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    threshold.setDate(threshold.getDate() - (keepDays - 1));
    for (const name of readdirSync(logDir)) {
      const m = filePattern.exec(name);
      if (!m) continue;
      const fileDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (fileDate < threshold) {
        try {
          rmSync(join(logDir, name), { force: true });
        } catch {
          // 清理失败不影响写入
        }
      }
    }
  };

  let currentKey = dateKey(now());
  cleanup(now());

  return (line: string) => {
    const nextKey = dateKey(now());
    if (nextKey !== currentKey) {
      currentKey = nextKey; // 跨天：切新文件并顺带清理
      cleanup(now());
    }
    appendFileSync(join(logDir, `imessage-${currentKey}.jsonl`), `${line}\n`, 'utf8');
  };
}
