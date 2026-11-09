// Fake ImessageSender：捕获发送 + 分阶段故障注入（pipeline 测试用）。
// humanize 不进 pipeline 测试（有自己的单测），这里直发即达，
// 专注验证 pipeline 的时序与状态机。

import { type ImessageSender, SendError } from '@/core/imessage/sender';

export interface SentCall {
  readonly kind: 'text' | 'system';
  readonly address: string;
  readonly text: string;
}

export interface FakeSender extends ImessageSender {
  readonly sent: SentCall[];
  /** 注入：第 n 次（0 基）sendText 调用抛出（n 越界不生效）。 */
  failTextAt(index: number, err: Error): void;
  /** 注入：下一次 sendSystem 抛出（一次性）。 */
  failNextSystem(err: Error): void;
}

export function makeFakeSender(): FakeSender {
  const sent: SentCall[] = [];
  let failText: { index: number; err: Error } | null = null;
  let failSystem: Error | null = null;

  const maybeFail = (isText: boolean) => {
    if (isText && failText && failText.index === sent.length) {
      const { err } = failText;
      failText = null;
      throw err;
    }
    if (!isText && failSystem) {
      const err = failSystem;
      failSystem = null;
      throw err;
    }
  };

  return {
    sent,
    failTextAt(index, err) {
      failText = { index, err };
    },
    failNextSystem(err) {
      failSystem = err;
    },
    async sendText(address, text) {
      maybeFail(true);
      sent.push({ kind: 'text', address, text });
    },
    async sendSystem(address, text) {
      maybeFail(false);
      sent.push({ kind: 'system', address, text });
    },
  };
}

/** 权限类发送错误（stderr -1743 同款分类）。 */
export function permissionError(): SendError {
  return new SendError(
    'automation-permission',
    '+8613800000000',
    new Error('execution error: Not authorized (-1743)'),
  );
}
