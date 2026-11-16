// typedstream(attributedBody) 文本提取器。
//
// attributedBody 是 NSArchiver 的 typedstream 归档（"streamtyped" 魔数开头），
// 内含 NSAttributedString 对象图。完整解析需实现类注册表/跨引用/属性字典，
// 对「只要正文文本」是过度设计——本模块采用**定位扫描**：
//   1. 找到内联 NSString 实例的类名字节；
//   2. 类名后向后扫描内联标签 '+'（0x2b，中间可能隔着属性数据）；
//   3. 按 NXTypedStream 长度编码读 payload 长度；
//   4. 取 N 字节按 UTF-8 严格解码。
//
// 格式事实（dsh-im 实践验证 + 本机 45 条真实样本 fixture 验证）：
// - 长度编码：0x00–0x7f 为字面长度；0x81/0x82/0x83 引导小端 2/4/8 字节长度；
// - U+FFFC 对象替换字符是附件占位：纯附件消息全文即 FFFC；带 caption 时
//   与正文混排——解码后剥离 FFFC；
// - macOS 26 (Tahoe) 起收到的 iMessage 不再写 message.text，正文只在此 BLOB。
//
// 失败语义：任何环节异常（无类名 / 无标签 / 长度越界 / 坏 UTF-8）返回 null，
// 由 normalize 层降级为占位文本，**绝不丢消息**（PLAN 风险对策）。

const NSString_CLASS_BYTES: Readonly<Uint8Array> = new Uint8Array([
  0x4e,
  0x53,
  0x53,
  0x74,
  0x72,
  0x69,
  0x6e,
  0x67, // "NSString"
]);

/** 内联 NSString payload 标签。 */
const INLINE_STRING_TAG = 0x2b; // '+'

/** 附件占位字符（U+FFFC）。 */
export const OBJECT_REPLACEMENT_CHAR = '\uFFFC';

/**
 * 提取 attributedBody 中的正文文本。
 * 返回：文本（可能为空串）；null = 无 BLOB / 解码失败。
 * 空串语义 = 解码成功但剥离 U+FFFC 后无文本（纯附件），
 * 与 null（失败）区分，供 normalize 层分派不同占位。
 */
export function decodeAttributedBodyText(blob: Uint8Array | null | undefined): string | null {
  if (!blob || blob.length === 0) return null;

  const marker = indexOfBytes(blob, NSString_CLASS_BYTES);
  if (marker < 0) return null;

  let tag = -1;
  for (let i = marker + NSString_CLASS_BYTES.length; i < blob.length; i++) {
    if (blob[i] === INLINE_STRING_TAG) {
      tag = i;
      break;
    }
  }
  if (tag < 0) return null;

  const payload = readTypedStreamLength(blob, tag + 1);
  if (!payload || payload.length === 0) return null;

  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(
      blob.subarray(payload.offset, payload.offset + payload.length),
    );
  } catch {
    return null; // 坏 UTF-8：不猜，降级
  }

  // 剥离附件占位符（不是文本语义的一部分）；不 trim——忠实原文，
  // 空白策略归 normalize 层。空串 = 纯附件，与失败（null）区分。
  return raw.replaceAll(OBJECT_REPLACEMENT_CHAR, '');
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

interface TypedStreamLength {
  readonly length: number;
  readonly offset: number;
}

/** NXTypedStream 长度编码；越界或负长度返回 null。 */
function readTypedStreamLength(b: Uint8Array, off: number): TypedStreamLength | null {
  if (off >= b.length) return null;
  const tag = b[off]!;
  let cursor = off + 1;
  let length: number;
  if (tag === 0x81 || tag === 0x82 || tag === 0x83) {
    const bytes = 1 << (tag - 0x80); // 0x81→2、0x82→4、0x83→8 字节长度
    if (cursor + bytes > b.length) return null;
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (tag === 0x81) length = view.getInt16(cursor, true);
    else if (tag === 0x82) length = view.getInt32(cursor, true);
    else {
      // 8 字节：超出安全整数范围直接判无效
      const v = view.getBigInt64(cursor, true);
      if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      length = Number(v);
    }
    cursor += bytes;
  } else {
    length = tag > 0x7f ? tag - 0x100 : tag; // 单字节：有符号字面值
  }
  if (!Number.isInteger(length) || length < 0 || cursor + length > b.length) {
    return null;
  }
  return { length, offset: cursor };
}

/** Uint8Array 子序列搜索（无原生 API）。 */
function indexOfBytes(hay: Uint8Array, needle: Readonly<Uint8Array>): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
