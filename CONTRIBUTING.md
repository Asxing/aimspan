# Contributing to AimSpan

Read [AGENTS.md](AGENTS.md), [Product](docs/PRODUCT.md), [Architecture](docs/ARCHITECTURE.md) and the [security design](docs/SECURITY.md) before making changes. Product defines the supported behavior; discuss scope changes in an issue before implementing them.

## Setup

Use macOS, Node.js ≥22.19 and pnpm 11.24.0. From a checkout, with Corepack available:

```bash
corepack enable
corepack prepare pnpm@11.24.0 --activate
pnpm install
pnpm build
pnpm dev
```

The workspace contains the Electron/React desktop app, the TypeScript Core and the shared protocol. Core is the only SQLite writer. Renderers use narrow preload interfaces and must not access files, databases or the network directly.

## Checks

Before submitting a pull request, run:

```bash
pnpm verify
pnpm verify:smoke
git diff --check
```

Inspect the complete diff for unrelated files. Explain which checks ran and any failures. A build or fixture-based smoke test does not prove native app navigation or real user interactions; keep verification claims at the level actually tested. Only update [Status](docs/STATUS.md) after running the check it describes.

## Repository rules

- **Observe only.** No model calls, credentials, hook servers, native request answering or message delivery. Bringing ideas back means clipboard plus native app opening after an explicit user action.
- **Never write to `~/.claude` or `~/.codex`.** Read only supported records with bounds and redaction; never read Claude registry `*.key` files or mirror entire transcripts.
- **Preserve identity and uncertainty.** A session is identified by device, agent and native ID. Matching titles or directories do not merge sessions. Unknown source state must not clear stored data.
- **Preserve user text and data.** Store ideas verbatim. Only an explicit purge of an already discarded idea deletes it. Removing a feature must not delete user or legacy data.
- **Make mutations replay-safe.** Carry operation IDs and revisions; retries must be idempotent.
- **Use synthetic fixtures only.** Use the `__aimspan_fixture__` user sentinel. Never include real transcripts, databases, credentials or generated runtime data in tests, commits or issues. Screenshots and reproduction examples must use synthetic data too.
- **Keep documentation ownership clear.** Update the canonical document for each fact; do not add implementation diaries, backup documents or duplicate plans. Respect the protected areas in AGENTS.md.

## UI strings

Every user-visible UI string must go through `apps/desktop/src/shared/i18n/`, with entries for both `en` and `zh-CN`. This includes menu items, notifications, dialogs, errors and renderer text. Keep the two locales aligned and exercise the affected UI in both languages; avoid hard-coded strings in components or main-process code.

## Commits and pull requests

Follow the existing commit style: `type(scope): concise description`, with the scope optional. Examples: `fix(core): preserve unknown session state`, `feat(desktop): improve quick capture`, `docs: clarify source support`. Use a focused commit for one coherent change.

Describe the problem, resulting behavior and validation in the pull request. Include synthetic screenshots for visible changes and report unverified behavior explicitly. Use [private vulnerability reporting](SECURITY.md) for security issues rather than a public bug report.
