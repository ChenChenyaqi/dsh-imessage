// macOS 环境与权限探测。
//
// 两项独立权限（对应设置页两个卡片，全量探测一次显示所有缺口）：
// - disk：完全磁盘访问（FDA）——读 chat.db 的前提；
// - automation：自动化（控制 Messages.app）——osascript 发送的前提。
//
// 探测依赖全部可注入（默认实现基于 node:fs / node:child_process），
// 测试注入 fake 即可在任意平台跑全分支、CI（linux）可用。
// 注意：默认的 automation 探测在真机首次运行会触发 TCC 授权弹窗
// （预期行为，用户点允许后通过；探测命令用 get name，不依赖账号状态）。
//
// 权限主体（TCC 责任进程）：探测结果只代表**当前宿主环境**的实际能力
// ——dev CLI（终端跑）=终端 app；DSH desktop 揢件=DeepSeek Harness.app；
// CLI/web 形态=启动命令的终端。同一台机器换宿主结果可能不同，
// 揢件环境以 M4 首次真实运行为准。

import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** macOS 默认库路径。 */
export function defaultChatDbPath(): string {
  return join(homedir(), 'Library', 'Messages', 'chat.db');
}

export interface ProbeStatus {
  readonly ok: boolean;
  /** 失败原因（原始错误 message，英文）；成功时为 undefined。 */
  readonly detail?: string;
}

export interface EnvProbe {
  /** 被探测的 chat.db 路径。 */
  readonly chatDbPath: string;
  /** 完全磁盘访问（chat.db 可读）。 */
  readonly disk: ProbeStatus;
  /** Messages.app 自动化可用。 */
  readonly automation: ProbeStatus;
}

/** 探测依赖（默认 node 实现，测试注入 fake）。 */
export interface ProbeDeps {
  /** 路径存在且是普通文件。 */
  readonly statFile: (path: string) => boolean;
  /** 实际读一个字节；读不了（权限/IO）抛错。 */
  readonly readFileHead: (path: string) => void;
  /** 执行 AppleScript；失败（权限拒绝/语法/超时）抛错。 */
  readonly runAppleScript: (source: string) => void;
}

/** Automation 探测命令：取 app 名——不登录、不建会话、不发送。 */
export const AUTOMATION_PROBE_SOURCE = 'tell application "Messages" to get name';

export const nodeProbeDeps: ProbeDeps = {
  statFile(path) {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  readFileHead(path) {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(1);
      readSync(fd, buf, 0, 1, 0);
    } finally {
      closeSync(fd);
    }
  },
  runAppleScript(source) {
    execFileSync('osascript', ['-e', source], { stdio: 'pipe' });
  },
};

/**
 * 全量探测（两项都测、不短路——设置页要一次显示所有缺口）。
 * chat.db 不存在也归入 disk 失败（detail 区分「文件不存在」与「无权读取」，
 * 前者典型于非 macOS 或路径配错）。
 */
export function probeEnvironment(
  chatDbPath: string,
  deps: ProbeDeps = nodeProbeDeps,
): EnvProbe {
  let disk: ProbeStatus;
  if (!deps.statFile(chatDbPath)) {
    disk = { ok: false, detail: `chat.db not found at ${chatDbPath}` };
  } else {
    try {
      deps.readFileHead(chatDbPath);
      disk = { ok: true };
    } catch (err) {
      disk = { ok: false, detail: errorMessage(err) };
    }
  }

  let automation: ProbeStatus;
  try {
    deps.runAppleScript(AUTOMATION_PROBE_SOURCE);
    automation = { ok: true };
  } catch (err) {
    automation = { ok: false, detail: errorMessage(err) };
  }

  return { chatDbPath, disk, automation };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
