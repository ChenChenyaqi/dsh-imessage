// JSONL 结构化日志：一行一个 JSON，供事后 jq/grep 排查。
//
// 设计约定：
// - core 层的 makeLogger 不碰文件系统，sink 由调用方注入（D2）；
//   生产环境用 makeFileSink 指向 paths.logFile。
// - 日志写入永远不抛错：序列化失败降级写一行 log.serialize-failed，
//   记日志出问题不能影响消息管道。
// - 日志内容一律英文（event 名与字段值约定）。

import { appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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

/** 文件 sink：追加写、自动建目录。同步实现——日志频率低（秒级几条），
 *  阻塞可忽略，换简单可靠。 */
export function makeFileSink(logFile: string): LogSink {
  mkdirSync(dirname(logFile), { recursive: true });
  return (line: string) => {
    appendFileSync(logFile, `${line}\n`, 'utf8');
  };
}
