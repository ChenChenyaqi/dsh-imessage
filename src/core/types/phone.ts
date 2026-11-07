// 号码 / Apple ID 归一化。
//
// iMessage 官方支持两种收发地址：电话号码（E.164）与 Apple 账户邮箱，
// 因此 handle 的合法形态只有这两种。
//
// 产品约定：系统内只认「带区号的完整号码」——
// - 设置页保存时由表单校验强制带区号（不带保存不了）；
// - 直接改配置文件里的非法条目静默失败（归一化后匹配不上任何消息，
//   等价于不在白名单），不做任何处理。
//
// 位数依据 ITU-T E.164：国际号码（含国家码）最多 15 位、不含 +；
// 标准未定义最小值（各国自定，实践惯例 7 位起步），本模块用 7..15 夹逼，
// 顺带拦掉 chat.db 里实测存在的超长垃圾伪造号（12~25 位）。

const MIN_DIGITS = 7; // 实践惯例下限（E.164 未定义最小值）
const MAX_DIGITS = 15; // E.164 明确上限（含国家码）

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

/** 校验「+ 国家码 + 用户号」总位数是否在 E.164 界内。 */
function inRange(digits: string): boolean {
  return digits.length >= MIN_DIGITS && digits.length <= MAX_DIGITS;
}

/**
 * 把原始 handle 归一化成系统内唯一的 conversationKey。
 *
 * - 含 `@`：Apple ID 邮箱，小写返回。
 * - 带 `+`：剥符号后按 E.164 位数界校验（7..15），超界拒绝。
 * - 裸号码（不带 +）：一律返回 null——不做国家码猜测，完整与否由
 *   配置入口（设置页表单）负责把关。
 * - 其余（空、纯符号）返回 null，调用方按默认拒绝处理。
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.includes('@')) {
    return EMAIL_RE.test(trimmed) ? trimmed.toLowerCase() : null;
  }

  if (!trimmed.startsWith('+')) return null; // 裸号码：不猜区号

  const digits = trimmed.replace(/\D/g, '');
  return inRange(digits) ? `+${digits}` : null;
}
