// ChannelState：state.json 的数据契约（Step 7 的 state-store 落盘形态）。
//
// 三大职责（对应 M3 验收的「不丢、不重」）：
// - cursor   增量轮询水位（不丢）
// - seenIds  已处理消息 guid 环形去重（不重）
// - sessions 每手机号的会话绑定 + 所有权台账（路由与隔离）

/** seenIds 环形容量：旧消息反正被 cursor 挡住，环形上限只需覆盖
 *  「cursor 不推进期间可能重复出现」的窗口。 */
export const SEEN_IDS_MAX = 500;

/** 持久化格式版本号：未来 schema 变更时作为迁移依据。 */
export const STATE_VERSION = 1;

import type { SessionId } from './dsh';

/** 一个手机号/邮箱的会话绑定（所有权台账见 M3 设计）。 */
export interface SessionBinding {
  /** 当前绑定的 DSH 会话 id（单活跃；归档/删除后由懒验证换绑）。 */
  sessionId: SessionId;
  /** 固定工作区，相对数据根的路径（搬数据根不失效），永不随会话变。 */
  workspaceDir: string;
  /** 该 key 绑定过的全部会话，append 去重、只增不删（/sessions 与 /bind 的
   *  所有权边界）。 */
  bindHistory: readonly SessionId[];
}

/** 通道运行时状态 = state.json 全部内容。 */
export interface ChannelState {
  readonly version: number;
  /** null = 从未初始化：首次轮询取当前 MAX(ROWID) 作起点（不回放历史）；
   *  有值 = 已处理到的消息 ROWID 水位。 */
  readonly cursor: number | null;
  /** 已处理消息的 guid，最新在前，超过 SEEN_IDS_MAX 淘汰尾部。 */
  readonly seenIds: readonly string[];
  /** conversationKey（归一化号码/邮箱）→ 绑定。 */
  readonly sessions: Readonly<Record<string, SessionBinding>>;
}

/** 初始状态：全新数据根 / state.json 不存在时使用。 */
export function makeChannelState(): ChannelState {
  return Object.freeze({
    version: STATE_VERSION,
    cursor: null,
    seenIds: [],
    sessions: {},
  });
}

/** conversationKey → 工作区相对路径（conversations/ 下的一段）。
 *  路径段安全化：非法字符替换为 _（邮箱的 @ 等）。 */
export function deriveWorkspaceDir(conversationKey: string): string {
  const safe = conversationKey.replace(/[^a-zA-Z0-9+.-]/g, '_');
  return `conversations/${safe}`;
}

/** 记录一次绑定/换绑（纯函数，返回新 state，不修改入参）。
 *  规则：sessionId 指针更新；bindHistory append 去重、保持首绑顺序；
 *  工作区首次派生后永不改变。 */
export function recordBinding(
  state: ChannelState,
  conversationKey: string,
  sessionId: SessionId,
): ChannelState {
  const existing = state.sessions[conversationKey];
  const binding: SessionBinding = existing
    ? {
        sessionId,
        workspaceDir: existing.workspaceDir,
        bindHistory: existing.bindHistory.includes(sessionId)
          ? existing.bindHistory
          : [...existing.bindHistory, sessionId],
      }
    : { sessionId, workspaceDir: deriveWorkspaceDir(conversationKey), bindHistory: [sessionId] };
  return {
    ...state,
    sessions: { ...state.sessions, [conversationKey]: binding },
  };
}

/** 形状守卫：读回的 JSON（或外部数据）是否像合法状态。 */
export function isChannelState(value: unknown): value is ChannelState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.version !== 'number' || typeof v.seenIds !== 'object' || v.seenIds === null) {
    return false;
  }
  if (v.cursor !== null && typeof v.cursor !== 'number') return false;
  if (!Array.isArray(v.seenIds) || v.seenIds.some((id) => typeof id !== 'string')) return false;
  if (typeof v.sessions !== 'object' || v.sessions === null) return false;
  return Object.values(v.sessions).every(
    (b) =>
      typeof b === 'object' &&
      b !== null &&
      typeof (b as SessionBinding).sessionId === 'string' &&
      typeof (b as SessionBinding).workspaceDir === 'string' &&
      Array.isArray((b as SessionBinding).bindHistory) &&
      (b as SessionBinding).bindHistory.every((id) => typeof id === 'string'),
  );
}
