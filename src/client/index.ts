// 客户端半身入口：只声明身份与依赖，接线交给 settings/mount。
//
// 分层（每层单独可测，互不越界）：
//   host.d.ts              宿主服务契约（纯类型声明，无运行时）
//   i18n/                  词条字典（text.ts；卡片直读，不经宿主 locale 系统——
//                          presetNames 非平字符串塞不进 LocaleDict，已核实
//                          宿主不消费第三方 ns 的注册）
//   settings/mount.tsx     槽位接线（settings.section 组件注册）
//   settings/ids.ts         身份常量（菜单 id / 配置命名空间）
//   settings/draft-store.ts 草稿 override store（纯 TS，细粒度订阅靠 React 引用比较）
//   settings/card-context.ts 卡片 context（saved 基准/mutate/词条/remote）
//   settings/<域>/           字段目录：xxx.tsx（hook 就地执行 + 渲染）
//                           + useXxx.ts（订阅 hook）+ logic.ts（纯函数）
//   settings/useSave.ts     canSave 派生 + 全量覆盖式原子写（SaveBar 内执行）
//   settings/view.tsx       静态组合树（零 props）
//   settings/host.tsx       组装层（唯一的宿主服务消费者：表单订阅 + store 生命周期）
//   本文件                   插件入口（inject + apply）

import type { ClientContext } from './host';
import { mountSettingsSection } from './settings/mount';

/** 宿主提供的客户端服务（cordis fiber inject）。
 * remote.agentPresets：官方客户端 Agent presets 页同款通道（官方组件
 * 自身也静态注入它，客户端恒在；缺失时 roster 读失败 → 下拉退化为空）。 */
export const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.agentPresets'];

/**
 * 挂载插件。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: ClientContext): void {
  mountSettingsSection(ctx);
}
