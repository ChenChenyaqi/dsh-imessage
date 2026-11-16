// 手写 renderHook（项目不引 @testing-library，沿用 createRoot + act 模式）。
//
// 用法：
//   const { result, setHook, unmount } = renderHook(() => useAllowlist(), {
//     wrapper: ({ children }) => createElement(CardProvider, { value }, children),
//   });
//   act(() => result.current.beginAdd());
//   setHook(() => useAllowlist(...));  // 换 hook 闭包，随后 rerender 生效
//
// wrapper 闭包捕获的外部值（如 context value）变了，rerender() 即可见 ——
// 这就是域 hook 测试模拟「宿主推送」的方式。
// setHook 换闭包后必须紧跟一次 rerender()（act 内重渲染执行新闭包）。

import { act } from 'react';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// React 18 测试环境标志（否则 act 警告且 effect flush 行为退化）
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface RenderHookResult<T> {
  /** 最近一次渲染的 hook 返回值。 */
  readonly result: { current: T };
  /** 换 hook 闭包（模拟 props/saved 变化），随后调 rerender 生效。 */
  setHook(hook: () => T): void;
  /** 用当前闭包重渲染（触发 useSyncExternalStore / effect）。 */
  rerender(): void;
  unmount(): void;
}

export interface RenderHookOptions {
  /** 包裹组件（注入 context）；闭包捕获的 value 变化靠 rerender 生效。 */
  readonly wrapper?: ComponentType<{ children?: ReactNode }>;
}

export function renderHook<T>(
  initialHook: () => T,
  options: RenderHookOptions = {},
): RenderHookResult<T> {
  const container = document.createElement('div');
  let root: Root | null = createRoot(container);
  const holder: { hook: () => T } = { hook: initialHook };
  const state: { current: T } = { current: undefined as never };

  function Probe() {
    state.current = holder.hook();
    return null;
  }

  function render() {
    const probe = createElement(Probe);
    const tree = options.wrapper ? createElement(options.wrapper, undefined, probe) : probe;
    root!.render(tree);
  }

  act(render);

  return {
    result: state,
    setHook(hook: () => T) {
      holder.hook = hook;
    },
    rerender() {
      act(render);
    },
    unmount() {
      act(() => {
        root?.unmount();
        root = null;
      });
    },
  };
}

export { act };
