// Cordis plugin entry for DeepSeek Harness.
// Skeleton only — channel wiring lands in M4 (see docs/PLAN.md).
import type { Context } from '@deepseek-ai/cordis';

import { PLUGIN_ID } from '@/core/version';

export const name = PLUGIN_ID;

export const inject: string[] = [];

export function apply(_ctx: Context) {
  // Skeleton marker: proves the bundle loads inside a DSH host.
  console.log(`[${PLUGIN_ID}] plugin loaded (skeleton)`);
}
