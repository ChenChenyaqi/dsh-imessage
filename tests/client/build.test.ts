// 客户端产物格式契约（Step 0 探针）。
//
// DSH 的浏览器半身不是普通 ESM：产物必须是 closure-factory 形态
// `window.__ModuleLoader__.load({ id, factory })`，外部依赖（react 等）
// 由注入的 require 从宿主模块表解析，绝不能打进包里。这里从两个角度
// 钉死：纯函数包装器的形态，以及真实 esbuild 产物能被 materialize。

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  PLATFORM_EXTERNALS,
  buildClientBundle,
  wrapClientFactory,
} from '../../scripts/lib/client-bundle.mjs';

const require_ = createRequire(import.meta.url);
const tempRoots: string[] = [];
afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

/** 平台模块表桩：react 用真包，primitives 用最小桩（它是浏览器包，node 直载带 CSS）。 */
const PLATFORM_TABLE: Record<string, unknown> = {
  react: require_('react'),
  'react/jsx-runtime': require_('react/jsx-runtime'),
  '@deepseek-ai/dsh-client-ui-primitives': {
    Button: () => null,
  },
};

interface LoadedRow {
  readonly id: string;
  readonly factory: (req: (spec: string) => unknown) => Record<string, unknown>;
}

/** 在假 window 上执行产物，捕获注册的 factory。 */
function materialize(wrapped: string): { row: LoadedRow; exports: Record<string, unknown> } {
  const rows: LoadedRow[] = [];
  const fakeWindow = { __ModuleLoader__: { load: (row: LoadedRow) => rows.push(row) } };
  new Function('window', wrapped)(fakeWindow);
  expect(rows).toHaveLength(1);
  const row = rows[0] as LoadedRow;
  const requested: string[] = [];
  const exports = row.factory((spec) => {
    requested.push(spec);
    // 未登记的模块必须炸（对齐宿主 loader 的 loud 失败语义）
    if (!(spec in PLATFORM_TABLE)) throw new Error(`unexpected module: ${spec}`);
    return PLATFORM_TABLE[spec];
  });
  return { row, exports };
}

describe('client bundle · wrapper', () => {
  it('emits a module-loader registration with the package id', () => {
    const wrapped = wrapClientFactory({ id: '@chenyaqi/dsh-imessage', code: 'exports.probe = 1;' });

    expect(wrapped).toContain('__ModuleLoader__');
    expect(wrapped).toContain('load(');
    expect(wrapped).toContain('@chenyaqi/dsh-imessage');
  });

  it('returns the CJS exports from the factory', () => {
    const wrapped = wrapClientFactory({ id: 'x', code: 'exports.value = 42;' });

    const { exports } = materialize(wrapped);

    expect(exports).toEqual({ value: 42 });
  });

  it('hands the injected require to the module body', () => {
    const wrapped = wrapClientFactory({ id: 'x', code: 'exports.react = require("react");' });

    const { exports } = materialize(wrapped);

    expect(exports['react']).toBe(PLATFORM_TABLE['react']);
  });
});

describe('client bundle · build', () => {
  const root = join(__dirname, '..', '..');

  it('builds the real client entry into a materializable factory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'client-bundle-'));
    tempRoots.push(dir);
    const outfile = join(dir, 'client.js');

    await buildClientBundle({ root, outfile });

    const { row, exports } = materialize(readFileSync(outfile, 'utf8'));
    // 客户端入口必须提供 cordis 插件形状：apply + inject
    expect(typeof exports['apply']).toBe('function');
    expect(Array.isArray(exports['inject'])).toBe(true);
    expect(row.id).toBe('@chenyaqi/dsh-imessage');
  });

  it('externalizes platform modules instead of bundling them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'client-bundle-'));
    tempRoots.push(dir);
    const outfile = join(dir, 'client.js');

    await buildClientBundle({ root, outfile });
    const code = readFileSync(outfile, 'utf8');

    // 平台模块必须走注入的 require（共享实例），不能打进产物
    expect(code).toContain('require("react/jsx-runtime")');
    expect(code).toContain('require("@deepseek-ai/dsh-client-ui-primitives")');
    expect(code).not.toContain('react-dom');
    for (const spec of PLATFORM_EXTERNALS) expect(code).not.toContain(`node_modules/${spec}`);
    // 产物里出现的每一个 require 目标都必须是平台表内的模块
    const required = [...code.matchAll(/require\("([^"]+)"\)/gu)].map((match) => match[1]);
    expect(required.length).toBeGreaterThan(0);
    for (const spec of required) expect(PLATFORM_EXTERNALS).toContain(spec);
  });

  it('never pulls node builtins into the browser bundle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'client-bundle-'));
    tempRoots.push(dir);
    const outfile = join(dir, 'client.js');

    // platform: 'browser' 会让 node 内置模块在编译期直接失败
    await buildClientBundle({ root, outfile });
    const code = readFileSync(outfile, 'utf8');

    expect(code).not.toMatch(/require\("node:/u);
    expect(code).not.toMatch(/\bfrom\s+"node:/u);
  });
});
