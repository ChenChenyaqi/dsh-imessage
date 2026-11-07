// DeepSeek Harness 的 cordis 插件入口。
// 目前是骨架 —— 渠道接线在 M4 落地（见 docs/PLAN.md）。
import type { Context } from '@deepseek-ai/cordis';

import { PLUGIN_ID } from '@/core/version';

export const name = PLUGIN_ID;

export const inject: string[] = [];

export function apply(_ctx: Context) {
  // 骨架标记：证明 bundle 能在 DSH 宿主里加载成功。
  console.log(`[${PLUGIN_ID}] plugin loaded (skeleton)`);
}
