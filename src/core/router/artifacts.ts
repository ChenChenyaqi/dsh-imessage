// 外发交付产物收集器（M6.2 Step B）。
//
// 链路：AI 调 imessage_send_file 工具（host/deliver-tool）→ push 入队 →
// 本轮 ask 的文本回复发出后由 pipeline take 保序逐个交付。
//
// 泄漏防线：take 即清 key；上轮异常中断（ask 抛错、消息进重试）未取走
// 的残留由下一轮 open 清掉——旧轮的文件永不混进下一轮的交付。

/** 单个待交付文件（内存形态；暂存 IO 在 pipeline 交付段才发生）。 */
export interface OutboundArtifact {
  readonly bytes: Uint8Array;
  /** 展示名（暂存文件名与日志用；不含路径分隔符）。 */
  readonly fileName: string;
}

export interface ArtifactCollector {
  /** 本轮 ask 开始：清掉该会话上轮残留（异常中断未 take 的）。 */
  open(sessionId: string): void;
  /** 工具执行：入队一个待交付文件（同轮保序 append）。 */
  push(sessionId: string, artifact: OutboundArtifact): void;
  /** 本轮 ask 结束取走全部并清 key。 */
  take(sessionId: string): readonly OutboundArtifact[];
}

export function makeArtifactCollector(): ArtifactCollector {
  const queues = new Map<string, OutboundArtifact[]>();
  return {
    open(sessionId) {
      queues.set(sessionId, []);
    },
    push(sessionId, artifact) {
      const queue = queues.get(sessionId) ?? [];
      queue.push(artifact);
      queues.set(sessionId, queue);
    },
    take(sessionId) {
      const queue = queues.get(sessionId) ?? [];
      queues.delete(sessionId);
      return queue;
    },
  };
}
