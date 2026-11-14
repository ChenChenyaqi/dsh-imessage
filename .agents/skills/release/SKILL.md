---
name: release
description: Cut a new release of dsh-imessage — bump both package versions, write the CHANGELOG entry, tag, then let CI publish. Use when the user asks to release, publish, ship, bump the version, or cut a new version (e.g. "发版", "发布新版本", "release 0.2.0").
---

# Release dsh-imessage

Two packages ship together with one shared version: `@chenchenyaqi/dsh-imessage`
(root) and `@chenchenyaqi/dsh-imessage-preset` (`preset/`).

One stop point only: the version number and the CHANGELOG entry. Everything before
it is preparation; everything after approval runs through without asking.

## Prerequisites

`.github/workflows/release.yml` publishes via npm Trusted Publishing (OIDC) — no
`NPM_TOKEN` exists. Both packages are already bound to: GitHub Actions /
`ChenChenyaqi` / `dsh-imessage` / `release.yml` / no environment, with
`Allow npm publish` checked. A 403 on publish means that binding is wrong — check
it before suspecting the code.

## 0. Preflight

```bash
git status --porcelain          # must be empty
git switch main && git pull --ff-only
git describe --tags --abbrev=0  # last released tag
gh pr list --state open
pnpm check
gh run list --workflow=ci.yml --branch main --limit 1   # must be success
```

Stop and report if anything is dirty or red.

## 1. Read the change set

```bash
git log <last-tag>..HEAD --oneline --no-merges
git log <last-tag>..HEAD --format='%h %s%n%b' | grep -iE 'BREAKING|!:' || true
git diff --stat <last-tag>..HEAD -- src/ preset/
```

If `src/` and `preset/` are empty, say so explicitly — the next release then
differs from the previous one only in build output.

## 2. Pick the version

Default: **patch +1**.

| Situation | Version |
|---|---|
| User names a version | theirs, verbatim |
| A commit has `!` or `BREAKING CHANGE` | propose **minor**, ask first |
| Only docs/CI/deps changed | still patch +1, state it in the proposal |

Never reuse a version already on npm (`npm view <pkg> versions`).

## 3. Draft the CHANGELOG entry

In `CHANGELOG.md`: move the current `## [Unreleased]` content into a new section
directly below it, leaving `## [Unreleased]` in place and empty.

```markdown
## [0.1.1] - 2026-11-20

一句话说清这一版是什么。

### Added
```

Rules: Chinese, full sentences about what a user gets; `### Added` / `### Changed` /
`### Fixed` / `### Removed` only when non-empty; CI and dependency chores collapse
into at most one bullet or get omitted; no commit subjects, PR numbers, or trailers;
today's real date.

## 4. STOP

Present, then wait:

1. Version + the rule that picked it.
2. The new CHANGELOG section, verbatim.
3. One line naming what you left out.

Do not touch `package.json`, do not branch, do not commit until the user approves
both. Re-present after any edit.

## 5. Bump both versions

```bash
VERSION=0.1.1
node -e "const f='package.json';const p=JSON.parse(require('fs').readFileSync(f));p.version='$VERSION';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
node -e "const f='preset/package.json';const p=JSON.parse(require('fs').readFileSync(f));p.version='$VERSION';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
node scripts/check-release-versions.mjs "v$VERSION"   # must print "verified"
git diff --stat                                       # exactly 3 files
```

## 6. PR

`main` is ruleset-protected: PR + `gate` required, no direct pushes.

```bash
git switch -c release/v$VERSION
git add package.json preset/package.json CHANGELOG.md
git commit -m "chore(release): v$VERSION"
git push -u origin release/v$VERSION
node scripts/release-notes.mjs "$VERSION" --out /tmp/release-notes.md
gh pr create --title "chore(release): v$VERSION" --body-file /tmp/release-notes.md
gh pr checks --watch
gh pr merge --squash --delete-branch
git switch main && git pull --ff-only
```

A failing check means fix it on the branch and push again — never bypass the gate.

## 7. Tag and Release

```bash
git tag -a "v$VERSION" -m "v$VERSION — <one-line summary>"
git push origin "v$VERSION"
gh release create "v$VERSION" --verify-tag --title "v$VERSION" --notes-file /tmp/release-notes.md
```

Annotated tag, created locally, never left to `gh`: it pins the tag to a commit you
can see and records tagger, date and message. `--verify-tag` fails loudly instead of
letting GitHub invent a lightweight tag on the remote HEAD.

`gh release create` publishes immediately and is what triggers the workflow; a
**draft** release triggers nothing.

## 8. Confirm

```bash
gh run list --workflow=release.yml --limit 1
gh run watch <run-id>
```

Green means both `npm publish` calls exited 0 — that is the success signal. Do not
judge by `npm view`: npm answers a healthy publish with "being processed and may
take a few minutes", and propagation time is not fixed. To check availability later,
query the registry directly (`curl -s https://registry.npmjs.org/@chenchenyaqi%2Fdsh-imessage`),
not `npm view`, which adds its own cache.

Report: version, workflow URL, provenance attestations present.

## Failure handling

The publish workflow is **not idempotent**.

| Failure point | Action |
|---|---|
| Log shows `+ <pkg>@<version>` but the run is red | propagation lag, not a failure — never re-run |
| Before either `npm publish` (install/build/version check) | fix and `gh run rerun <id>` |
| Main package out, preset failed | publish only the missing one locally (`npm publish --provenance ./preset`) |
| Tag pushed but Release creation failed | tag is harmless; re-run `gh release create --verify-tag` only |
| Wrong version published | cannot be undone after 24h — publish a corrected higher version, tell the user |

Never delete or move a pushed tag that already triggered a publish.

## Hard rules

- One stop point only: the version + CHANGELOG approval in step 4.
- Never edit an already-released CHANGELOG section; add a new one.
- Never touch `src/` in a release PR.
- Chinese commit subjects, never starting with an uppercase English word.
- No direct pushes to `main`, no bypassing the ruleset.
- Annotated tags only; never let `gh` create the tag.
