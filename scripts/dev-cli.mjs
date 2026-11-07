#!/usr/bin/env node
// dev-only 手工验证 CLI（不进 npm 包）。M2 各步骤逐步补子命令。
//
// 用法：node scripts/dev-cli.mjs <command>
//   probe   环境与权限探测（FDA + Messages 自动化）

import { defaultChatDbPath, probeEnvironment } from '../lib/core.js';

const cmd = process.argv[2] ?? 'help';

if (cmd === 'probe') {
  const probe = probeEnvironment(defaultChatDbPath());
  console.log(`chat.db: ${probe.chatDbPath}`);
  console.log(`disk (FDA):            ${fmt(probe.disk)}`);
  console.log(`automation (Messages): ${fmt(probe.automation)}`);
  process.exitCode = probe.disk.ok && probe.automation.ok ? 0 : 1;
} else {
  console.log('usage: node scripts/dev-cli.mjs <probe>');
  process.exitCode = cmd === 'help' ? 0 : 1;
}

function fmt(status) {
  return status.ok ? 'OK' : `FAIL — ${status.detail}`;
}
