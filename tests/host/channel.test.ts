// host/channel.ts 装配层的规格测试（M4 Step 3 · 测试先行）。
//
// startImessageChannel 把 core 全组件（probe → chatdb → gate/router/
// pipeline → sender/humanize → state/log/i18n）与宿主适配层（dsh-port）
// 组装成完整通道。apply(ctx) 只是它的薄壳（ctx → env 映射 + effect 注册
// stop），映射逻辑一行级别，不单独单测。
//
// 规格要点（M4 规划定案）：
// - 权限探测失败 = 不启动轮询，只记状态（避免半瘫状态吞消息：
//   轮询能跑但发送必失败，消息会被 claim 掉却回不出去）
// - openDb/schema 失败 = start-failed（probe 过了但库打不开，单独归因）
// - stop = abort → 等收尾 → 关库；幂等
// - 端到端 happy path：白名单消息 → fake 宿主 ask → 发送 →
//   state 落盘（cursor/seenIds/binding）——组装正确性的集成证据
// - Config schema（schemastery）：默认值与非法值拒绝（D9）

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import type { ImessageSender } from '@/core/imessage/sender';
import type { ProbeDeps } from '@/core/imessage/env';
import type { LogSink } from '@/core/log/jsonl';
import type { Paths } from '@/core/paths';
import { loadState } from '@/core/stores/state-store';
import { Config, inject, name } from '@/host';
import { startImessageChannel } from '@/host/channel';
import { insertIncomingMessage, SCHEMA_SQL } from '../helpers/chatdb-schema';
import { makeFakeDshHost } from '../helpers/fake-dsh-api';
import { makeFakeSender } from '../helpers/fake-sender';

// ---------------------------------------------------------------------------
// 测试环境
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];
afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/** probe 全绿的依赖。 */
const greenProbe: ProbeDeps = {
  statFile: () => true,
  readFileHead: () => undefined,
  runAppleScript: () => undefined,
};

interface EnvOptions {
  probe?: ProbeDeps;
}

function makeEnv(options: EnvOptions = {}) {
  const host = makeFakeDshHost();
  const sender = makeFakeSender();
  const root = mkdtempSync(join(tmpdir(), 'channel-test-'));
  tempRoots.push(root);
  const paths: Paths = {
    root,
    stateFile: join(root, 'state.json'),
    logDir: join(root, 'logs'),
    conversationsDir: join(root, 'conversations'),
  };
  const logLines: Array<Record<string, unknown>> = [];
  const sink: LogSink = (line) => logLines.push(JSON.parse(line) as Record<string, unknown>);
  const openDbCalls = { count: 0 };
  let db: DatabaseSync | undefined;

  const start = () =>
    startImessageChannel(
      { allowlist: ['+8613800000000'], locale: 'zh', intervalMs: 1 },
      {
        services: host.services,
        events: host,
        paths,
        probe: options.probe ?? greenProbe,
        sender: sender as ImessageSender,
        openDb: () => {
          openDbCalls.count += 1;
          db = new DatabaseSync(':memory:');
          db.exec(SCHEMA_SQL);
          return db;
        },
        logSink: sink,
        // 真 sleep（1ms 宏任务）：no-op sleep 会让空转轮询饿死事件循环，
        // stop() 永远排不上队；1ms 间隔已足够快
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
    );

  return {
    host,
    sender,
    paths,
    logLines,
    openDbCalls,
    start,
    /** 启动后插一条新消息（首启水位不回放历史——M3 定案）。 */
    insertAfterStart(text: string, guid: string, handleId = '+8613800000000') {
      if (!db) throw new Error('db not open');
      insertIncomingMessage(db, { rowid: 1, guid, handleId, text });
    },
  };
}

// ---------------------------------------------------------------------------
// probe 门卫与启动失败
// ---------------------------------------------------------------------------

describe('channel · probe gate', () => {
  it('does not open the db or start polling when disk probe fails', async () => {
    const env = makeEnv({ probe: { ...greenProbe, statFile: () => false } });

    const channel = env.start();

    expect(channel.status().phase).toBe('probe-failed');
    expect(env.openDbCalls.count).toBe(0); // 半瘫防线：不碰库不轮询
    expect(env.logLines).toContainEqual(
      expect.objectContaining({ event: 'channel.probe-failed' }),
    );
    await channel.stop(); // 无害
  });

  it('does not start when automation probe fails', async () => {
    const env = makeEnv({
      probe: {
        ...greenProbe,
        runAppleScript: () => {
          throw new Error('-1743');
        },
      },
    });

    const channel = env.start();

    expect(channel.status().phase).toBe('probe-failed');
    await channel.stop();
  });
});

describe('channel · start failure', () => {
  it('reports start-failed when the db cannot be opened after a green probe', async () => {
    const env = makeEnv();
    // probe 过了但库打不开（竞态：探测后库被换走/锁住）
    const channel = startImessageChannel(
      { allowlist: [], locale: 'zh' },
      {
        services: env.host.services,
        events: env.host,
        paths: env.paths,
        probe: greenProbe,
        openDb: () => {
          throw new Error('unable to open database file');
        },
        logSink: () => undefined,
      },
    );

    expect(channel.status().phase).toBe('start-failed');
    expect(channel.status()).toMatchObject({ phase: 'start-failed' });
    await channel.stop();
  });
});

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

describe('channel · lifecycle', () => {
  it('runs on an empty db and stops cleanly', async () => {
    const env = makeEnv();

    const channel = env.start();

    expect(channel.status().phase).toBe('running');
    await channel.stop();

    expect(channel.status()).toMatchObject({ phase: 'stopped', reason: 'aborted' });
  });

  it('stop is idempotent', async () => {
    const env = makeEnv();
    const channel = env.start();

    await channel.stop();
    await expect(channel.stop()).resolves.toBeUndefined();
  });

  it('reflects fetch-exhausted as an unexpected stop with a warning', async () => {
    const env = makeEnv();
    // 首启水位查询正常、批量拉取永远失败的库 → 10 连败 fetch-exhausted
    const real = new DatabaseSync(':memory:');
    real.exec(SCHEMA_SQL);
    const throwingDb = {
      prepare(sql: string) {
        if (/MAX\(ROWID\)/u.test(sql)) return real.prepare(sql);
        throw new Error('database is locked');
      },
      close() {
        real.close();
      },
    } as unknown as DatabaseSync;

    const channel = startImessageChannel(
      { allowlist: [], locale: 'zh' },
      {
        services: env.host.services,
        events: env.host,
        paths: env.paths,
        probe: greenProbe,
        openDb: () => throwingDb,
        logSink: (line) => env.logLines.push(JSON.parse(line) as Record<string, unknown>),
        sleep: async () => undefined, // 退避瞬间过：10 连败在微任务内完成
      },
    );

    await waitFor(() => channel.status().phase === 'stopped', 2000);

    expect(channel.status()).toMatchObject({ phase: 'stopped', reason: 'fetch-exhausted' });
    expect(env.logLines).toContainEqual(
      expect.objectContaining({ event: 'channel.stopped-unexpectedly' }),
    );
  });

  it('converges a pipeline rejection into stopped/fatal with an error log', async () => {
    const env = makeEnv();
    // 首启 cursor-init 的 saveState 在循环 try 外：stateFile 父目录缺失
    // → runPipeline 顶层 reject → channel 归为 fatal（非 abort 场景）
    const brokenPaths: Paths = { ...env.paths, stateFile: '/nonexistent-dir/state.json' };
    const channel = startImessageChannel(
      { allowlist: [], locale: 'zh' },
      {
        services: env.host.services,
        events: env.host,
        paths: brokenPaths,
        probe: greenProbe,
        openDb: () => {
          const db = new DatabaseSync(':memory:');
          db.exec(SCHEMA_SQL);
          return db;
        },
        logSink: (line) => env.logLines.push(JSON.parse(line) as Record<string, unknown>),
      },
    );

    await waitFor(() => channel.status().phase === 'stopped', 2000);

    expect(channel.status()).toMatchObject({ phase: 'stopped', reason: 'fatal' });
    expect(env.logLines).toContainEqual(
      expect.objectContaining({ event: 'channel.fatal' }),
    );
  });
});

// ---------------------------------------------------------------------------
// 端到端
// ---------------------------------------------------------------------------

describe('channel · end-to-end happy path', () => {
  // 15s 预算：humanize 真 sleep（思考 600–1800ms + 打字节奏）+ 轮询节奏
  it('answers an allowlisted message through the fake host and persists state', async () => {
    const env = makeEnv();
    env.host.scriptReply({ text: '在的，请讲' });

    const channel = env.start();
    // 等首启水位落定，再插入"启动后新到"的消息（水位不回放历史——M3 定案）
    await waitFor(
      () => env.logLines.some((l) => l.event === 'pipeline.cursor-initialized'),
      1000,
    );
    env.insertAfterStart('在吗', 'E2E-1');

    // humanize 真 sleep（思考 600–1800ms + 打字节奏），预算放宽
    await waitFor(() => env.sender.sent.length > 0, 12_000);
    await channel.stop();

    // 发送走 AI 路径（humanize 单气泡），内容是 fake 宿主的回复
    expect(env.sender.sent[0]).toMatchObject({
      kind: 'text',
      address: '+8613800000000',
    });
    expect(env.sender.sent[0]?.text).toContain('在的，请讲');
    // 状态落盘：cursor 覆盖已处理行、seenIds 记账、会话绑定建立
    const state = loadState(env.paths.stateFile);
    expect(state.cursor).toBeGreaterThanOrEqual(1);
    expect(state.seenIds).toContain('E2E-1');
    expect(state.sessions['+8613800000000']?.sessionId).toMatch(/^imessage-/u);
  }, 15_000);

  it('skips non-allowlisted messages but still advances the cursor', async () => {
    const env = makeEnv();

    const channel = env.start();
    await waitFor(
      () => env.logLines.some((l) => l.event === 'pipeline.cursor-initialized'),
      1000,
    );
    env.insertAfterStart('spam', 'E2E-STRANGER', '+8613900000000'); // 不在白名单
    // 等 cursor 推进（拒绝路径静默无日志，以状态为准）
    await waitFor(() => loadState(env.paths.stateFile).cursor === 1, 2000);
    await channel.stop();

    expect(env.sender.sent).toHaveLength(0); // 不发送、不建会话
    const state = loadState(env.paths.stateFile);
    expect(state.cursor).toBe(1); // cursor 仍覆盖（下轮不重拉）
    expect(state.seenIds).not.toContain('E2E-STRANGER'); // 白名单拒绝不 mark
    expect(Object.keys(state.sessions)).toHaveLength(0);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// 插件清单与 Config schema（D9）
// ---------------------------------------------------------------------------

describe('plugin manifest · Config schema', () => {
  it('declares the plugin name and required host services', () => {
    expect(name).toBe('dsh-imessage');
    // 探针事实：这些服务必须 inject 声明才能访问
    expect(inject).toEqual(
      expect.arrayContaining(['agents', 'workspaceRegistry', 'agentDefaultModel', 'sessionTitle']),
    );
  });

  it('fills defaults for an empty config', () => {
    // schemastery 的 ~standard 类型声明含 Promise（实为同步），断言处收窄
    const result = Config['~standard'].validate({}) as { value: Record<string, unknown> };
    expect(result.value).toMatchObject({ locale: 'zh', allowlist: [], intervalMs: 2000 });
  });

  it('rejects a non-positive interval', () => {
    const result = Config['~standard'].validate({ intervalMs: 0 }) as { issues: unknown };
    // Standard Schema 规范：非法值返回 issues（不是 errors）
    expect(result.issues).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** 轮询断言辅助：直到 predicate 为真或超时。 */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
