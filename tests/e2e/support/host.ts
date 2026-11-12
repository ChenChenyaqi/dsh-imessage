// 真机 e2e 的宿主夹具：起一个完全隔离的 DSH，跑完清理干净。
//
// 隔离三层（真实环境一字不动）：
// 1. DSH_HOME          → 临时目录（profiles / storages / sessions 全在里面）
// 2. DSH_IMESSAGE_HOME → 临时目录（插件 state / logs，不碰真实 cursor）
// 3. 白名单填假号码，且只通过 UI 改配置，不产生任何真实 iMessage
//
// 清理：杀进程组 → 删临时目录 → 复检已消失；进程被外部杀掉时，
// 下一次启动前先扫掉残留（sweepLeftovers），避免越积越多。

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** 仓库根目录（pnpm 从这里跑）。 */
export const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
/** 我们插件的 profile entry id（= 配置命名空间）。 */
export const ENTRY_ID = 'chenyaqi-dsh-imessage';
/** 每个 e2e 运行用的临时 profile 名。 */
const PROFILE = 'imessage-e2e';
/** 临时目录前缀（sweepLeftovers 按它清理）。 */
const PREFIX = 'dsh-e2e-';

/** 一条插件日志。 */
export interface LogRow {
  readonly ts: number;
  readonly level: string;
  readonly event: string;
  readonly [key: string]: unknown;
}

export interface HostRun {
  /** 带 token 的页面地址。 */
  readonly url: string;
  /** 临时 DSH_HOME。 */
  readonly home: string;
  /** 临时插件数据目录。 */
  readonly data: string;
  /** profile patch 文件（UI 保存会改它）。 */
  readonly patchPath: string;
  /** 读当前插件日志。 */
  readLog(): LogRow[];
  /** 读 patch 文件文本。 */
  readPatch(): string;
  /** 停宿主并清理临时目录（幂等）。 */
  stop(): Promise<void>;
}

/** 阶段计时（排查 e2e 慢/卡用；E2E_VERBOSE=0 可关闭）。 */
const verbose = process.env.E2E_VERBOSE !== '0';
const started = Date.now();
function phase(label: string): void {
  if (verbose) console.log(`[host +${String(((Date.now() - started) / 1000).toFixed(1))}s] ${label}`);
}

/** 跑一个命令，失败时抛出带 stderr 的错误。 */
function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((ok, bad) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk); });
    child.on('error', bad);
    child.on('exit', (code) => {
      if (code === 0) ok(stdout);
      else bad(new Error(`${command} ${args.join(' ')} exited ${String(code)}\n${stderr}`));
    });
  });
}

/**
 * 清理上一次被强行中断留下的进程与目录。
 * （e2e 自身被杀时 finally 不会执行，残留会累积）
 */
export function sweepLeftovers(): void {
  const tmp = tmpdir();
  for (const name of readdirSync(tmp)) {
    if (name.startsWith(PREFIX)) rmSync(join(tmp, name), { recursive: true, force: true });
  }
}

/** 等宿主打印带 token 的 URL。 */
async function waitForUrl(child: ChildProcess, timeoutMs: number): Promise<string> {
  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => { buffer += String(chunk); });
  child.stderr?.on('data', (chunk: Buffer) => { buffer += String(chunk); });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = /(http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/u.exec(buffer);
    if (match !== null) return match[1] as string;
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(`dsh did not print a web url within ${String(timeoutMs)}ms\n${buffer.slice(-2000)}`);
}

/**
 * 起一个隔离宿主。
 * @param options.allowlist - 初始白名单（默认假号码）。
 * @returns 句柄；调用方必须在 afterAll 里 stop()。
 */
export async function startHost(options: { allowlist?: readonly string[] } = {}): Promise<HostRun> {
  sweepLeftovers();
  const work = mkdtempSync(join(tmpdir(), PREFIX));
  const home = join(work, 'home');
  const data = join(work, 'data');
  mkdirSync(home, { recursive: true });
  mkdirSync(data, { recursive: true });
  const patchPath = join(home, 'profiles', PROFILE, 'cordis.patch.yml');
  const env = { ...process.env, DSH_HOME: home, DSH_IMESSAGE_HOME: data };

  // 建 profile → 装本地构建的插件 → 写配置
  phase('creating profile');
  await run('dsh', ['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'], env);
  phase('installing plugin bundle');
  await run('dsh', ['plugin', '--profile', PROFILE, 'add', ROOT], env);
  phase('writing patch');
  const allowlist = options.allowlist ?? ['+8613800000000'];
  writeFileSync(patchPath, [
    '# e2e 临时 patch（每次运行重建，结束后整个 DSH_HOME 删除）',
    `- id: ${ENTRY_ID}`,
    '  config:',
    '    locale: zh',
    '    allowlist:',
    ...allowlist.map((entry) => `      - '${entry}'`),
    '    intervalMs: 2000',
    '    maxBackoffMs: 60000',
    '',
  ].join('\n'), 'utf8');

  // detached：拿到独立进程组，收尾时整组杀掉（pnpm/dsh 会派生孙进程）
  const child = spawn('dsh', ['--profile', PROFILE, '--no-open', '--port', '0'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const url = await waitForUrl(child, 90_000);
  phase('host ready');

  let stopped = false;
  return {
    url,
    home,
    data,
    patchPath,
    readLog() {
      const dir = join(data, 'logs');
      if (!existsSync(dir)) return [];
      const rows: LogRow[] = [];
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.jsonl')) continue;
        for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
          if (line.trim() !== '') rows.push(JSON.parse(line) as LogRow);
        }
      }
      return rows.sort((a, b) => a.ts - b.ts);
    },
    readPatch() {
      return existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      const pid = child.pid;
      if (pid !== undefined) {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch { /* 已退出 */ }
        await new Promise<void>((done) => {
          const timer = setTimeout(() => {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch { /* 已退出 */ }
            done();
          }, 5000);
          child.once('exit', () => {
            clearTimeout(timer);
            done();
          });
        });
      }
      phase('host stopped, removing temp dir');
      rmSync(work, { recursive: true, force: true });
      if (existsSync(work)) throw new Error(`e2e cleanup failed: ${work} still exists`);
    },
  };
}
