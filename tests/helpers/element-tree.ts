// React 元素树断言 helper（无 jsdom 直调模式共用）。
//
// 组件刻意做成无 hook 纯函数：测试直接调用拿到元素树，遍历断言
// props 与事件转发（源自 tests/client/settings/view.test.ts，供
// settings 子组件测试共享）。

import { isValidElement, type ReactElement, type ReactNode } from 'react';

export type AnyElement = ReactElement<Record<string, unknown>>;

/** 深度遍历元素树（字符串子节点忽略）。 */
export function collect(node: ReactNode, out: AnyElement[] = []): AnyElement[] {
  if (Array.isArray(node)) {
    for (const child of node) collect(child as ReactNode, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const element = node as AnyElement;
  out.push(element);
  const children = element.props['children'];
  if (children !== undefined) collect(children as ReactNode, out);
  return out;
}

/** 按原生标签或组件身份找元素。 */
export function find(tree: ReactNode, tag: string | unknown): AnyElement[] {
  return collect(tree).filter((element) => element.type === tag);
}

/** 递归抽字符串子节点（数组 children 里的字符串也要，chip 文案在数组里）。 */
export function stringsOf(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const child of node) stringsOf(child, out);
  return out;
}

/** 树里所有字符串子节点拼起来（断言可见文案）。 */
export function textOf(tree: ReactNode): string {
  return collect(tree)
    .flatMap((element) => stringsOf(element.props['children']))
    .join(' ');
}
