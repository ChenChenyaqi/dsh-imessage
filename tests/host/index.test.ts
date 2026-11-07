import { describe, expect, it } from 'vitest';

import { PLUGIN_ID } from '@/core/version';
import { apply, inject, name } from '@/host/index';

describe('host plugin entry (skeleton)', () => {
  it('exports the cordis plugin contract', () => {
    expect(name).toBe(PLUGIN_ID);
    expect(inject).toEqual([]);
    expect(typeof apply).toBe('function');
  });

  it('apply() announces itself against a stub context', () => {
    const lines: string[] = [];
    const consoleRef = console.log;
    console.log = (text: unknown) => lines.push(String(text));
    try {
      apply({} as never);
    } finally {
      console.log = consoleRef;
    }
    expect(lines.join('\n')).toContain(PLUGIN_ID);
  });
});
