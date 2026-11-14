// 构建脚本的类型声明（scripts/lib/client-bundle.mjs 是 ESM JS，
// 供 build.mjs 与测试共用；这里只声明对外契约）。

/** 由宿主模块表共享的依赖清单。 */
export declare const PLATFORM_EXTERNALS: readonly string[];

/** 把 CJS 代码包成模块加载器登记的工厂。 */
export declare function wrapClientFactory(options: {
  id: string;
  code: string;
}): string;

/** 构建客户端入口，返回产物路径与包 id。 */
export declare function buildClientBundle(options: {
  root: string;
  outfile: string;
}): Promise<{ outfile: string; id: string }>;
