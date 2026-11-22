import { describe, expect, it } from 'vitest';

import {
  buildSendFileScript,
  buildSendScript,
  escapeAppleScriptString,
  makeSender,
  SendError,
  type SenderDeps,
} from '@/core/imessage/sender';

// ---------------------------------------------------------------------------
// AppleScript 转义（实测验证过的规则：\\ \" \n \t；控制字符→空格）
// ---------------------------------------------------------------------------

describe('escapeAppleScriptString', () => {
  it('wraps plain text in quotes', () => {
    expect(escapeAppleScriptString('hello')).toBe('"hello"');
  });

  it('escapes backslashes and double quotes', () => {
    expect(escapeAppleScriptString('a\\b')).toBe('"a\\\\b"');
    expect(escapeAppleScriptString('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('escapes newlines, CR and tabs', () => {
    expect(escapeAppleScriptString('a\nb')).toBe('"a\\nb"');
    expect(escapeAppleScriptString('a\rb')).toBe('"a\\nb"');
    expect(escapeAppleScriptString('a\tb')).toBe('"a\\tb"');
  });

  it('replaces remaining control characters with spaces (no \\u escapes)', () => {
    expect(escapeAppleScriptString('a\x00\x01b')).toBe('"a  b"');
  });

  it('keeps CJK and emoji verbatim', () => {
    expect(escapeAppleScriptString('中文 🌍')).toBe('"中文 🌍"');
  });
});

// ---------------------------------------------------------------------------
// 脚本构造
// ---------------------------------------------------------------------------

describe('buildSendScript', () => {
  it('locates the buddy by address over the first iMessage service', () => {
    const script = buildSendScript('+8613800000000', 'hi');
    expect(script).toContain('every service whose service type = iMessage');
    expect(script).toContain('No iMessage service is available');
    expect(script).toContain('buddy "+8613800000000" of targetService');
    expect(script).toContain('send "hi" to targetBuddy');
  });

  it('escapes both address and text inside the script', () => {
    const script = buildSendScript('+8613800000000', 'he said "ok"\nline2');
    expect(script).toContain('send "he said \\"ok\\"\\nline2" to targetBuddy');
  });

  it('builds the file variant with POSIX file (M6.2)', () => {
    const script = buildSendFileScript('+8613800000000', '/var/folders/x/abc.png');
    expect(script).toContain('send POSIX file "/var/folders/x/abc.png" to targetBuddy');
  });

  it('escapes the staged path inside the file variant', () => {
    const script = buildSendFileScript('+8613800000000', '/tmp/a "quoted".png');
    expect(script).toContain('send POSIX file "/tmp/a \\"quoted\\".png" to targetBuddy');
  });
});

// ---------------------------------------------------------------------------
// 发送器（fake osascript）
// ---------------------------------------------------------------------------

interface Captured {
  sources: string[];
  failWith?: (source: string) => Error;
}

function makeDeps(captured: Captured): SenderDeps {
  return {
    runOsascript: async (source) => {
      captured.sources.push(source);
      if (captured.failWith) throw captured.failWith(source);
    },
  };
}

describe('makeSender · dispatch', () => {
  it('sends text verbatim (AI path)', async () => {
    const captured: Captured = { sources: [] };
    const sender = makeSender(makeDeps(captured));
    await sender.sendText('+8613800000000', '普通回复');
    expect(captured.sources).toHaveLength(1);
    expect(captured.sources[0]).toContain('send "普通回复"');
  });

  it('sends system messages with the [dsh] prefix', async () => {
    const captured: Captured = { sources: [] };
    const sender = makeSender(makeDeps(captured));
    await sender.sendSystem('+8613800000000', '会话已归档');
    expect(captured.sources[0]).toContain('send "[dsh] 会话已归档"');
  });

  it('rejects empty or whitespace-only text', async () => {
    const captured: Captured = { sources: [] };
    const sender = makeSender(makeDeps(captured));
    await expect(sender.sendText('+8613800000000', '   ')).rejects.toThrow(TypeError);
    await expect(sender.sendText('+8613800000000', '')).rejects.toThrow(TypeError);
  });

  it('rejects addresses containing newlines or oversized', async () => {
    const captured: Captured = { sources: [] };
    const sender = makeSender(makeDeps(captured));
    await expect(sender.sendText('+8613800000000\nx', 'hi')).rejects.toThrow(TypeError);
    await expect(sender.sendText('x'.repeat(513), 'hi')).rejects.toThrow(TypeError);
  });

  it('sends a staged file through the POSIX file variant', async () => {
    const captured: Captured = { sources: [] };
    const sender = makeSender(makeDeps(captured));
    await sender.sendFile('+8613800000000', '/var/folders/t/dsh-imessage-out-1.png');
    expect(captured.sources[0]).toContain(
      'send POSIX file "/var/folders/t/dsh-imessage-out-1.png" to targetBuddy',
    );
  });

  it('rejects relative or newline-carrying file paths before osascript', async () => {
    const captured: Captured = { sources: [] };
    const sender = makeSender(makeDeps(captured));
    await expect(sender.sendFile('+8613800000000', 'relative/a.png')).rejects.toThrow(TypeError);
    await expect(sender.sendFile('+8613800000000', '/var/folders/a\nb.png')).rejects.toThrow(
      TypeError,
    );
    expect(captured.sources).toHaveLength(0);
  });

  it('classifies file-send failures through the same taxonomy', async () => {
    const captured: Captured = {
      sources: [],
      failWith: () => {
        const e = new Error('command failed') as Error & { stderr?: string };
        e.stderr = 'execution error: Not authorized to send Apple events. (-1743)';
        return e;
      },
    };
    const sender = makeSender(makeDeps(captured));
    await expect(sender.sendFile('+8613800000000', '/var/folders/t/a.png')).rejects.toMatchObject({
      kind: 'automation-permission',
    });
  });
});

describe('makeSender · error classification', () => {
  function errWithStderr(stderr: string): Error {
    const e = new Error('command failed') as Error & { stderr?: string };
    e.stderr = stderr;
    return e;
  }

  it('classifies TCC denial (stderr -1743) as automation-permission', async () => {
    const captured: Captured = {
      sources: [],
      failWith: () =>
        errWithStderr('execution error: Not authorized to send Apple events. (-1743)'),
    };
    const sender = makeSender(makeDeps(captured));
    await expect(sender.sendText('+8613800000000', 'hi')).rejects.toMatchObject({
      name: 'SendError',
      kind: 'automation-permission',
    });
  });

  it('classifies missing service as no-imessage-service', async () => {
    const captured: Captured = {
      sources: [],
      failWith: () => errWithStderr('execution error: No iMessage service is available'),
    };
    const sender = makeSender(makeDeps(captured));
    await expect(sender.sendText('+8613800000000', 'hi')).rejects.toMatchObject({
      kind: 'no-imessage-service',
    });
  });

  it('wraps unknown failures as send-failed SendError with cause', async () => {
    const original = new Error('boom');
    const captured: Captured = { sources: [], failWith: () => original };
    const sender = makeSender(makeDeps(captured));
    const promise = sender.sendText('+8613800000000', 'hi');
    await expect(promise).rejects.toBeInstanceOf(SendError);
    await promise.catch((err: SendError) => {
      expect(err.kind).toBe('send-failed');
      expect(err.cause).toBe(original);
    });
  });
});
