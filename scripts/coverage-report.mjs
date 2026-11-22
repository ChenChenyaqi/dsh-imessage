#!/usr/bin/env node
// AI 补测任务清单生成器：跑 coverage（istanbul JSON）→ 提取未覆盖
// 分支/函数 → 输出紧凑清单（文件:行 + 源码行内容 + 路径计数）。
//
// 用法：pnpm test:report:ai
// 输出形态（可直接整段贴给 AI 补测试）：
//   src/core/router/pipeline.ts:208  [branch path 1/2 never taken]
//     >       try {
//   ...

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const COV_DIR = join(ROOT, 'coverage');

// 1. 跑测试出 JSON 明细（静默，报告输出走本脚本的清单）
console.log('Running tests with coverage (json) ...');
execFileSync('pnpm', ['exec', 'vitest', 'run', '--coverage', '--coverage.reporter=json'], {
  cwd: ROOT,
  stdio: ['ignore', 'ignore', 'inherit'],
});

// 2. 解析 istanbul 明细
const finalPath = join(COV_DIR, 'coverage-final.json');
const data = JSON.parse(readFileSync(finalPath, 'utf8'));

/** 留白标记：真 IO / 死分支等不修（测试文件里应有注释佐证）。 */
const KNOWN_SKIP = [
  { file: 'imessage/env.ts', line: 73, why: 'runAppleScript real osascript IO' },
  { file: 'imessage/sender.ts', line: 61, why: 'unreachable default arm (regex class is exhaustive)' },
  { file: 'imessage/sender.ts', line: 96, why: 'nodeSenderDeps.runOsascript real IO' },
  { file: 'stores/atomic.ts', line: 35, why: 'defensive fallback, unreachable' },
  { file: 'host/dsh-port.ts', line: 81, why: 'default mkdir hits real fs (tests inject no-op)' },
  { file: 'host/channel.ts', line: 113, why: 'default openChatDb hits real chat.db (tests inject memory db)' },
  { file: 'host/channel.ts', line: 123, why: 'default makeSender hits real osascript (tests inject fake)' },
  { file: 'host/channel.ts', line: 279, why: 'default nodeMediaDeps: real fs/sips IO (tests inject fake media loader)' },
  { file: 'host/rpc.ts', line: 126, why: 'defensive fallback: missing host header' },
  { file: 'host/dsh-port.ts', line: 234, why: 'defensive fallback: abort signal without reason' },
  { file: 'host/dsh-port.ts', line: 235, why: 'defensive fallback: malformed turn/end error event' },
  { file: 'core/router/pipeline.ts', line: 121, why: 'defensive: abort always carries a reason' },
  { file: 'core/router/pipeline.ts', line: 127, why: 'defensive: abort always carries a reason' },
  { file: 'core/router/pipeline.ts', line: 190, why: 'defensive: thrown values are Errors' },
  { file: 'core/router/pipeline.ts', line: 197, why: 'defensive: thrown values are Errors' },
  { file: 'core/router/pipeline.ts', line: 221, why: 'defensive: thrown values are Errors' },
  { file: 'host/channel.ts', line: 150, why: 'default node IO: real chatDbPath/probe deps' },
  { file: 'host/channel.ts', line: 175, why: 'default node IO: real openChatDb on machine chat.db' },
  { file: 'host/index.ts', line: 111, why: 'defensive catch: volatile listener throw is host-bounded' },
];

const sections = [];
let totalMissing = 0;

for (const [absPath, cov] of Object.entries(data)) {
  const rel = absPath.replace(ROOT, '');
  const srcLines = readFileSync(absPath, 'utf8').split('\n');
  const items = [];

  // 未覆盖分支：branchMap 的每条 path 计数为 0
  for (const [id, locs] of Object.entries(cov.b ?? {})) {
    locs.forEach((count, pathIdx) => {
      if (count > 0) return;
      const meta = cov.branchMap?.[id];
      const line = meta?.loc?.start?.line ?? meta?.locations?.[pathIdx]?.start?.line;
      if (!line) return;
      items.push({ line, kind: `branch path ${pathIdx + 1}/${locs.length} never taken`, type: 'branch' });
    });
  }
  // 未覆盖函数
  for (const [id, count] of Object.entries(cov.f ?? {})) {
    if (count > 0) continue;
    const meta = cov.fnMap?.[id];
    const line = meta?.loc?.start?.line;
    if (!line) continue;
    items.push({ line, kind: `function "${meta.name}" never called`, type: 'fn' });
  }

  if (items.length === 0) continue;

  // 同一行去重（多 path 合并）、按行排序
  const byLine = new Map();
  for (const it of items) {
    const prev = byLine.get(it.line);
    if (prev) prev.kind = Array.from(new Set([...prev.kind.split(' + '), it.kind])).join(' + ');
    else byLine.set(it.line, it);
  }
  const sorted = [...byLine.values()].sort((a, b) => a.line - b.line);

  const lines = [];
  for (const it of sorted) {
    const known = KNOWN_SKIP.find(
      (k) => rel.endsWith(k.file) && Math.abs(it.line - k.line) <= 2,
    );
    const tag = known ? `  (known leave-blank: ${known.why})` : '';
    const source = (srcLines[it.line - 1] ?? '').trim().slice(0, 90);
    lines.push(`${rel}:${it.line}  [${it.kind}]${tag}\n    > ${source}`);
    if (!known) totalMissing += 1;
  }
  sections.push(`## ${rel}\n\n\`\`\`\n${lines.join('\n')}\n\`\`\``);
}

console.log('\n' + '# AI 补测任务清单（未覆盖分支/函数）\n');
if (sections.length === 0) {
  console.log('All covered. Nothing to do.');
} else {
  console.log(sections.join('\n\n'));
}
console.log(`\n可补项：${totalMissing}（其余为已知留白/不可达，见标记）`);
