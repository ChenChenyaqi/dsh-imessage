// 可推送的 fake 宿主表单（controller.test 的 makeForm 提取共享；期 3 起供
// useCardForm / useSave / SettingsCardHost 测试使用）。
//
// mutate 成功后主动推送（模拟「我们自己的写入回流」）；push() 模拟别处改动。
//
// 方法故意用 class 原型方法（而非闭包属性）：宿主 ConfigForm 就是原型方法，
// 被测代码若把 form.getSnapshot / form.mutate 当脱离对象的方法引用传递，
// this 丢失会在这里先炸（真机空白卡片的坑，e2e 才抓到太晚）。

export interface FakeCardForm {
  /** 注入给被测代码的表单面。 */
  readonly form: {
    getSnapshot(): { value?: Readonly<Record<string, unknown>> | undefined };
    subscribe(listener: () => void): () => void;
    mutate(
      ops: readonly { op: string; path: readonly string[]; value?: unknown }[],
    ): Promise<boolean>;
  };
  /** 记录每次 mutate 的 ops。 */
  readonly calls: Array<readonly { op: string; path: readonly string[]; value?: unknown }[]>;
  /** 宿主侧推送新值（别处改了配置 / 我们自己的写入回流）。 */
  push(next: Record<string, unknown>): void;
}

export function makeCardForm(
  initial: Record<string, unknown> = {},
  options: { readonly mutateResult?: boolean | Error } = {},
): FakeCardForm {
  const listeners = new Set<() => void>();
  const calls: Array<readonly { op: string; path: readonly string[]; value?: unknown }[]> = [];

  /** 原型方法形状的 fake（this 语义与真宿主一致）。 */
  class FakeForm {
    private value: Record<string, unknown> = { ...initial };
    private cached: { value: Record<string, unknown> } | null = null;

    // useSyncExternalStore 契约：值未变时必须返回同一引用
    getSnapshot(): { value: Record<string, unknown> } {
      return this.cached && this.cached.value === this.value
        ? this.cached
        : (this.cached = { value: this.value });
    }

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }

    async mutate(
      ops: readonly { op: string; path: readonly string[]; value?: unknown }[],
    ): Promise<boolean> {
      calls.push(ops);
      if (options.mutateResult instanceof Error) throw options.mutateResult;
      if (options.mutateResult === false) return false;
      for (const op of ops) {
        if (op.op === 'set' && op.path.length === 1) {
          this.value = { ...this.value, [op.path[0] as string]: op.value };
        }
      }
      this.notify();
      return true;
    }

    push(next: Record<string, unknown>): void {
      this.value = { ...this.value, ...next };
      this.notify();
    }

    private notify(): void {
      for (const listener of listeners) listener();
    }
  }

  const instance = new FakeForm();
  return { form: instance, calls, push: (next) => instance.push(next) };
}
