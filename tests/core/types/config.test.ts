import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, type PluginConfig } from '@/core/types/config';

describe('DEFAULT_CONFIG', () => {
  it('denies everyone by default (empty allowlist)', () => {
    expect(DEFAULT_CONFIG.allowlist).toEqual([]);
  });

  it('defaults to unchunked replies with a capped-chunking style ready', () => {
    // 默认关闭：整段直发、零等待（拟人分段是显式开启的选项）
    expect(DEFAULT_CONFIG.chunkedReplies).toBe(false);
    expect(DEFAULT_CONFIG.maxChunks).toBe(8);
    expect(DEFAULT_CONFIG.delayFactor).toBe(1);
    // 预设默认未设置：装了 dafeiyu 才默认选中（显式选择永远赢）
    expect(DEFAULT_CONFIG.agentPreset).toBe('');
  });

  it('defaults to zh locale and a 2s poll interval', () => {
    expect(DEFAULT_CONFIG.locale).toBe('zh');
    expect(DEFAULT_CONFIG.pollIntervalMs).toBe(2000);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
  });
});

describe('PluginConfig type shape', () => {
  it('accepts a fully specified config', () => {
    const config: PluginConfig = {
      allowlist: ['+8613800000000'],
      locale: 'en',
      pollIntervalMs: 5000,
      chunkedReplies: true,
      maxChunks: 5,
      delayFactor: 0,
      agentPreset: 'dafeiyu',
    };
    expect(config.allowlist).toHaveLength(1);
  });
});
