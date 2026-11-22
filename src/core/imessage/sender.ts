// osascript 发送层：控制 Messages.app 把文本发给指定地址。
//
// 实测定案（2026-11 本机 osascript 实测）：
// - AppleScript 字符串字面量解释 \\ \" \\n \\t 转义（JSON.stringify 的子集），
//   但不认 \\uXXXX——控制字符不能用 JSON 转义，防御性替换为空格；
// - 按 buddy（手机号）+ service 枚举定位发送（dsh-im 验证过的路径）：
//   `every service whose service type = iMessage` 取第一个，不依赖 service 名；
// - 权限拒绝的 stderr 特征：/not authorized|(-1743)/i。
//
// 双路径（PLAN 定案）：
// - sendText：AI 拟人路径，humanize 编排分段后逐段调用，原样发送；
// - sendSystem：系统路径，无延迟一次发出，自动加 [dsh] 前缀
//   （与 normalize 的回环过滤共用同一常量，单一事实来源）。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { DSH_PREFIX } from './normalize';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 错误分类
// ---------------------------------------------------------------------------

export type SendFailureKind =
  | 'automation-permission' // TCC 拒绝（stderr -1743 / not authorized）
  | 'no-imessage-service' // 本机未登录 iMessage
  | 'send-failed'; // 其余失败（网络/账号等）

export class SendError extends Error {
  constructor(
    readonly kind: SendFailureKind,
    readonly address: string,
    readonly cause?: unknown,
  ) {
    super(`send to ${address} failed (${kind})`);
    this.name = 'SendError';
  }
}

// ---------------------------------------------------------------------------
// AppleScript 构造与转义
// ---------------------------------------------------------------------------

/** AppleScript 字符串字面量（含引号）。只转义实测验证过的形式，
 *  其余控制字符替换为空格（AppleScript 不认 \\uXXXX）。 */
export function escapeAppleScriptString(text: string): string {
  const escaped = text.replace(/[\\"\n\r\t]/g, (ch) => {
    switch (ch) {
      case '\\':
        return '\\\\';
      case '"':
        return '\\"';
      case '\n':
      case '\r':
        return '\\n';
      case '\t':
        return '\\t';
      default:
        return ch;
    }
  });
  // 剩余控制字符（≤ U+001F 及 U+007F）防御性替换为空格：
  // AppleScript 不认 \uXXXX 转义，也不能让控制字字符进 AppleScript 源码
  let safe = '';
  for (const ch of escaped) {
    const c = ch.codePointAt(0)!;
    safe += c <= 0x1f || c === 0x7f ? ' ' : ch;
  }
  return `"${safe}"`;
}

/** 组装发送脚本：service 枚举 → buddy 定位 → send。 */
export function buildSendScript(address: string, text: string): string {
  return `tell application "Messages"
  set serviceList to every service whose service type = iMessage
  if (count of serviceList) is 0 then error "No iMessage service is available"
  set targetService to item 1 of serviceList
  set targetBuddy to buddy ${escapeAppleScriptString(address)} of targetService
  send ${escapeAppleScriptString(text)} to targetBuddy
end tell`;
}

/** 组装附件发送脚本（send POSIX file；实测 macOS 15.7.3 起可用，无需版本门）。 */
export function buildSendFileScript(address: string, path: string): string {
  return `tell application "Messages"
  set serviceList to every service whose service type = iMessage
  if (count of serviceList) is 0 then error "No iMessage service is available"
  set targetService to item 1 of serviceList
  set targetBuddy to buddy ${escapeAppleScriptString(address)} of targetService
  send POSIX file ${escapeAppleScriptString(path)} to targetBuddy
end tell`;
}

// ---------------------------------------------------------------------------
// 发送器
// ---------------------------------------------------------------------------

/** 执行依赖（默认 node:child_process；测试注入 fake）。 */
export interface SenderDeps {
  readonly runOsascript: (source: string) => Promise<void>;
}

export const nodeSenderDeps: SenderDeps = {
  async runOsascript(source) {
    await execFileAsync('osascript', ['-e', source]);
  },
};

export interface ImessageSender {
  /** AI 拟人路径：原样发送（分段/延迟由 humanize 编排）。 */
  sendText(address: string, text: string): Promise<void>;
  /** 系统路径：加 [dsh] 前缀一次发出。 */
  sendSystem(address: string, text: string): Promise<void>;
  /** 附件发送：osascript send POSIX file（暂存文件路径，M6.2）。 */
  sendFile(address: string, path: string): Promise<void>;
}

/** 校验地址（借 dsh-im 边界：非空、无换行、≤512）。 */
function assertAddress(address: string): void {
  if (!address || address.length > 512 || /[\r\n]/.test(address)) {
    throw new TypeError(`invalid iMessage address: ${JSON.stringify(address)}`);
  }
}

/** 校验文本：非空（trim 后）。 */
function assertText(text: string): void {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new TypeError('iMessage text is required');
  }
}

/** 校验附件路径：绝对路径（POSIX file 要求）、无换行、长度上限。 */
function assertFilePath(path: string): void {
  if (!path.startsWith('/') || path.length > 2048 || /[\r\n]/.test(path)) {
    throw new TypeError(`invalid outbound file path: ${JSON.stringify(path)}`);
  }
}

/** 把执行错误归类为 SendError。 */
function classify(err: unknown, address: string): SendError {
  const stderr = String((err as { stderr?: unknown })?.stderr ?? (err as Error)?.message ?? err);
  if (/not authorized|(-1743)/i.test(stderr)) {
    return new SendError('automation-permission', address, err);
  }
  if (/No iMessage service is available/.test(stderr)) {
    return new SendError('no-imessage-service', address, err);
  }
  return new SendError('send-failed', address, err);
}

/** 创建发送器。 */
export function makeSender(deps: SenderDeps = nodeSenderDeps): ImessageSender {
  const dispatch = async (address: string, text: string): Promise<void> => {
    assertAddress(address);
    assertText(text);
    try {
      await deps.runOsascript(buildSendScript(address, text));
    } catch (err) {
      throw classify(err, address);
    }
  };
  return {
    sendText: (address, text) => dispatch(address, text),
    sendSystem: (address, text) => dispatch(address, `${DSH_PREFIX} ${text}`),
    async sendFile(address, path) {
      assertAddress(address);
      assertFilePath(path);
      try {
        await deps.runOsascript(buildSendFileScript(address, path));
      } catch (err) {
        throw classify(err, address);
      }
    },
  };
}
