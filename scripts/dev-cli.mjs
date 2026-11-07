#!/usr/bin/env node
// dev-only 手工验证 CLI（不进 npm 包）。M2 各步骤逐步补子命令。
//
// 用法：node scripts/dev-cli.mjs <command>
//   probe   环境与权限探测（FDA + Messages 自动化）
//   peek   读真库最新若干条（只读，验证 schema 探测 + JOIN + WAL 实时性）

import { defaultChatDbPath, probeEnvironment } from '../lib/core.js';
import { fetchBatch, openChatDb, readMaxRowId } from '../lib/core.js';

const cmd = process.argv[2] ?? 'help';

if (cmd === 'probe') {
  const probe = probeEnvironment(defaultChatDbPath());
  console.log(`chat.db: ${probe.chatDbPath}`);
  console.log(`disk (FDA):            ${fmt(probe.disk)}`);
  console.log(`automation (Messages): ${fmt(probe.automation)}`);
  process.exitCode = probe.disk.ok && probe.automation.ok ? 0 : 1;
} else if (cmd === 'peek') {
  const n = Number(process.argv[3] ?? 10);
  const db = openChatDb(defaultChatDbPath());
  try {
    const max = readMaxRowId(db) ?? 0;
    const rows = fetchBatch(db, Math.max(0, max - n), n + 5); // 多拉几行容 fromMe 被滤
    console.log(`maxRowid=${max}，最近 ${rows.length} 条对方消息：`);
    for (const r of rows.slice(-n)) {
      const ts = new Date(Number(BigInt(r.dateNs) / 1000000n) + 978307200000);
      const body = r.text ?? (r.attributedBody ? `[blob ${r.attributedBody.length}B]` : '[empty]');
      console.log(`  #${r.rowid} ${ts.toLocaleString('zh-CN')} ${r.handleText ?? '?'}: ${body.slice(0, 40)}`);
    }
  } finally {
    db.close();
  }
} else {
  console.log('usage: node scripts/dev-cli.mjs <probe|peek> [args]');
  process.exitCode = cmd === 'help' ? 0 : 1;
}

function fmt(status) {
  return status.ok ? 'OK' : `FAIL — ${status.detail}`;
}
