import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, type PluginConfig } from '@/core/types/config';

describe('DEFAULT_CONFIG', () => {
  it('denies everyone by default (empty allowlist)', () => {
    expect(DEFAULT_CONFIG.allowlist).toEqual([]);
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
    };
    expect(config.allowlist).toHaveLength(1);
  });
});
