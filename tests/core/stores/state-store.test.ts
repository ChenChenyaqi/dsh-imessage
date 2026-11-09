import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { asSessionId } from '@/core/types/dsh';
import { describe, expect, it } from 'vitest';

import { loadState, saveState } from '@/core/stores/state-store';
import {
  makeChannelState,
  recordBinding,
  STATE_VERSION,
} from '@/core/types/state';

function tempStateFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-imessage-state-'));
  return { dir, file: join(dir, 'state.json') };
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function quarantined(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.includes('.corrupt-'));
}

describe('loadState · fresh environment', () => {
  it('returns the initial state when no file exists', () => {
    const { dir, file } = tempStateFile();
    try {
      const state = loadState(file);
      expect(state).toEqual(makeChannelState());
    } finally {
      cleanup(dir);
    }
  });
});

describe('loadState · round-trip', () => {
  it('persists bindings through save then load', () => {
    const { dir, file } = tempStateFile();
    try {
      let state = makeChannelState();
      state = recordBinding(state, '+8613800000000', asSessionId('s1'));
      state = recordBinding(state, '+8613800000000', asSessionId('s2'));
      saveState(file, state);

      const loaded = loadState(file);
      const b = loaded.sessions['+8613800000000']!;
      expect(b.sessionId).toBe('s2');
      expect(b.bindHistory).toEqual(['s1', 's2']);
      expect(b.workspaceDir).toBe('conversations/+8613800000000');
    } finally {
      cleanup(dir);
    }
  });

  it('the newest save wins', () => {
    const { dir, file } = tempStateFile();
    try {
      saveState(file, makeChannelState());
      saveState(file, { ...makeChannelState(), cursor: 99 });
      expect(loadState(file).cursor).toBe(99);
    } finally {
      cleanup(dir);
    }
  });

  it('writes human-readable pretty JSON', () => {
    const { dir, file } = tempStateFile();
    try {
      saveState(file, makeChannelState());
      const text = readFileSync(file, 'utf8');
      expect(text).toContain('\n  ');
    } finally {
      cleanup(dir);
    }
  });
});

describe('loadState · corruption recovery', () => {
  it('quarantines unparsable content and returns initial state', () => {
    const { dir, file } = tempStateFile();
    try {
      writeFileSync(file, '{ broken', 'utf8');
      expect(loadState(file)).toEqual(makeChannelState());
      expect(quarantined(dir)).toHaveLength(1);
      expect(readFileSync(join(dir, quarantined(dir)[0]!), 'utf8')).toBe('{ broken');
    } finally {
      cleanup(dir);
    }
  });

  it('quarantines valid JSON with the wrong shape', () => {
    const { dir, file } = tempStateFile();
    try {
      writeFileSync(file, JSON.stringify({ version: 1, cursor: 'not-a-number' }), 'utf8');
      expect(loadState(file)).toEqual(makeChannelState());
      expect(quarantined(dir)).toHaveLength(1);
    } finally {
      cleanup(dir);
    }
  });

  it('quarantines an unknown future version', () => {
    const { dir, file } = tempStateFile();
    try {
      const future = { ...makeChannelState(), version: STATE_VERSION + 1 };
      writeFileSync(file, JSON.stringify(future), 'utf8');
      expect(loadState(file)).toEqual(makeChannelState());
      expect(quarantined(dir)).toHaveLength(1);
    } finally {
      cleanup(dir);
    }
  });
});
