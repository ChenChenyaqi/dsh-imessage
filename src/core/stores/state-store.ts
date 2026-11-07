// state.json 的加载与落盘（ChannelState 契约见 types/state.ts）。
//
// 损坏恢复策略：state.json 损坏 / 形状不符 / 版本不认识时，
// 把坏文件改名留档（.corrupt-<时间戳>，供人工排查）并返回初始状态。
// 代价分析（损坏概率被原子写压到极低，兜底路径求可用性）：
// - cursor 归 null → 从当前水位重新起步，不回放历史、不重复回复；
// - sessions 丢失 → 绑定重建（DSH 会话都还在，工作区目录都还在磁盘上）。

import { renameSync } from 'node:fs';

import { JsonCorruptError, readJson, writeJsonAtomic } from './atomic';
import {
  isChannelState,
  makeChannelState,
  STATE_VERSION,
  type ChannelState,
} from '../types/state';

/** 读不认识的 state.json：留档改名后返回初始状态（可用性优先）。 */
function quarantineAndReset(stateFile: string): ChannelState {
  try {
    renameSync(stateFile, `${stateFile}.corrupt-${Date.now().toString(36)}`);
  } catch {
    // 留档失败也不阻塞：继续返回初始状态
  }
  return makeChannelState();
}

/**
 * 加载通道状态。
 * - 文件不存在 → 初始状态（全新数据根）；
 * - 损坏 / 形状不符 / version 不符 → 留档重置（未来版本迁移也挂在这）；
 * - 正常 → 原样返回。
 */
export function loadState(stateFile: string): ChannelState {
  let raw: unknown;
  try {
    raw = readJson(stateFile);
  } catch (err) {
    if (err instanceof JsonCorruptError) {
      return quarantineAndReset(stateFile);
    }
    throw err; // 权限等其他 IO 错误：交给上层
  }
  if (raw === undefined) return makeChannelState();
  if (!isChannelState(raw) || raw.version !== STATE_VERSION) {
    return quarantineAndReset(stateFile);
  }
  return raw;
}

/** 落盘（原子写）。state 的不可变更新用 types/state.ts 的纯函数完成。 */
export function saveState(stateFile: string, state: ChannelState): void {
  writeJsonAtomic(stateFile, state);
}
