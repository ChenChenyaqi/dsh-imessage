# 发版流程

维护者操作手册。CHANGELOG 手写，tag / Release notes / npm 发布自动化。

## 一次性配置

npm 上两个包各配一次 Trusted Publisher（OIDC，不存 token）：

```
npmjs.com → 包页 → Settings → Trusted Publishing → Add
  Publisher:          GitHub Actions
  Organization:       ChenChenyaqi
  Repository:         dsh-imessage
  Workflow filename:  release.yml
  Environment:        （留空）
```

没配这个，`.github/workflows/release.yml` 跑到 `npm publish` 会 403。

## 发版五步

```bash
# 1. 升版本：两个 package.json 必须一致
#    package.json              version: 0.2.0
#    preset/package.json       version: 0.2.0

# 2. 写 CHANGELOG：把 [Unreleased] 内容归入新版本段
#    ## [0.2.0] - 2026-11-20

# 3. 提交门 + 走 PR（main 有 ruleset，直推不动）
pnpm check
git switch -c release/v0.2.0
git commit -am "chore(release): v0.2.0"
gh pr create --title "chore(release): v0.2.0" --body "..."
gh pr merge --squash --delete-branch

# 4. 建 Release（自动打 tag，触发发布 workflow）
git switch main && git pull
gh release create v0.2.0 --title "v0.2.0" \
  --notes-file <(node scripts/release-notes.mjs 0.2.0)

# 5. 核对
gh run watch                 # workflow 绿
npm view @chenchenyaqi/dsh-imessage version
npm view @chenchenyaqi/dsh-imessage-preset version
```

`release-notes.mjs` 把 CHANGELOG 里该版本的正文抽出来复用，两处说法不会分叉。

## workflow 做了什么

`.github/workflows/release.yml` 在 Release 发布（`published`，草稿不算）时：

1. `check-release-versions.mjs`：校验 tag、主包、preset 三者版本一致
2. `pnpm build`
3. `npm publish --provenance`（主包）
4. `npm publish --provenance ./preset`
5. 轮询 `npm view` 确认可解析

## 三个坑

**版本号发出去就收不回。** npm 允许 24 小时内 unpublish，之后该版本号永久占用，只能发新版覆盖。第 1 步的校验就是为了让它停在发布之前——报错说明版本没对齐，不是脚本坏了。

**必须用 `npm publish`，不能用 `pnpm publish`。** pnpm 的 OIDC 支持有已知故障（pnpm#11513），而 `pnpm publish` 底层调的也是 npm。代价是 publish job 固定 Node 24（npm ≥ 11.5.1）。

**草稿 Release 不触发 workflow。** 必须点 Publish release。

## preset 包

`preset/` 是独立包（无 workspace），发布时 `npm publish ./preset`。版本必须与主包一致——`check-release-versions.mjs` 会拦。它只含 `cordis.patch.yml`（大肥鱼人格预设），改动通常随主包一起走。
