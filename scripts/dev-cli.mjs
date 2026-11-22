#!/usr/bin/env node
// dev-only 手工验证 CLI（不进 npm 包）。M2 各步骤逐步补子命令。
//
// 用法：node scripts/dev-cli.mjs <command>
//   probe   环境与权限探测（FDA + Messages 自动化）
//   peek   读真库最新若干条（只读，验证 schema 探测 + JOIN + WAL 实时性）
//   send   真机发送：send [--system] <address> <text>（写路径验证）
//   send-file  真机附件发送：send-file <address> <path>（M6.2 语法与 macOS 版本门手验）
//   listen  实时轮询全链路：poll → typedstream → normalize → 打印
//          listen [--replay N]   默认从当前水位起；--replay N 回放最近 N 行

import { defaultChatDbPath, probeEnvironment } from '../lib/core.js';
import { fetchBatch, normalizeRows, openChatDb, readMaxRowId } from '../lib/core.js';
import { makeSender } from '../lib/core.js';

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
} else if (cmd === 'send') {
  const args = process.argv.slice(3);
  const system = args.includes('--system'); // 位置无关：任意位置识别
  const rest = args.filter((a) => a !== '--system');
  const address = rest.shift();
  const text = rest.join(' ');
  if (!address || !text) {
    console.log('usage: send [--system] <address> <text>');
    process.exitCode = 1;
  } else {
    const sender = makeSender();
    try {
      if (system) await sender.sendSystem(address, text);
      else await sender.sendText(address, text);
      console.log(`已发送 → ${address}`);
    } catch (err) {
      console.log(`发送失败：${err.message}`);
      process.exitCode = 1;
    }
  }
} else if (cmd === 'send-file') {
  const [address, path] = process.argv.slice(3);
  if (!address || !path) {
    console.log('usage: send-file <address> <absolute-file-path>');
    process.exitCode = 1;
  } else {
    const sender = makeSender();
    try {
      await sender.sendFile(address, path);
      // send 返回 ≠ 已投递：Messages daemon 异步摄取，暂存纪律见 outbound.ts
      console.log(`send 已受理 → ${address}（${path}）`);
    } catch (err) {
      console.log(`发送失败：${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }
} else if (cmd === 'listen') {
  const replayIdx = process.argv.indexOf('--replay');
  const replay = replayIdx >= 0 ? Number(process.argv[replayIdx + 1] ?? 20) : undefined;
  const db = openChatDb(defaultChatDbPath());
  const max = readMaxRowId(db) ?? 0;
  let cursor = replay !== undefined ? Math.max(0, max - replay) : max;
  console.log(`listen 起始水位 = ${cursor}${replay !== undefined ? `（回放最近 ${replay} 行）` : '（只看新消息）'}，每 2s 轮询，Ctrl-C 退出`);
  let running = true;
  process.on('SIGINT', () => {
    running = false;
  });
  try {
    while (running) {
      const rows = fetchBatch(db, cursor, 50);
      if (rows.length > 0) {
        for (const r of normalizeRows(rows)) {
          if (r.status === 'accepted') {
            const ts = new Date(r.message.date).toLocaleTimeString('zh-CN');
            console.log(`  ✓ ${ts} ${r.message.conversationKey}: ${r.message.text.slice(0, 60)}`);
          } else {
            console.log(`  - #${r.rowId} 跳过（${r.reason}）`);
          }
        }
        // cursor 推进覆盖所有拉出的原始行（含被过滤的）——与 M3 定案同语义
        cursor = rows[rows.length - 1].rowid;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } finally {
    db.close();
    console.log('已停止');
  }
} else {
  console.log('usage: node scripts/dev-cli.mjs <probe|peek|send|listen> [args]');
  process.exitCode = cmd === 'help' ? 0 : 1;
}

function fmt(status) {
  return status.ok ? 'OK' : `FAIL — ${status.detail}`;
}
