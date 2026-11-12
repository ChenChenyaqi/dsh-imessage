// 宿主客户端服务的契约面（只声明我们实际用到的那部分）。
//
// 单独一个文件：入口、挂载、组件都依赖这些类型，但不该依赖彼此的
// 实现——把契约抽出来后，任何一层都能被独立替换/测试。

/** 一次字段写入（对齐宿主 SettingsPathOp）。 */
export interface HostFieldOp {
  readonly op: 'set' | 'unset';
  readonly path: readonly string[];
  readonly value?: unknown;
}

/** 宿主配置表单（ConfigForm 的最小面）。 */
export interface HostForm {
  getSnapshot(): { value?: Readonly<Record<string, unknown>> | undefined };
  subscribe(listener: () => void): () => void;
  mutate(ops: readonly HostFieldOp[]): Promise<boolean>;
}

/** 宿主语言服务（真机 API：getSnapshot().active + subscribe）。 */
export interface HostLocale {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void;
  getSnapshot(): { active: string };
  subscribe(listener: () => void): () => void;
}

/** 槽位注册面（settings.section 是列表槽位，按 id 唯一）。 */
export interface HostSlots {
  register(
    options: { name: string; id: string; order: number; label: () => string },
    component: (props: Record<string, never>) => unknown,
  ): () => void;
  inject(key: string, callback: () => () => void): () => void;
}

/** 浏览器插件上下文（cordis ClientContext 的最小面）。 */
export interface ClientContext {
  slots: HostSlots;
  locale: HostLocale;
  configForms: { get(namespace: string): HostForm };
  effect(fn: () => () => unknown, label?: string): void;
}
