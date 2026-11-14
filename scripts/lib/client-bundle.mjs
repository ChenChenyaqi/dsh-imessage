// 客户端半身的构建：把浏览器入口打成 DSH 的 closure-factory 产物。
//
// DSH 事实（packages/client/modules/src/client/manifest.ts）：
// 浏览器端不是普通 ESM，而是惰性 CJS 表——脚本执行时只登记工厂
// `window.__ModuleLoader__.load({ id, factory })`，真正求值发生在
// materialize（factory(require) → exports）。宿主共享的平台模块
// （react / cordis / primitives ...）由注入的 require 解析，绝不能
// 打进产物，否则会出现第二份 React 实例。
//
// 因此这里：esbuild 打 CJS（externals 保持 require 调用）→ 再把整段
// 代码包进 factory 闭包。

import { build } from 'esbuild';

/** 由宿主模块表共享的依赖（PLATFORM_MODULES 的子集，我们实际用到的）。 */
export const PLATFORM_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
];

/**
 * 把一段 CJS 代码包成模块加载器登记的工厂。
 * @param options.id - 模块 id（等于包名，宿主按包名解析客户端行）。
 * @param options.code - esbuild 产出的 CJS 代码。
 * @returns 可直接被浏览器执行的脚本文本。
 */
export function wrapClientFactory({ id, code }) {
  return `window.__ModuleLoader__.load({
  id: ${JSON.stringify(id)},
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    (function (module, exports, require) {
${code}
    })(module, exports, require);
    return module.exports;
  },
});
`;
}

/**
 * 构建客户端入口。
 * @param options.root - 仓库根目录。
 * @param options.outfile - 产物路径（lib/client.js）。
 * @returns 产物路径与包 id。
 */
export async function buildClientBundle({ root, outfile }) {
  const { readFileSync, writeFileSync, existsSync, rmSync } = await import('node:fs');
  const { resolve, join, dirname } = await import('node:path');
  // 客户端入口可能是 .ts 或 .tsx（有 JSX 时）
  const candidates = ['index.ts', 'index.tsx'].map((f) => resolve(root, 'src/client', f));
  const entryPoint = candidates.find((path) => existsSync(path));
  if (entryPoint === undefined) {
    throw new Error(`client bundle: no client entry under ${resolve(root, 'src/client')}`);
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const result = await build({
    entryPoints: [entryPoint],
    tsconfig: resolve(root, 'tsconfig.json'),
    bundle: true,
    // CJS：让 externals 变成 require(...) 调用，交给注入的 require
    format: 'cjs',
    platform: 'browser',
    target: ['es2022'],
    jsx: 'automatic',
    external: PLATFORM_EXTERNALS,
    // 浏览器端不允许 node 内置（platform: browser 已在解析期拦截）
    outfile: join(dirname(outfile), '.client.tmp.js'),
    sourcemap: false,
    legalComments: 'none',
  });
  if (result.errors.length > 0) {
    throw new Error(`client bundle failed: ${result.errors.map((e) => e.text).join('; ')}`);
  }
  const code = readFileSync(join(dirname(outfile), '.client.tmp.js'), 'utf8');
  writeFileSync(outfile, wrapClientFactory({ id: pkg.name, code }), 'utf8');
  rmSync(join(dirname(outfile), '.client.tmp.js'), { force: true });
  return { outfile, id: pkg.name };
}
