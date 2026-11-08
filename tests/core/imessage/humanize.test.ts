import { describe, expect, it } from 'vitest';

import {
  computeTypingDelayMs,
  defaultSleep,
  HUMANIZE_DEFAULTS,
  sendHumanized,
  splitReplyParts,
} from '@/core/imessage/humanize';
import type { ImessageSender } from '@/core/imessage/sender';

// ---------------------------------------------------------------------------
// 分段
// ---------------------------------------------------------------------------

describe('splitReplyParts', () => {
  it('splits plain lines into one part per line', () => {
    expect(splitReplyParts('第一行\n第二行\n第三行')).toEqual([
      '第一行',
      '第二行',
      '第三行',
    ]);
  });

  it('drops empty lines and trims each part', () => {
    expect(splitReplyParts('  你好  \n\n\n  在吗 \n')).toEqual(['你好', '在吗']);
  });

  it('keeps fenced code blocks intact as a single part', () => {
    const text = '看代码：\n```js\nconst a = 1;\nconst b = 2;\n```\n跑通了';
    expect(splitReplyParts(text)).toEqual(['看代码：', '```js\nconst a = 1;\nconst b = 2;\n```', '跑通了']);
  });

  it('keeps an unclosed fence intact to the end', () => {
    const text = '开头\n```python\nprint(1)';
    expect(splitReplyParts(text)).toEqual(['开头', '```python\nprint(1)']);
  });

  it('falls back to a single trimmed part for blank-only input', () => {
    expect(splitReplyParts('   \n  \n')).toEqual(['']);
  });
});

// ---------------------------------------------------------------------------
// 延迟计算（注入固定随机源断言精确值）
// ---------------------------------------------------------------------------

describe('computeTypingDelayMs', () => {
  const mid = () => 0.5; // 抖动系数 = 1（中点）

  it('first part waits in the thinking window plus typing time', () => {
    // 4 字文本：首段基础 = rand(600,1800)=1200，打字 = 4/4*1000 = 1000
    // jitter = 1 + rand(-0.25,0.25) = 1 → (1200+1000)*1 = 2200
    expect(computeTypingDelayMs('四字文本', { isFirst: true, random: mid })).toBe(2200);
  });

  it('later parts use the small base delay plus typing time', () => {
    // 非首段：250 + 1000 = 1250，jitter 1 → 1250
    expect(computeTypingDelayMs('四字文本', { random: mid })).toBe(1250);
  });

  it('clamps to maxDelayMs for very long parts', () => {
    const long = '长'.repeat(200); // 250 + 50s → clamp 5000
    expect(computeTypingDelayMs(long, { random: mid })).toBe(HUMANIZE_DEFAULTS.maxDelayMs);
  });

  it('clamps are respected at jitter extremes', () => {
    // '一'（1 字）：base = 250 + 250 = 500；random=0 → jitter = 1 + (-0.25) = 0.75
    // → 500 * 0.75 = 375（未触及下夹）
    expect(computeTypingDelayMs('一', { random: () => 0 })).toBe(375);
  });

  it('treats code blocks as paste with flat short delay', () => {
    // 粘贴：rand(300,800) = 550，jitter 1 → 550；与长度无关
    const code = '```js\n' + 'x'.repeat(500);
    expect(computeTypingDelayMs(code, { random: mid })).toBe(550);
  });

  it('jitter extremes stay within clamp bounds', () => {
    const text = '四字文本';
    const lo = computeTypingDelayMs(text, { random: () => 0 }); // jitter 0.75
    const hi = computeTypingDelayMs(text, { random: () => 1 }); // jitter 1.25
    expect(lo).toBe(Math.round(1250 * 0.75));
    expect(hi).toBe(Math.round(1250 * 1.25));
  });
});

// ---------------------------------------------------------------------------
// 编排（fake sender + 假钟）
// ---------------------------------------------------------------------------

interface SendCall {
  readonly address: string;
  readonly text: string;
}

function makeHarness(failAt?: number) {
  const sends: SendCall[] = [];
  const sleeps: number[] = [];
  const sender: ImessageSender = {
    sendText: async (address, text) => {
      if (failAt !== undefined && sends.length === failAt) {
        throw new Error('send boom');
      }
      sends.push({ address, text });
    },
    sendSystem: async () => {
      throw new Error('humanize must not use the system path');
    },
  };
  return {
    sends,
    sleeps,
    sender,
    deps: {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    },
  };
}

describe('sendHumanized', () => {
  it('sends each part after a delay, first delay reflects thinking time', async () => {
    const h = makeHarness();
    const n = await sendHumanized(h.sender, '+8613800000000', '第一行\n第二行', {
      deps: h.deps,
      random: () => 0.5,
    });
    expect(n).toBe(2);
    expect(h.sends.map((s) => s.text)).toEqual(['第一行', '第二行']);
    expect(h.sends.every((s) => s.address === '+8613800000000')).toBe(true);
    // 首段 '第一行'（3 字）：rand(600,1800)=1200 + 750 打字 = 1950，jitter 1
    // 第二段 '第二行'（3 字）：250 + 750 = 1000，jitter 1
    expect(h.sleeps).toEqual([1950, 1000]);
  });

  it('sends a code block as one part with paste delay', async () => {
    const h = makeHarness();
    await sendHumanized(h.sender, '+861', '看：\n```js\nconst a=1;\n```', {
      deps: h.deps,
      random: () => 0.5,
    });
    expect(h.sends.map((s) => s.text)).toEqual(['看：', '```js\nconst a=1;\n```']);
    expect(h.sleeps[1]).toBe(550); // 粘贴延迟
  });

  it('propagates send failures after earlier parts already went out', async () => {
    const h = makeHarness(1); // 第二段失败
    await expect(
      sendHumanized(h.sender, '+861', '第一行\n第二行\n第三行', { deps: h.deps }),
    ).rejects.toThrow('send boom');
    expect(h.sends.map((s) => s.text)).toEqual(['第一行']); // 第一段已发出
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const h = makeHarness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      sendHumanized(h.sender, '+861', 'hi', {
        deps: h.deps,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(h.sends).toHaveLength(0);
    expect(h.sleeps).toHaveLength(0);
  });
});

describe('defaultSleep', () => {
  it('resolves immediately for non-positive durations', async () => {
    await expect(defaultSleep(0)).resolves.toBeUndefined();
    await expect(defaultSleep(-5)).resolves.toBeUndefined();
  });

  it('rejects when aborted mid-wait', async () => {
    const controller = new AbortController();
    const p = defaultSleep(10_000, controller.signal);
    controller.abort(new Error('stop'));
    await expect(p).rejects.toThrow('stop');
  });
});
