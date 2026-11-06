**English** | [中文](./README.md)

# dsh-imessage

> A native cordis plugin that bridges macOS iMessage into DeepSeek Harness (DSH):
> inbound via read-only `chat.db` polling; outbound via osascript-driven Messages.app.
> Your messages never leave your Mac.

![node](https://img.shields.io/badge/node-%E2%89%A522-339933) ![dsh](https://img.shields.io/badge/DeepSeek%20Harness-0.2.x-4D6BFE) ![typescript](https://img.shields.io/badge/TypeScript-5.9-3178C6) ![license](https://img.shields.io/badge/license-MIT-black) ![stage](https://img.shields.io/badge/stage-M1%20skeleton-orange)

---

## Why

Existing iMessage × DSH solutions (e.g. photon-hq/dsh-imessage) take the
**cloud-hosted** route: messages pass through third-party servers, and the phone
number is a hosted one. This plugin takes the other road —

- **Native & local**: reads `~/Library/Messages/chat.db` (read-only) directly,
  sends through Messages.app automation. Chat history stays on your machine
- **Zero cloud dependency**: no third-party signup, no hosted number — your own Apple ID
- **Allowlist admission**: deny by default; only explicitly allowed phone numbers reach the bot
- **Session isolation**: one DSH session and one isolated workspace per phone number
- **Humanized output**: semantic segmentation + typing delays; code blocks go out whole, paste-style

## Architecture

```
src/
├─ core/     ← pure TS kernel (zero framework deps, independently testable)
│  ├─ imessage/   permissions · chat.db polling · typedstream decoding · normalize · send · humanize
│  ├─ routing/    gate (allowlist + idempotency) · session router · one-way pipeline
│  ├─ stores/     config/state (atomic writes)
│  └─ i18n/ log/
└─ host/     ← thin cordis adapter: apply() lifecycle · apiProxy→DshPort · management
```

The kernel defines a `DshPort` interface; the host implements it with DSH's
apiProxy — DSH interface drift only ever touches host/, never the kernel.

## Prerequisites

- macOS with iMessage signed in on Messages.app
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) desktop 0.2.x
- Two system permissions (the settings page will guide you):
  - **Full Disk Access** — required to read `chat.db`
  - **Automation (control Messages.app)** — required to send

## Roadmap

| Stage | Scope | Status |
| --- | --- | --- |
| M1 | Skeleton · types · stores · i18n · logging | 🚧 in progress |
| M2 | Rx/Tx kernel (chat.db polling / decoding / osascript / humanize) | ⏳ |
| M3 | Session routing · allowlist · idempotency · pipeline | ⏳ |
| M4 | cordis host · MVP wrap-up | ⏳ |
| P1 | Image inbox (HEIC→JPEG) · quoted replies · file sending · basic commands | ⏳ |
| P2 | Companion proactivity · stickers · settings UI | ⏳ |

See [PLAN.md](./docs/PLAN.md) (implementation plan) and [ARCHITECTURE.md](./docs/ARCHITECTURE.md) (blueprint).

## Install

> 🚧 Not published to npm yet — ships as `@chenyaqi/dsh-imessage` once MVP lands.

Then:

```sh
dsh plugin --profile desktop add @chenyaqi/dsh-imessage
```

## Development

```sh
pnpm install
pnpm check    # typecheck + lint + build + test
pnpm build    # esbuild → lib/index.js (single-file ESM)

# Smoke-test that the bundle loads inside a DSH host
dsh --profile web --patch <(echo "- insert:\n  - id: chenyaqi-dsh-imessage\n    name: '$PWD/lib/index.js'")
```

## License

[MIT](./LICENSE)
