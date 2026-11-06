import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(root, 'lib/index.js');

await mkdir(dirname(outfile), { recursive: true });
await build({
  entryPoints: [resolve(root, 'src/host/index.ts')],
  tsconfig: resolve(root, 'tsconfig.json'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  outfile,
  sourcemap: true,
});

console.log(`Wrote ${outfile}`);
