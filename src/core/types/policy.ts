// 准入策略：白名单评估（D8：默认拒绝）。
//
// 白名单是唯一准入闸：名单空 = 谁都进不来。评估前自动归一化入参，
// 防止调用方忘记先过 normalizePhone 造成「同一个人时进时不进」。

import { normalizePhone } from './phone';

/** 准入策略。allowlist 是归一化后的键，默认空 = 全拒。 */
export interface AccessPolicy {
  readonly allowlist: readonly string[];
}

/** 单次评估的结论：allow 为 false 时 reason 说明拒绝原因（日志/调试用）。 */
export interface AccessDecision {
  readonly allow: boolean;
  readonly reason: 'allowlisted' | 'not-allowlisted' | 'unparseable-key';
}

/**
 * 从原始配置构造策略。
 *
 * 非法条目（裸号、坏邮箱、位数异常）静默丢弃——它们归一化后本来
 * 也匹配不上任何消息，等价于不在白名单；正常用户走设置页，表单
 * 校验在保存时已把好关。
 */
export function makePolicy(rawAllowlist: readonly string[]): AccessPolicy {
  const allowlist = rawAllowlist
    .map((raw) => normalizePhone(raw))
    .filter((key): key is string => key !== null);
  return Object.freeze({ allowlist });
}

/** 评估一个原始 handle 是否放行。永不抛错，结论总是显式的。 */
export function evaluateAccess(
  policy: AccessPolicy,
  rawKey: string,
): AccessDecision {
  const key = normalizePhone(rawKey);
  if (key === null) return { allow: false, reason: 'unparseable-key' };
  return policy.allowlist.includes(key)
    ? { allow: true, reason: 'allowlisted' }
    : { allow: false, reason: 'not-allowlisted' };
}
