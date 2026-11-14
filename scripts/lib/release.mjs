// 发布相关的纯逻辑（供发版 workflow 与测试共用）。
//
// 这里只做判定，不碰文件系统：CLI 薄壳（check-release-versions.mjs /
// release-notes.mjs）负责读文件、打印、退出码。分开是为了能在
// core 层单测——发版动作不可撤销，逻辑必须有测试兜着。

/** 语义化版本（含可选的预发布/构建元数据）。前导 v 可有可无。 */
const VERSION_PATTERN = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

/**
 * 把 git tag 归一成版本号。
 *
 * @param {string} tag
 * @returns {string}
 */
export function parseTagVersion(tag) {
  if (typeof tag !== 'string') {
    throw new Error(`Invalid tag: expected a string, got ${typeof tag}`);
  }
  const matched = VERSION_PATTERN.exec(tag.trim());
  if (!matched) {
    throw new Error(
      `Invalid tag "${tag}": expected a version like v1.2.3 (optionally with -prerelease).`,
    );
  }
  return matched[1];
}

/**
 * 校验 tag、主包、preset 三者版本一致。
 *
 * 不一致时抛错而不是取其一：npm 已发布的版本号 24 小时后永久占用，
 * 与其猜作者意图，不如让 workflow 停在发布之前。
 *
 * @param {{ tag: string; rootVersion: string; presetVersion: string }} input
 * @returns {{ version: string }}
 */
export function assertVersionConsistency({ tag, rootVersion, presetVersion }) {
  const version = parseTagVersion(tag);

  if (version !== rootVersion) {
    throw new Error(
      `Version mismatch: tag "${tag}" resolves to ${version} but package.json is ${rootVersion}. ` +
        'Bump package.json before creating the release.',
    );
  }

  if (presetVersion !== rootVersion) {
    throw new Error(
      `Version mismatch: preset package is ${presetVersion} but root package is ${rootVersion}. ` +
        'Both packages must be released with the same version.',
    );
  }

  return { version };
}

/**
 * 从 CHANGELOG 抽出某个版本的正文（不含 `## [x.y.z]` 标题行）。
 *
 * 版本号必须整段匹配：`[0.1.0]` 不能命中 `[0.10.0]` 或 `[0.1.0-beta.1]`，
 * 否则会把别的版本内容当成这版发布说明。
 *
 * @param {string} changelog
 * @param {string} version
 * @returns {string}
 */
export function extractChangelogSection(changelog, version) {
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error('Invalid version: expected a non-empty string.');
  }

  const wanted = version.trim().replace(/^v/, '');
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 标题行：`## [x.y.z]` 或 `## [x.y.z] - 2026-11-20`；右边界保证整段相等。
  const heading = new RegExp(`^##\\s*\\[${escaped}\\](?![\\w.-])(.*)$`, 'm');

  const matched = heading.exec(changelog);
  if (!matched || matched.index === undefined) {
    throw new Error(
      `CHANGELOG has no section for version ${wanted}. ` +
        'Add a "## [' + wanted + ']" section before releasing.',
    );
  }

  const rest = changelog.slice(matched.index + matched[0].length);
  // 下一个二级标题即本节结束；三级（###）属于本节内容。
  const nextHeading = /^##\s/m.exec(rest);
  const body = (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();

  if (body === '') {
    throw new Error(
      `CHANGELOG section for version ${wanted} is empty. ` +
        'Write what changed before releasing.',
    );
  }

  return body;
}
