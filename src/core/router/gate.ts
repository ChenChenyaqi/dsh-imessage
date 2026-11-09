// gate：每条消息的准入门卫（M3 Step 3）。
//
// 两道检查（先查重后白名单——顺序即语义）：
// 1. 幂等查重：seenIds 里有 guid = 处理过/已认领 → 拒。这是绝对事实，
//    不受白名单增删影响（处理过的就是处理过）；
// 2. 白名单：复用 M1 evaluateAccess（conversationKey 已归一化，重归
//    一化幂等，unparseable 仅防御）。
//
// 查重与标记的时序（claim 语义，配合定案「send 失败不重试」）：
// - markSeen 在「处理前」落盘（claim）——崩溃窗口内宁可吞掉这条
//   （防重复 > 防丢：用户重发成本低，重复回复伤信任）；
// - 仅当 ask 阶段失败（尚未发出任何东西）由 pipeline 调 unmarkSeen
//   恢复下轮重试；send 失败保持 claim，不重试不重复回复。
// - 白名单拒绝的消息不 mark：cursor 已推进不会再拉到，不占 seenIds
//   容量（环形窗口留给「cursor 不推进期间可能重复出现」的场景）。
//
// 本模块全部纯函数；调用时序与落盘节奏归 pipeline（Step 4）。

import { evaluateAccess, type AccessDecision, type AccessPolicy } from '../types/policy';
import type { NormalizedMessage } from '../types/messages';
import { SEEN_IDS_MAX } from '../types/state';

// ---------------------------------------------------------------------------
// 评估（只读）
// ---------------------------------------------------------------------------

export type GateVerdict =
  | { readonly pass: true }
  | {
      readonly pass: false;
      readonly reason: 'already-seen' | 'not-allowlisted' | 'unparseable-key';
    };

/** 评估一条消息是否放行。永不抛错。 */
export function evaluateGate(
  policy: AccessPolicy,
  seenIds: readonly string[],
  message: NormalizedMessage,
): GateVerdict {
  if (seenIds.includes(message.guid)) {
    return { pass: false, reason: 'already-seen' };
  }
  const access = evaluateAccess(policy, message.conversationKey);
  if (access.allow) return { pass: true };
  // allow=false 时 reason 必非 'allowlisted'（类型系统无法表达跨字段约束）
  return { pass: false, reason: access.reason as Exclude<AccessDecision['reason'], 'allowlisted'> };
}

// ---------------------------------------------------------------------------
// seenIds 台账操作（纯函数，返回新数组）
// ---------------------------------------------------------------------------

/** 认领：guid 置顶；超过环形容量淘汰最旧（尾部）。重复认领幂等。 */
export function markSeen(seenIds: readonly string[], guid: string): readonly string[] {
  if (seenIds.includes(guid)) return seenIds;
  return [guid, ...seenIds].slice(0, SEEN_IDS_MAX);
}

/** 释放：移除 guid（ask 失败恢复重试）。不在场则原引用返回（幂等）。 */
export function unmarkSeen(seenIds: readonly string[], guid: string): readonly string[] {
  const idx = seenIds.indexOf(guid);
  if (idx === -1) return seenIds;
  return seenIds.toSpliced(idx, 1);
}
