// 数据根解析与全部约定路径。
//
// D5 决策：插件数据独立存放在自己的根目录（~/.dsh-imessage），绝不碰
// dsh-im 的目录（~/.dsh/im、~/.dsh/integrations）。插件的所有持久化内容
// 都挂在这一个根下，检查/备份/卸载只需处理一个目录：
//
//   ~/.dsh-imessage/
//   ├── state.json         cursor/seenIds/sessions（stores/state-store，第 7 步）
//   ├── logs/
//   │   └── imessage.jsonl 结构化 JSONL 日志（log/jsonl，第 5 步）
//   └── conversations/     每手机号一个工作区（routing，M3）
//
// 业务配置不入本目录：走 DSH 官方 Config schema → 存 profile（D9 决策）。

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** 覆盖数据根的环境变量（测试、自定义安装场景用）。 */
export const DATA_ROOT_ENV = 'DSH_IMESSAGE_HOME';

/** 本模块会读取的 process.env 切片。 */
export interface PathEnv {
  readonly [DATA_ROOT_ENV]?: string;
}

/** 插件会接触到的全部文件路径，一次性解析成快照。 */
export interface Paths {
  /** 数据根目录，如 /Users/alice/.dsh-imessage */
  root: string;
  /** 通道状态（cursor / seenIds / sessions）。 */
  stateFile: string;
  /** 结构化 JSONL 日志文件。 */
  logFile: string;
  /** 每个手机号一个会话工作区的父目录。 */
  conversationsDir: string;
}

/** 从 env（缺省为真实环境变量）解析出插件全部路径。 */
export function resolvePaths(env: PathEnv = process.env): Paths {
  const override = env[DATA_ROOT_ENV]?.trim();
  const root = override
    ? override.startsWith('~/')
      ? join(homedir(), override.slice(2)) // 展开 ~ 为真实 home 目录
      : resolve(override) // relative paths resolve against cwd
    : join(homedir(), '.dsh-imessage');

  return {
    root,
    stateFile: join(root, 'state.json'),
    logFile: join(root, 'logs', 'imessage.jsonl'),
    conversationsDir: join(root, 'conversations'),
  };
}
