#!/usr/bin/env node
// 发版前置校验：tag、主包、preset 三者版本必须一致。
//
// 放在 npm publish 之前，是因为 npm 的版本号一经发布就永久占用
// （24 小时后连 unpublish 都不行）。宁可让 workflow 停在这里报错，
// 也不要发出去一个版本号对不上的包。
//
// 用法：node scripts/check-release-versions.mjs <tag> [--root <dir>]

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertVersionConsistency } from './lib/release.mjs';

const USAGE = 'Usage: node scripts/check-release-versions.mjs <tag> [--root <dir>]';

function parseArgs(argv) {
  const positional = [];
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') {
      const value = argv[i + 1];
      if (!value) throw new Error(`--root requires a path.\n${USAGE}`);
      root = resolve(value);
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, root };
}

function readVersion(root, relativePath) {
  const raw = readFileSync(join(root, relativePath), 'utf8');
  return JSON.parse(raw).version;
}

function main() {
  const { positional, root } = parseArgs(process.argv.slice(2));
  const tag = positional[0];
  if (!tag) throw new Error(`Missing tag argument.\n${USAGE}`);
  if (positional.length > 1) throw new Error(`Unexpected argument "${positional[1]}".\n${USAGE}`);

  const { version } = assertVersionConsistency({
    tag,
    rootVersion: readVersion(root, 'package.json'),
    presetVersion: readVersion(root, 'preset/package.json'),
  });

  console.log(
    `Release version ${version} verified: tag, root package and preset package agree.`,
  );
}

try {
  main();
} catch (error) {
  // ::error:: 让 GitHub Actions 在 failed step 里显示成错误注解。
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
