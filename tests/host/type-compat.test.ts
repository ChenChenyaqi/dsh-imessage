// 类型兼容守护（方案 C）：断言手写宿主类型子集（dsh-api.ts，探针校准）
// 与官方类型包（@deepseek-ai/dsh-*@<DSH version>，devDep）不漂移。
//
// 断言方向：官方 Context 成员可赋值给我们的子集接口——
// 说明我们声明的形状（参数/返回类型）没有偏离官方契约。
// 一旦 DSH 升级改了接口，先 `pnpm update` 官方类型包，此测试
// 在 typecheck（tsc --noEmit）阶段变红，暴露漂移点。
//
// 注意：类型对齐 ≠ 行为对齐。运行时行为事实（create 不幂等、
// agentOptions 必带、workspace 目录须先建等）仍由 scripts/probe/
// 的真机探针负责校准，升级 DSH 时需重跑探针。

import type { Context } from '@deepseek-ai/cordis';
// 触发官方包对 cordis Context 的模块增强（type-only，零运行时开销）
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-session-title';
import type {} from '@deepseek-ai/dsh-workspace';

import { describe, expect, it } from 'vitest';
import type {
  HostAgentDefaultModelService,
  HostAgentsService,
  HostEventPayloads,
  HostSessionTitleService,
  HostWorkspaceRegistry,
} from '@/host/dsh-api';

/** 官方 Events 接口（cordis 模块增强）。 */
type OfficialEvents = import('@deepseek-ai/cordis').Events;

// ---------------------------------------------------------------------------
// 编译期赋值断言工具（tsc --noEmit 强制检查）
// ---------------------------------------------------------------------------

/** 官方类型 TOfficial 是否可赋给我们的子集 TOurs。 */
type IsAssignable<TOfficial, TOurs> = TOfficial extends TOurs ? true : false;

/** 断言为 true，否则编译失败并显示实际类型。 */
type Assert<Check extends true> = Check;

describe('type compatibility with official @deepseek-ai/dsh-* packages', () => {
  it('compiles (assertions run at typecheck time, not runtime)', () => {
    expect(true).toBe(true);
  });
});

// ctx.agents ↔ HostAgentsService
type AgentsCheck = Assert<IsAssignable<Context['agents'], HostAgentsService>>;

// ctx.workspaceRegistry ↔ HostWorkspaceRegistry
type WorkspaceCheck = Assert<IsAssignable<Context['workspaceRegistry'], HostWorkspaceRegistry>>;

// ctx.agentDefaultModel ↔ HostAgentDefaultModelService
type DefaultModelCheck = Assert<
  IsAssignable<Context['agentDefaultModel'], HostAgentDefaultModelService>
>;

// ctx.sessionTitle ↔ HostSessionTitleService
type SessionTitleCheck = Assert<IsAssignable<Context['sessionTitle'], HostSessionTitleService>>;

// ---- 事件参数形状（同类事故：fake 传字符串、真宿主传对象）-----------------
// 断言方向：官方监听器签名的参数元组可赋给我们的 HostEventPayloads[事件]。
// 若官方是对象而我们写成字符串，这里编译失败（曾真实发生：
// session/event 首参 Session 对象、assistant-stream 的 agent 是 Agent 对象）。

/** 取官方监听器参数元组（this 参数不参与推断；写成 this: unknown 会退化成 never 假绿）。 */
type ParamsOf<T> = T extends (...args: infer P) => unknown ? P : never;

// session/event 只断言首参（Session 对象）：官方事件 union 覆盖全部事件类型，
// 我们的子集必然更窄；真正咬人的是"首参是对象还是字符串"。
type SessionEventCheck = Assert<
  IsAssignable<ParamsOf<OfficialEvents['session/event']>[0], HostEventPayloads['session/event'][0]>
>;
type StreamCheck = Assert<
  IsAssignable<
    ParamsOf<OfficialEvents['agent/assistant-stream']>,
    HostEventPayloads['agent/assistant-stream']
  >
>;
type StatusCheck = Assert<
  IsAssignable<ParamsOf<OfficialEvents['agent/status']>, HostEventPayloads['agent/status']>
>;
type ErrorCheck = Assert<
  IsAssignable<ParamsOf<OfficialEvents['agent/error']>, HostEventPayloads['agent/error']>
>;

// 汇总引用（避免各断言被标记 unused）
export type TypeCompatProof = [
  AgentsCheck,
  WorkspaceCheck,
  DefaultModelCheck,
  SessionTitleCheck,
  SessionEventCheck,
  StreamCheck,
  StatusCheck,
  ErrorCheck,
];
