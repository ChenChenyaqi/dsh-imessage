// imessage_send_file 交付工具规格（M6.2 Step B）：
// 注册形状 / 老宿主降级 / 执行时路由校验（分叉 2）/ bytes 入队（分叉 3）/
// 50MB 上限（分叉 5）/ queued-not-sent 语义（description 措辞）。

import { describe, expect, it } from 'vitest';

import type { ArtifactCollector } from '@/core/router/artifacts';
import { makeArtifactCollector } from '@/core/router/artifacts';
import type { Logger } from '@/core/log/jsonl';
import type { HostToolDefinition, HostToolsService } from '@/host/dsh-api';
import {
  buildDeliverToolDefinition,
  DELIVER_TOOL_NAME,
  installDeliverTool,
  OUTBOUND_MAX_BYTES,
} from '@/host/deliver-tool';

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

function makeFakeTools() {
  const registered = new Map<string, HostToolDefinition>();
  const unregistered: string[] = [];
  const service: HostToolsService = {
    register(def) {
      registered.set(def.name, def);
      return () => unregistered.push(def.name);
    },
  };
  return { service, registered, unregistered };
}

function makeFakeFs() {
  const files = new Map<string, { data: Uint8Array; size?: number }>([
    ['/ws/report.pdf', { data: new Uint8Array([1, 2, 3]) }],
    ['/ws/empty.png', { data: new Uint8Array(0), size: 0 }],
    ['/ws/huge.bin', { data: new Uint8Array(0), size: OUTBOUND_MAX_BYTES + 1 }],
  ]);
  return {
    deps: {
      readFile: async (path: string) => {
        const f = files.get(path);
        if (!f) throw new Error('ENOENT');
        return f.data;
      },
      stat: async (path: string) => {
        const f = files.get(path);
        if (!f) throw new Error('ENOENT');
        return { size: f.size ?? f.data.length };
      },
    },
    files,
  };
}

const ROUTE = new Map([['session-im-1', '+8613800000000']]);

function makeServices(collector: ArtifactCollector, tools?: HostToolsService) {
  return {
    tools,
    collector,
    conversationKeyOf: (sessionId: string) => ROUTE.get(sessionId),
  };
}

function makeLog() {
  const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const log: Pick<Logger, 'info'> = {
    info: (event, fields) => lines.push({ event, fields: fields as Record<string, unknown> }),
  };
  return { log, lines };
}

const EXEC_IM = { agent: { sessionId: 'session-im-1' } } as const;
const EXEC_WEB = { agent: { sessionId: 'session-web-9' } } as const;
const EXEC_NO_AGENT = {} as const;

// ---------------------------------------------------------------------------
// 注册与降级
// ---------------------------------------------------------------------------

describe('installDeliverTool · registration', () => {
  it('registers under the tool name and uninstalls through the host disposer', () => {
    const tools = makeFakeTools();
    const uninstall = installDeliverTool(
      makeServices(makeArtifactCollector(), tools.service),
      makeFakeFs().deps,
    );
    expect(tools.registered.get(DELIVER_TOOL_NAME)).toBeDefined();
    uninstall();
    expect(tools.unregistered).toEqual([DELIVER_TOOL_NAME]);
  });

  it('returns a no-op disposer when the host has no tools service (old host degrade)', () => {
    const uninstall = installDeliverTool(makeServices(makeArtifactCollector()), makeFakeFs().deps);
    expect(() => uninstall()).not.toThrow();
  });

  it('description carries the queued-not-sent and iMessage-only semantics', () => {
    const tools = makeFakeTools();
    installDeliverTool(makeServices(makeArtifactCollector(), tools.service), makeFakeFs().deps);
    const description = tools.registered.get(DELIVER_TOOL_NAME)!.description;
    expect(description).toContain('queued, not sent');
    expect(description).toContain('do not claim');
    expect(description).toContain('iMessage');
    expect(tools.registered.get(DELIVER_TOOL_NAME)!.parameters).toMatchObject({
      type: 'object',
      required: ['path'],
    });
  });

  it('output.render projects the canonical value into a text block', () => {
    const def = buildDeliverToolDefinition(
      makeServices(makeArtifactCollector()),
      makeFakeFs().deps,
    );
    const blocks = def.output.render({}, { status: 'queued', fileName: 'a.png', bytes: 3 });
    expect(blocks).toEqual([{ type: 'text', text: 'queued: a.png' }]);
    // 兑底：部分 value 也不允许 render 抛（官方契约：render 必须全函数）
    expect(def.output.render({}, {})).toEqual([{ type: 'text', text: 'queued: ' }]);
  });
});

// ---------------------------------------------------------------------------
// 执行：路由校验（分叉 2）
// ---------------------------------------------------------------------------

describe('deliver tool execute · routing guard', () => {
  it('pushes bytes into the collector for a routed iMessage session', async () => {
    const collector = makeArtifactCollector();
    const { log, lines } = makeLog();
    const def = buildDeliverToolDefinition(makeServices(collector), { ...makeFakeFs().deps, log });
    const result = await def.execute({ path: '/ws/report.pdf' }, EXEC_IM);
    expect(result).toEqual({ status: 'queued', fileName: 'report.pdf', bytes: 3 });
    expect(collector.take('session-im-1').map((a) => a.fileName)).toEqual(['report.pdf']);
    expect(lines).toEqual([
      {
        event: 'artifact.queued',
        fields: { sessionId: 'session-im-1', name: 'report.pdf', bytes: 3 },
      },
    ]);
  });

  it('rejects calls without an agent session (non-agent context)', async () => {
    const def = buildDeliverToolDefinition(
      makeServices(makeArtifactCollector()),
      makeFakeFs().deps,
    );
    await expect(def.execute({ path: '/ws/report.pdf' }, EXEC_NO_AGENT)).rejects.toThrow(
      /no active iMessage delivery context/,
    );
  });

  it('rejects web/desktop sessions not in the iMessage route table', async () => {
    const def = buildDeliverToolDefinition(
      makeServices(makeArtifactCollector()),
      makeFakeFs().deps,
    );
    await expect(def.execute({ path: '/ws/report.pdf' }, EXEC_WEB)).rejects.toThrow(
      /no active iMessage delivery context/,
    );
  });
});

// ---------------------------------------------------------------------------
// 执行：参数与文件校验（分叉 3 / 5）
// ---------------------------------------------------------------------------

describe('deliver tool execute · argument and file checks', () => {
  const cases: Array<[name: string, args: unknown, message: RegExp]> = [
    ['relative path', { path: 'ws/report.pdf' }, /absolute file path/],
    ['non-string path', { path: 42 }, /absolute file path/],
    ['missing path', {}, /absolute file path/],
    ['empty file', { path: '/ws/empty.png' }, /file is empty/],
    ['oversized file', { path: '/ws/huge.bin' }, /byte limit/],
    ['missing file', { path: '/ws/nope.bin' }, /ENOENT/],
  ];
  for (const [name, args, message] of cases) {
    it(`rejects ${name}`, async () => {
      const def = buildDeliverToolDefinition(
        makeServices(makeArtifactCollector()),
        makeFakeFs().deps,
      );
      await expect(def.execute(args, EXEC_IM)).rejects.toThrow(message);
    });
  }

  it('keeps bytes verbatim (snapshot semantics: later file edits cannot leak in)', async () => {
    const fs = makeFakeFs();
    const collector = makeArtifactCollector();
    const def = buildDeliverToolDefinition(makeServices(collector), fs.deps);
    await def.execute({ path: '/ws/report.pdf' }, EXEC_IM);
    // 入队后再改磁盘内容，不影响已入队 bytes
    fs.files.set('/ws/report.pdf', { data: new Uint8Array([9, 9]) });
    const [artifact] = collector.take('session-im-1');
    expect([...artifact!.bytes]).toEqual([1, 2, 3]);
  });
});
