---
name: release
description: Cut a new release of dsh-imessage — bump both package versions, write the CHANGELOG entry, then hand the mechanical steps to CI. Use when the user asks to release, publish, ship, bump the version, or cut a new version (e.g. "发版", "发布新版本", "release 0.2.0").
---

# Release dsh-imessage

Two packages ship together and must share one version:
`@chenchenyaqi/dsh-imessage` (root) and `@chenchenyaqi/dsh-imessage-preset` (`preset/`).

This skill has exactly **one stop point**: after drafting the version number and the
CHANGELOG entry, present both and wait for the user's approval. Everything after
approval runs without further questions.

## Prerequisites (one-time, already done for this repo)

`.github/workflows/release.yml` publishes with **npm Trusted Publishing (OIDC)** — no
`NPM_TOKEN` secret exists. Both packages must have the publisher configured on npm:

```
npmjs.com → package page → Settings → Trusted Publishing → Add
  Publisher:          GitHub Actions
  Organization:       ChenChenyaqi
  Repository:         dsh-imessage
  Workflow filename:  release.yml
  Environment:        (leave empty)
```

If a publish fails with 403, check this binding before suspecting the code. Also
note the workflow needs Node 24 in the publish job: Trusted Publishing requires
npm >= 11.5.1, and Node 22 ships npm 10.

## 0. Preflight

```bash
git status --porcelain          # must be empty; otherwise ask the user first
git switch main && git pull --ff-only
git describe --tags --abbrev=0  # last released tag, e.g. v0.1.0
gh pr list --state open         # note any open PRs; they will not be in this release
pnpm check                      # must be green before anything else
```

Also confirm CI is green on `main`:

```bash
gh run list --workflow=ci.yml --branch main --limit 1
```

If any of these is not clean, stop and report. Do not release on top of a red `main`.

## 1. Inspect what changed since the last tag

```bash
git log <last-tag>..HEAD --oneline --no-merges
git log <last-tag>..HEAD --format='%h %s%n%b' | grep -iE '!|BREAKING CHANGE' || true
```

Read the actual diffs of user-facing changes when the commit subjects are not
self-explanatory — the CHANGELOG should describe behaviour, not echo commit titles.

## 2. Decide the version

Default: **patch +1** on the current `package.json` version (`0.1.0` → `0.1.1`).

Deviate only in these cases:

| Situation | Version |
|---|---|
| User explicitly names a version | use theirs, verbatim |
| A commit carries `!` or `BREAKING CHANGE` | flag it and propose **minor** (0.2.0); ask before using it |
| Only docs/CI/deps changed, nothing user-visible | still patch +1, but say so in the proposal |

`0.x` is pre-1.0: breaking changes are allowed to ride a minor bump. Never reuse a
version that already exists on npm — check with `npm view <pkg> versions` if unsure.

## 3. Draft the CHANGELOG entry

Edit `CHANGELOG.md`:

1. Move everything currently under `## [Unreleased]` into the new section (leave
   `## [Unreleased]` in place and empty).
2. Insert the new section directly below `## [Unreleased]`:

```markdown
## [0.1.1] - 2026-11-20

一句话说清这一版是什么。

### Added

- ...
```

Style rules — this file is project history, not a commit dump:

- **Chinese prose.** Match the tone of the existing `0.1.0` section.
- One bullet per change, written as a full statement of *what a user gets* and
  *why it matters*. Explain the tradeoff when there was one.
- Use `### Added` / `### Changed` / `### Fixed` / `### Removed`; skip headings
  that have no entries.
- Collapse CI, tooling and dependency chores into at most one short bullet, or
  omit them. Dependabot bumps normally do not belong here.
- Do not paste commit subjects, PR numbers, or `Co-authored-by` trailers.
- Use today's real date (`date +%F`), not a placeholder.

## 4. STOP — present and wait

Show the user, in this order:

1. The proposed version and the rule used to pick it (patch/minor/explicit).
2. The full new CHANGELOG section, verbatim.
3. A one-line note listing anything you deliberately left out (chores, deps).

Then **stop**. Do not bump `package.json`, do not commit, do not create a branch.
Wait for explicit approval of both the version number and the CHANGELOG text.
If the user edits either, re-present before continuing.

## 5. Bump both versions

```bash
VERSION=0.1.1   # the approved version
node -e "const f='package.json';const p=JSON.parse(require('fs').readFileSync(f));p.version='$VERSION';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
node -e "const f='preset/package.json';const p=JSON.parse(require('fs').readFileSync(f));p.version='$VERSION';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
node scripts/check-release-versions.mjs "v$VERSION"   # must print "verified"
git diff --stat   # exactly 2 package.json + CHANGELOG.md, nothing else
```

The consistency check is the guard rail — if it fails, fix the versions, do not
work around it.

## 6. Commit and open the PR

`main` is protected by a ruleset: direct pushes are rejected, PRs need the `gate`
check to pass.

```bash
git switch -c release/v$VERSION
git add package.json preset/package.json CHANGELOG.md
git commit -m "chore(release): v$VERSION"
git push -u origin release/v$VERSION
node scripts/release-notes.mjs "$VERSION" --out /tmp/release-notes.md
gh pr create --title "chore(release): v$VERSION" --body-file /tmp/release-notes.md
gh pr checks --watch          # wait for check (22), check (24), gate all green
gh pr merge --squash --delete-branch
git switch main && git pull --ff-only
```

If a check fails: read the failure, fix it on the release branch, push again.
Never bypass the gate, never force-push `main`.

## 7. Create the GitHub Release

This is the trigger for the publish workflow. Release notes are extracted from the
CHANGELOG, so there is only one source of truth.

```bash
node scripts/release-notes.mjs "$VERSION" --out /tmp/release-notes.md
gh release create "v$VERSION" --title "v$VERSION" --notes-file /tmp/release-notes.md
```

Prefer `--out` + `--notes-file` over shell process substitution — it works the same
in any shell.

A **draft** release does not trigger anything; `gh release create` publishes
immediately, which is what we want.

## 8. Verify the publish

```bash
gh run list --workflow=release.yml --limit 1
gh run watch <run-id>          # or: gh run view <run-id> --log-failed
```

A green run means both `npm publish` calls exited 0 — that **is** the success signal.
Do not treat `npm view` as the verdict: npm answers a successful publish with
"being processed and may take a few minutes", and propagation time is not fixed.
Querying immediately fails, and a check that fails on a healthy publish is worse
than no check at all (it invites a re-run, which then hits "version already").

To confirm availability later — minutes to an hour, on your own schedule:

```bash
curl -s "https://registry.npmjs.org/@chenchenyaqi%2Fdsh-imessage" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['dist-tags'])"
```

Query the registry directly rather than `npm view`; the CLI adds its own cache on
top of the propagation delay. Report to the user: version, workflow URL, and the
provenance badge (`attestations` present on the registry document).

## Failure handling

The publish workflow is **not idempotent**. `npm publish` fails if the version
already exists, so a re-run after a partial success will fail on the package that
did go out.

| Failure point | Action |
|---|---|
| Workflow red **but the log shows `+ <pkg>@<version>`** for a package | not a failure — registry propagation lag. Never re-run; nothing to fix |
| Before either `npm publish` (install/build/version check) | fix and `gh run rerun <id>` — nothing was published |
| Main package published, preset failed | do **not** re-run the whole workflow; publish only the missing one locally (`npm publish --provenance ./preset`), then verify |
| Workflow itself wrong (bad step) | fix `.github/workflows/release.yml` in a normal PR, then re-run the failed job |
| Package published with a wrong version | cannot be undone after 24h. Publish a corrected higher version; report to the user immediately |

Never delete or move a pushed tag that has already triggered a publish.

## Hard rules

- One stop point only: the version + CHANGELOG approval in step 4.
- Never edit an already-released CHANGELOG section; add a new one.
- Never touch `src/` in a release PR — if code needs fixing, that is a separate PR
  merged before the release.
- Commit messages: Chinese subject, never starting with an uppercase English word.
- Do not `git push` to `main` and do not bypass the ruleset, even if it looks faster.
