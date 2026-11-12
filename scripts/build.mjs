import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { buildClientBundle } from './lib/client-bundle.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 双入口：lib/index.js = cordis 插件（host）；lib/core.js = core 公共 API
// （dev CLI 消费，见 scripts/dev-cli.mjs）
await mkdir(resolve(root, 'lib'), { recursive: true });
await build({
  entryPoints: [resolve(root, 'src/host/index.ts')],
  tsconfig: resolve(root, 'tsconfig.json'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  outfile: resolve(root, 'lib/index.js'),
  sourcemap: true,
});

await build({
  entryPoints: [resolve(root, 'src/core/index.ts')],
  tsconfig: resolve(root, 'tsconfig.json'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  outfile: resolve(root, 'lib/core.js'),
  sourcemap: true,
});

// 客户端半身：closure-factory 产物（见 scripts/lib/client-bundle.mjs）
await buildClientBundle({ root, outfile: resolve(root, 'lib/client.js') });

console.log('Wrote lib/index.js, lib/core.js, lib/client.js');
