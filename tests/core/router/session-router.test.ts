import { describe, expect, it } from "vitest"

import { makeSessionRouter } from "@/core/router/session-router"
import { asSessionId } from "@/core/types/dsh"
import { makeChannelState, recordBinding } from "@/core/types/state"
import { makeFakeDshPort } from "../../helpers/fake-dsh-port"
import type { FakeDshPort } from "../../helpers/fake-dsh-port"

// ---------------------------------------------------------------------------
// 测试基建：内存 state + 可注入落盘失败
// ---------------------------------------------------------------------------

interface Harness {
  readonly port: FakeDshPort
  readonly router: ReturnType<typeof makeSessionRouter>
  readonly warnings: Array<{ event: string; fields?: Record<string, unknown> }>
  /** 读当前内存 state（断言用）。 */
  snapshot(): ReturnType<typeof makeChannelState>
  /** 一次性注入下一次落盘失败。 */
  failNextSave(): void
}

function makeHarness(): Harness {
  let state = makeChannelState()
  const port = makeFakeDshPort()
  const warnings: Harness["warnings"] = []
  let failSave = false
  const router = makeSessionRouter({
    port,
    loadState: () => state,
    saveState: (next) => {
      if (failSave) {
        failSave = false
        throw new Error("disk full")
      }
      state = next
    },
    log: {
      warn: (event, fields) => warnings.push({ event, fields: { ...fields } }),
      info: () => {},
    },
  })
  return {
    port,
    router,
    warnings,
    snapshot: () => state,
    failNextSave: () => {
      failSave = true
    },
  }
}

const KEY = "+8613800000000"

// ---------------------------------------------------------------------------
// 懒验证四态
// ---------------------------------------------------------------------------

describe("session router · first route creates and binds", () => {
  it("creates a session named after the key with a derived workspace", async () => {
    const h = makeHarness()
    const result = await h.router.route(KEY)
    expect(result.created).toBe(true)
    expect(result.reason).toBe("fresh")
    expect(h.port.createdCalls).toHaveLength(1)
    expect(h.port.createdCalls[0]).toMatchObject({
      workspaceDir: "conversations/+8613800000000",
      name: `imessage ${KEY}`,
    })
    const binding = h.snapshot().sessions[KEY]!
    expect(binding.sessionId).toBe(result.sessionId)
    expect(binding.bindHistory).toEqual([result.sessionId])
  })

  it("creates under the existing workspace when rebinding (workspace never moves)", async () => {
    const h = makeHarness()
    await h.router.route(KEY)
    const first = h.snapshot().sessions[KEY]!
    h.port.statuses.set(first.sessionId, "archived")
    await h.router.route(KEY)
    expect(h.port.createdCalls[1]?.workspaceDir).toBe(first.workspaceDir)
  })
})

describe("session router · lazy validation", () => {
  it("reuses an active binding without creating", async () => {
    const h = makeHarness()
    const first = await h.router.route(KEY)
    const second = await h.router.route(KEY)
    expect(second).toMatchObject({
      sessionId: first.sessionId,
      created: false,
      reason: "reused",
    })
    expect(h.port.createdCalls).toHaveLength(1)
  })

  it("rebuilds with rebind-archived reason when the session was archived", async () => {
    const h = makeHarness()
    const first = await h.router.route(KEY)
    h.port.statuses.set(first.sessionId, "archived")
    const second = await h.router.route(KEY)
    expect(second.created).toBe(true)
    expect(second.reason).toBe("rebind-archived")
    expect(second.sessionId).not.toBe(first.sessionId)
    const binding = h.snapshot().sessions[KEY]!
    expect(binding.bindHistory).toEqual([first.sessionId, second.sessionId])
  })

  it("rebuilds silently (rebind-missing) when the session is gone", async () => {
    const h = makeHarness()
    const first = await h.router.route(KEY)
    h.port.statuses.delete(first.sessionId)
    const second = await h.router.route(KEY)
    expect(second.reason).toBe("rebind-missing")
    expect(h.snapshot().sessions[KEY]!.sessionId).toBe(second.sessionId)
  })

  it("never revives an archived session by name after rebinding", async () => {
    const h = makeHarness()
    const first = await h.router.route(KEY)
    h.port.statuses.set(first.sessionId, "archived")
    const second = await h.router.route(KEY)
    // 用户在 DSH 侧手动恢复了旧会话（active）——绑定不回跳
    h.port.statuses.set(first.sessionId, "active")
    const third = await h.router.route(KEY)
    expect(third.sessionId).toBe(second.sessionId)
    expect(third.reason).toBe("reused")
  })
})

// ---------------------------------------------------------------------------
// 预绑定事务（孤儿语义）
// ---------------------------------------------------------------------------

describe("session router · pre-bind transaction", () => {
  it("persists the binding before the session is used", async () => {
    const h = makeHarness()
    await h.router.route(KEY)
    expect(h.snapshot().sessions[KEY]).toBeDefined()
  })

  it("keeps answering with the new session when persistence fails (orphan is harmless)", async () => {
    const h = makeHarness()
    h.failNextSave()
    const result = await h.router.route(KEY)
    expect(result.created).toBe(true) // 不吞消息：照常返回会话
    expect(h.snapshot().sessions[KEY]).toBeUndefined() // 但绑定确实没落盘
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]?.event).toBe("router.orphan-session")
    // 重启后（state 无绑定）再次路由：自然重建
    const rebuilt = await h.router.route(KEY)
    expect(rebuilt.sessionId).not.toBe(result.sessionId)
  })

  it("propagates create failures (the lock survives for later calls)", async () => {
    const h = makeHarness()
    h.port.failNextCreate(new Error("dsh down"))
    await expect(h.router.route(KEY)).rejects.toThrow("dsh down")
    const ok = await h.router.route(KEY) // 锁未被失败卡死
    expect(ok.created).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// per-key 串行锁
// ---------------------------------------------------------------------------

describe("session router · keyed serialization", () => {
  it("serializes concurrent routes on the same key (single create)", async () => {
    const h = makeHarness()
    h.port.setCreateDelay(25)
    const [a, b] = await Promise.all([h.router.route(KEY), h.router.route(KEY)])
    expect(h.port.createdCalls).toHaveLength(1) // 后到者复用先到者的绑定
    expect(b.sessionId).toBe(a.sessionId)
    expect([a.created, b.created].sort()).toEqual([false, true])
  })

  it("lets different keys proceed in parallel", async () => {
    const h = makeHarness()
    h.port.setCreateDelay(40)
    const t0 = Date.now()
    await Promise.all([h.router.route(KEY), h.router.route("alice@icloud.com")])
    const elapsed = Date.now() - t0
    expect(h.port.createdCalls).toHaveLength(2)
    expect(elapsed).toBeLessThan(75) // 并行：远小于串行 2×40ms
  })

  it("rebuilds sequentially when the binding keeps failing to persist", async () => {
    // 连续两条消息、第一次落盘失败：第二条在锁内看到无绑定 → 会再建一个。
    // 孤儿累积是接受的行为（无害），此测试钉住语义而非掩盖。
    const h = makeHarness()
    h.port.setCreateDelay(5)
    h.failNextSave()
    const [a, b] = await Promise.all([h.router.route(KEY), h.router.route(KEY)])
    expect(a.created).toBe(true)
    // 第二条排队执行时第一次的绑定没落盘 → 它也走 fresh
    expect(b.created).toBe(true)
    expect(h.port.createdCalls).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 台账（bindHistory）
// ---------------------------------------------------------------------------

describe("session router · ledger", () => {
  it("appends each distinct session once, keeping first-bind order", async () => {
    const h = makeHarness()
    const first = await h.router.route(KEY)
    h.port.statuses.set(first.sessionId, "archived")
    const second = await h.router.route(KEY)
    h.port.statuses.delete(second.sessionId)
    const third = await h.router.route(KEY)
    // 旧会话恢复后再来一轮：绑定仍是 third（不回跳），台账不新增
    h.port.statuses.set(first.sessionId, "active")
    h.port.statuses.set(second.sessionId, "active")
    await h.router.route(KEY)
    const binding = h.snapshot().sessions[KEY]!
    expect(binding.bindHistory).toEqual([
      first.sessionId,
      second.sessionId,
      third.sessionId,
    ])
    expect(binding.sessionId).toBe(third.sessionId)
  })

  it("does not re-append a session that is re-bound by state restoration", async () => {
    // 外部（/bind 命令）把绑定换回历史会话：recordBinding 判重保持台账
    const h = makeHarness()
    const first = await h.router.route(KEY)
    h.port.statuses.set(first.sessionId, "archived")
    await h.router.route(KEY)
    // 模拟 /bind 回切（M5 命令）：直接改内存 state
    const state = h.snapshot()
    const rebound = recordBinding(state, KEY, first.sessionId)
    expect(rebound.sessions[KEY]!.bindHistory).toEqual([
      first.sessionId,
      ...state.sessions[KEY]!.bindHistory.filter(
        (id) => id !== first.sessionId,
      ),
    ])
    expect(asSessionId(rebound.sessions[KEY]!.sessionId)).toBe(first.sessionId)
  })
})
