// 插件业务配置的纯类型与默认值（D9）。
//
// 实际的读取、校验、存储都走 DSH 官方体系：host 层导出 Schemastery
// schema → cordis 加载时校验并填默认值 → 存 DSH profile，设置页自动
// 生成表单。本文件只提供 core 层消费的类型形状与默认值常量，
// 不做重复校验（schema 已在边界把关）。

/** 插件配置（apply(ctx, config) 收到的形状）。 */
export interface PluginConfig {
  /** 白名单原始条目（带区号号码或邮箱）。运行时经 makePolicy 归一化，
   *  非法条目静默丢弃（D9 约定）。默认空 = 全拒。 */
  readonly allowlist: readonly string[];
  /** 界面语言（D6：zh/en 起步）。 */
  readonly locale: 'zh' | 'en';
  /** chat.db 轮询间隔（毫秒）。 */
  readonly pollIntervalMs: number;
}

/** 各字段默认值（Schemastery schema 的 default 与此保持一致）。 */
export const DEFAULT_CONFIG: PluginConfig = Object.freeze({
  allowlist: [],
  locale: 'zh',
  pollIntervalMs: 2000,
});
