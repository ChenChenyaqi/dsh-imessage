// 客户端半身的包清单契约（Step 0 探针的地基之一）。
//
// DSH 的客户端加载器按宿主 entry 解析包根：包要在 package.json 声明
// dsh.client（platform=web）+ exports["./client"]，同一条 entry 才会
// 额外加载一份浏览器半身。这里把这份契约钉死，防止后续改动静默破坏。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string;
  main?: string;
  exports?: Record<string, unknown>;
  dsh?: { bundle?: { patch?: string }; client?: unknown };
};

/** exports["./client"] 的 default 目标（字符串或 {default} 形态都接受）。 */
function clientExportTarget(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (entry !== null && typeof entry === 'object') {
    const target = (entry as { default?: unknown }).default;
    if (typeof target === 'string') return target;
  }
  return undefined;
}

describe('client half · package manifest', () => {
  it('keeps the host entry resolvable through exports', () => {
    // 加 exports 不能打破宿主侧解析（cordis 插件入口）
    const hostTarget = clientExportTarget(pkg.exports?.['.']);
    expect(hostTarget).toBe(pkg.main);
    expect(hostTarget).toBe('./lib/index.js');
  });

  it('exports a ./client bundle for the browser half', () => {
    // 加载器要求 exports["./client"] 存在，否则整包报错
    expect(clientExportTarget(pkg.exports?.['./client'])).toBe('./lib/client.js');
  });

  it('declares dsh.client with the web platform', () => {
    const client = pkg.dsh?.client as { platform?: string; inject?: unknown } | undefined;
    expect(client?.platform).toBe('web');
  });

  it('keeps the bundle patch declaration intact', () => {
    // 双面包额外字段不能挤掉原有的 bundle patch 声明
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml');
  });
});
