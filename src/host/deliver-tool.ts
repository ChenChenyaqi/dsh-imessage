// imessage_send_file 交付工具（M6.2 Step B，dsh-im 的 dsh_im_return_file 同构）。
//
// 语义（description 同源措辞）：成功 = 已排队（queued not sent），AI 不得
// 声称对方已收到；工具只在 iMessage 会话的交付语境下有意义。
//
// 路由校验（全局注册 + 执行时收敛，分叉 2 定案）：工具注册进宿主全局
// （所有会话可见，per-agent scope 复杂度不成比例）；执行时校验 DSH 会话
// ∈ 本插件路由表，否则报错——Web/桌面会话误调 = 无害报错，不产生发送。
//
// bytes 入队时机（分叉 3 定案）：工具执行时读——前置校验存在/可读/大小，
// 免去发送时路径失效（AI 之后改动/删除文件）。

import type { ArtifactCollector } from '../core/router/artifacts';
import { safeOutboundName } from '../core/imessage/outbound';
import type { Logger } from '../core/log/jsonl';
import type { HostToolDefinition, HostToolsService } from './dsh-api';

export const DELIVER_TOOL_NAME = 'imessage_send_file';

/** 单文件入队上限（分叉 5 定案；真机 Messages 实用附件实测后校准）。 */
export const OUTBOUND_MAX_BYTES = 50 * 1024 * 1024;

export const DELIVER_TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Absolute path of the workspace file to deliver as an iMessage attachment',
    },
  },
  required: ['path'],
  additionalProperties: false,
} as const;

const DELIVER_TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', description: 'queued for iMessage delivery after the reply' },
    fileName: { type: 'string' },
    bytes: { type: 'number' },
  },
  required: ['status', 'fileName', 'bytes'],
  additionalProperties: false,
} as const;

export interface DeliverToolDeps {
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly stat: (path: string) => Promise<{ size: number }>;
  /** 2026-11-22 真机教训：execute 失败零留痕只能翻会话日志定位——
   *  拒绝路径也要打点（artifact.tool-rejected）。 */
  readonly log?: Pick<Logger, 'info' | 'warn'>;
}

export interface DeliverToolServices {
  /** 动态探测：老宿主无 tools 服务 = 返回 no-op 卸载器（降级不阻塞）。 */
  readonly tools?: HostToolsService;
  readonly collector: ArtifactCollector;
  /** 路由反查（SessionRouter.conversationKeyOf）：DSH 会话 → iMessage key。 */
  readonly conversationKeyOf: (sessionId: string) => string | undefined;
}

function reject(deps: DeliverToolDeps, reason: string): never {
  // 排障盲区修复：拒绝路径留痕（否则只能翻 DSH 会话日志才知道工具被拒）
  deps.log?.warn('artifact.tool-rejected', { reason });
  throw new Error(`${DELIVER_TOOL_NAME}: ${reason}`);
}

export function buildDeliverToolDefinition(
  services: DeliverToolServices,
  deps: DeliverToolDeps,
): HostToolDefinition {
  return {
    name: DELIVER_TOOL_NAME,
    description:
      'Queue one workspace file to be sent to the iMessage contact as an attachment, ' +
      'delivered right after the current text reply. Use it when the contact asks for a ' +
      'file or image. Requires an active iMessage delivery context — this tool only works ' +
      'in conversations bridged from iMessage; in Web, Desktop, or CLI conversations use ' +
      `the host present tool if available. Success means queued, not sent: do not claim ` +
      `the contact has received the file. Max ${OUTBOUND_MAX_BYTES} bytes per file.`,
    parameters: { ...DELIVER_TOOL_PARAMETERS },
    output: {
      schema: { ...DELIVER_TOOL_OUTPUT_SCHEMA },
      render: (_args, value) => {
        const v = value as { status?: string; fileName?: string };
        return [{ type: 'text', text: `${v.status ?? 'queued'}: ${v.fileName ?? ''}` }];
      },
    },
    async execute(args, exec) {
      // 官方 Agent 身份字段是 id（见 dsh-api.ts HostToolDefinition 源码坐标注释）
      const agentId = exec.agent?.id;
      if (agentId === undefined) {
        reject(deps, 'no agent session context (tool invoked outside an agent loop)');
      }
      if (services.conversationKeyOf(agentId) === undefined) {
        reject(deps, `session ${agentId} is not bridged from iMessage (web/desktop session)`);
      }
      const path = (args as { path?: unknown } | null | undefined)?.path;
      if (typeof path !== 'string' || !path.startsWith('/')) {
        reject(deps, 'args.path must be an absolute file path');
      }
      const { size } = await deps.stat(path);
      if (size === 0) reject(deps, 'file is empty');
      if (size > OUTBOUND_MAX_BYTES) {
        reject(deps, `file exceeds the ${OUTBOUND_MAX_BYTES} byte limit (${size} bytes)`);
      }
      const bytes = await deps.readFile(path);
      const fileName = safeOutboundName(path);
      // push 与 take 同 key：本轮 ask 流内执行，pipeline take 前必然已入队
      services.collector.push(agentId, { bytes, fileName });
      deps.log?.info('artifact.queued', {
        sessionId: agentId,
        name: fileName,
        bytes: bytes.length,
      });
      return { status: 'queued', fileName, bytes: bytes.length };
    },
  };
}

/** 注册交付工具；返回卸载器（channel stop 时调用）。无 tools 服务 = no-op。 */
export function installDeliverTool(
  services: DeliverToolServices,
  deps: DeliverToolDeps,
): () => void {
  if (services.tools === undefined) return () => undefined; // 老宿主降级
  return services.tools.register(buildDeliverToolDefinition(services, deps));
}
