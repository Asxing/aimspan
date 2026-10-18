# AimSpan repository guidance

AimSpan is a macOS companion for people running several long Codex/Claude sessions. It does three things: show which sessions are active, capture ideas per session in seconds while an Agent works, and show a catch-up card (what happened since you left + your ideas) when you switch back. Users keep working in their existing apps. Follow [PRODUCT](docs/PRODUCT.md) for behavior; anything not described there is out of scope.

## Stack

Electron 44 + React, TypeScript everywhere, pnpm workspaces, SQLite via `node:sqlite`, Vitest for desktop and `node --test` for packages. Node ≥22.19.

## Ownership

- `packages/core`: the only SQLite writer, Claude/Codex source adapters, session state, ideas, catch-up projection, legacy import/export, background process.
- `packages/protocol`: shared request/projection types and runtime validators.
- `apps/desktop/src/main`: Electron lifecycle, tray, panel/capture/bubble windows, global shortcuts, notifications, clipboard and native deep links.
- `apps/desktop/src/preload`: one narrow interface per window kind.
- `apps/desktop/src/renderer`: panel list and catch-up card, capture box, bubble and compact list; no direct database, file or network access.

## Rules

1. Observe only. No model calls, credentials, Hook servers, native request answering or message delivery. Bringing ideas back = clipboard + opening the native app after an explicit click.
2. Never write `~/.claude` or `~/.codex`. Native sources are read-only, bounded, redacted, and never mirrored in full. Never read Claude registry `*.key` files.
3. Session identity is device + agent + native ID; equal title or directory never merges sessions. Unknown state stays unknown and never clears data.
4. Ideas are user text, stored verbatim; only an explicit purge of a discarded idea deletes one. Removing a feature never deletes user or legacy data.
5. Mutations carry operation IDs and revisions; replays are idempotent.
6. Fixtures are synthetic. Use the `__aimspan_fixture__` user sentinel instead of real home paths; never commit real transcripts, databases or generated runtime data.
7. Do not modify `docs/STATUS.md` claims without actually running the check described.

## Off limits unless the task says otherwise

`scripts/check-repo-hygiene*.mjs`, `scripts/package-local-mac.mjs`, brand assets, lockfile changes beyond added/removed dependencies, and anything outside this repository.

## Documentation

One owner per fact: PRODUCT for behavior and UI, ARCHITECTURE for structure and native source formats, CORE-PROTOCOL for interfaces, docs/SECURITY for data and authority, ROADMAP for unfinished work, STATUS for measured results, CONTRIBUTING for contributor setup, and root SECURITY for vulnerability reporting. Update the owner; do not add plans, diaries or backup documents.

## Completion

Run `pnpm verify`, the relevant `pnpm verify:smoke` cases and `git diff --check`. Inspect the complete diff for unrelated files. Report behavior only at the level actually tested; a successful build is not an end-to-end result.
