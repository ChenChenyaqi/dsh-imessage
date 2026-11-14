// 发布脚本的类型声明（scripts/lib/release.mjs 是 ESM JS，
// 供发版 workflow 与测试共用；这里只声明对外契约）。

/** 把 git tag 归一成版本号，非法 tag 抛错。 */
export declare function parseTagVersion(tag: string): string;

/** 校验 tag、主包、preset 三者版本一致，不一致抛错。 */
export declare function assertVersionConsistency(input: {
  tag: string;
  rootVersion: string;
  presetVersion: string;
}): { version: string };

/** 从 CHANGELOG 抽出某版本正文（不含标题行），缺失或为空抛错。 */
export declare function extractChangelogSection(changelog: string, version: string): string;
