// session-router：conversationKey → DSH 会话的绑定管理员（M3 Step 2）。
//
// 模型（PLAN 定案）：
// - 手机号 → 单活跃会话 + 固定工作区（工作区跟 key 走、永不换；
//   会话只是可替换的把手）；
// - 懒验证三态：来消息时才查绑定会话状态——
//     active   → 直接复用；
//     archived → 自动新建 + 上层向手机端告知（用户无法去 DSH 恢复）；
//     missing  → 自动新建，静默；
//     （无绑定 → 首次新建）；
// - 不按名复活：归档的旧会话即便被 DSH 侧手动恢复，绑定保持新会话
//   不回跳——本模块只认 sessionId 台账，从不按名字搜索。
//
// 预绑定事务时序（吸收 dsh-im 孤儿会话教训，砍掉 fence/多 bot 复杂度）：
//   create → recordBinding → saveState → 才返回使用。
//   落盘失败 = DSH 里多一个没人绑定的空会话（孤儿），无害：
//   记警告日志后继续用新会话答复（失败不吞消息），重启后自然重建绑定。
//
// 并发：per-key 串行锁——同 key 的路由请求排队（后到的看到先到的绑定，
// 不会重复建会话）；不同 key 互不阻塞。

import type { Logger } from "../log/jsonl"
import type { DshPort, SessionId } from "../types/dsh"
import {
  deriveWorkspaceDir,
  recordBinding,
  type ChannelState,
} from "../types/state"

/** 路由结果：reason 供上层决定是否告知手机端（i18n 渲染归 pipeline）。 */
export interface RouteResult {
  readonly sessionId: SessionId
  /** 本次路由是否新建了会话。 */
  readonly created: boolean
  readonly reason: "fresh" | "rebind-archived" | "rebind-missing" | "reused"
}

export interface RouterDeps {
  readonly port: DshPort
  /** 当前 agent 预设 id（用时读 → 配置热更对新建会话生效；空 = 宿主默认）。 */
  readonly preset?: () => string | undefined
  /** 读当前状态（锁内调用，取最新）。 */
  readonly loadState: () => ChannelState
  /** 落盘状态（预绑定事务的提交点）。 */
  readonly saveState: (state: ChannelState) => void
  /** 可选日志通道（孤儿会话等警告）。 */
  readonly log?: Pick<Logger, "warn" | "info">
}

export interface SessionRouter {
  route(conversationKey: string): Promise<RouteResult>
}

/** per-key 串行锁：同 key 排队、异 key 并行、空锁即清理防泄漏。 */
export function makeKeyedLock(): <T>(
  key: string,
  fn: () => Promise<T>,
) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>()
  return async function withLock<T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn) // 前序失败也继续（锁不被失败卡死）
    tails.set(key, next)
    try {
      return await next
    } finally {
      if (tails.get(key) === next) tails.delete(key)
    }
  }
}

export function makeSessionRouter(deps: RouterDeps): SessionRouter {
  const { port, loadState, saveState, log } = deps
  const withLock = makeKeyedLock()

  /** 新建会话并预绑定落盘（锁内、读最新 state）。 */
  const createAndBind = async (
    conversationKey: string,
    reason: RouteResult["reason"],
  ): Promise<RouteResult> => {
    const before = loadState()
    const existing = before.sessions[conversationKey]
    const workspaceDir =
      existing?.workspaceDir ?? deriveWorkspaceDir(conversationKey)
    // 会话名仅可读辅助（`imessage <key>` 约定），不作任何安全边界
    const preset = deps.preset?.();
    const sessionId = await port.createSession({
      workspaceDir,
      name: `imessage ${conversationKey}`,
      ...(preset === undefined || preset === '' ? {} : { preset }),
    })
    try {
      saveState(recordBinding(loadState(), conversationKey, sessionId))
    } catch (err) {
      // 孤儿会话：DSH 侧已创建、绑定未落盘。无害——继续用（本次答复
      // 不丢），重启后懒验证发现无绑定/或绑定旧会话自然重建。
      log?.warn("router.orphan-session", {
        conversationKey,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    log?.info("router.session-created", { conversationKey, sessionId, reason })
    return { sessionId, created: true, reason }
  }

  return {
    route: (conversationKey) =>
      withLock(conversationKey, async (): Promise<RouteResult> => {
        const binding = loadState().sessions[conversationKey]
        if (!binding) return createAndBind(conversationKey, "fresh")
        // 懒验证：会话把手可能已失效（归档/删除），现场核实
        const status = await port.getSessionStatus(binding.sessionId)
        if (status === "active") {
          return {
            sessionId: binding.sessionId,
            created: false,
            reason: "reused",
          }
        }
        return createAndBind(
          conversationKey,
          status === "archived" ? "rebind-archived" : "rebind-missing",
        )
      }),
  }
}
