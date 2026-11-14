#!/usr/bin/env node
// 从 CHANGELOG.md 抽出某版本的正文，作为 GitHub Release 的说明。
//
// 目的：CHANGELOG 是手写的项目叙事，Release 页直接复用它，免得
// 同一件事写两遍、两处说法还不一致。
//
// 用法：node scripts/release-notes.mjs <version> [--root <dir>] [--out <file>]

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractChangelogSection } from './lib/release.mjs';

const USAGE = 'Usage: node scripts/release-notes.mjs <version> [--root <dir>] [--out <file>]';

function parseArgs(argv) {
  const positional = [];
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let out = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root' || argv[i] === '--out') {
      const flag = argv[i];
      const value = argv[i + 1];
      if (!value) throw new Error(`${flag} requires a value.\n${USAGE}`);
      if (flag === '--root') root = resolve(value);
      else out = resolve(value);
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, root, out };
}

function main() {
  const { positional, root, out } = parseArgs(process.argv.slice(2));
  const version = positional[0];
  if (!version) throw new Error(`Missing version argument.\n${USAGE}`);
  if (positional.length > 1) throw new Error(`Unexpected argument "${positional[1]}".\n${USAGE}`);

  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const notes = extractChangelogSection(changelog, version);

  if (out) {
    writeFileSync(out, `${notes}\n`, 'utf8');
    return;
  }
  process.stdout.write(`${notes}\n`);
}

try {
  main();
} catch (error) {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
