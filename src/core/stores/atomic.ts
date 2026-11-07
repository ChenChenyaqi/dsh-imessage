// JSON 文件原子读写机制。
//
// 原子性：先写同目录 tmp 文件，再 rename 落位。POSIX 上同文件系统
// 的 rename 是原子的——崩溃时目标文件要么是旧内容、要么是新内容，
// 永远不会出现半截 JSON。
//
// 职责边界：本模块只管机制（读、写、损坏抛错），「损坏后怎么办」
// （留档重置等业务策略）由上层 store 决定。

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 文件存在但内容不是合法 JSON 时抛出。 */
export class JsonCorruptError extends Error {
  constructor(
    /** 损坏的文件路径。 */
    public readonly file: string,
    /** 底层解析错误。 */
    public readonly cause: unknown,
  ) {
    super(`JSON file is corrupt: ${file}`);
    this.name = 'JsonCorruptError';
  }
}

/** 唯一 tmp 文件名：同目录、与目标同文件系统（rename 原子的前提）。 */
function tmpFileFor(file: string): string {
  return join(dirname(file), `.${basenameOf(file)}.${randomUUID()}.tmp`);
}

// node:path 的 basename 在 win 上也按 / 切，这里够用。
function basenameOf(file: string): string {
  const parts = file.split(/[\\/]/);
  return parts[parts.length - 1] || file;
}

/** 原子写：value 会被 JSON.stringify（pretty 2 空格，便于人工查看）。 */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = tmpFileFor(file);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    renameSync(tmp, file);
  } catch (err) {
    // rename 失败：直接删掉 tmp，不留垃圾（tmp 内容就是调用方要写
    // 的数据，调用方重试即可，保留毫无价值）
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 尽力而为 */
    }
    throw err;
  }
}

/**
 * 读取并解析 JSON。
 * - 文件不存在 → undefined（上层据此走「全新环境」分支）；
 * - 存在但解析失败 → 抛 JsonCorruptError（上层决定 quarantine/重置）。
 */
export function readJson<T = unknown>(file: string): T | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new JsonCorruptError(file, err);
  }
}
