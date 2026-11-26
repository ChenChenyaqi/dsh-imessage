// contacts 域纯函数（M7 α 回退定案：称呼存 Config，基准 = saved.contacts，
// 与 allowlist 同机制——无 RPC、无自有文件）。
//
// 行集 = 白名单草稿的归一化键 ∪ 基准键；dirty = 清洗后的草稿与基准有
// 差异；清洗 = 值 trim + 64 截断 + 空值剔除（空输入框 = 删除称呼）。
// 键域：行键已归一化（行由白名单/基准生成，非手输）；非法白名单草稿行
//（归一化失败）不出行——保存白名单后再出现（同 allowlist 校验哲学）。

import { normalizePhone } from '@/core/types/phone';

/** 称呼草稿（键 → 用户输入；未编辑 = undefined，跟随基准）。 */
export type PeerNamesDraft = Readonly<Record<string, string>>;

/** 称呼域的草稿视图。 */
export interface ContactsDraftView {
  /** 清洗后的草稿（空值剔除；供保存面与 dirty 比较）。 */
  readonly names: Readonly<Record<string, string>>;
  readonly dirty: boolean;
  /** 展示行（键 + 当前输入值），键升序稳定渲染。 */
  readonly rows: ReadonlyArray<{ readonly handle: string; readonly value: string }>;
}

/** 行集：白名单草稿归一化键 ∪ 基准键（升序）。 */
export function peerRows(
  allowlistDraft: readonly string[],
  baseline: Readonly<Record<string, string>>,
): readonly string[] {
  const keys = new Set<string>();
  for (const entry of allowlistDraft) {
    const key = normalizePhone(entry);
    if (key !== null) keys.add(key);
  }
  for (const key of Object.keys(baseline)) keys.add(key);
  return [...keys].sort();
}

/** 称呼注入预算（与 core peer-note 同值；超长一律截断）。 */
export const MAX_PEER_NAME_LENGTH = 64;

/** 草稿清洗：值 trim + 截断 + 空值剔除（空 = 删除）。 */
export function sanitizePeerNames(draft: PeerNamesDraft): Readonly<Record<string, string>> {
  const next: Record<string, string> = {};
  for (const [handle, value] of Object.entries(draft)) {
    const trimmed = value.trim().slice(0, MAX_PEER_NAME_LENGTH);
    if (trimmed !== '') next[handle] = trimmed;
  }
  return next;
}

/** 深比较（键值对完全相等；保存聚合的 dirty 判定）。 */
export function sameNames(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k])
  );
}

/** 草稿视图（override + 基准 → 清洗草稿 + dirty + 行）。 */
export function contactsDraftView(
  override: PeerNamesDraft | undefined,
  baseline: Readonly<Record<string, string>>,
  allowlistDraft: readonly string[],
): ContactsDraftView {
  const raw: Record<string, string> = { ...baseline, ...(override ?? {}) };
  const rows = peerRows(allowlistDraft, baseline).map((handle) => ({
    handle,
    value: raw[handle] ?? '',
  }));
  const names = sanitizePeerNames(raw);
  return { names, dirty: !sameNames(names, sanitizePeerNames(baseline)), rows };
}

/** 保存面提取（useSave 消费：清洗后的草稿直接作为 contacts op 载荷）。 */
export function contactsSavePayload(
  override: PeerNamesDraft | undefined,
  baseline: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return sanitizePeerNames({ ...baseline, ...(override ?? {}) });
}
