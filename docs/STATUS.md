# AimSpan current implementation and verification

Updated: 2026-10-18. Product scope: [PRODUCT](PRODUCT.md). Structure: [ARCHITECTURE](ARCHITECTURE.md). Unfinished work: [ROADMAP](ROADMAP.md). This file records observed results and their verification level.

## Implemented

- Retired features removed from code, protocol and UI (model follow-up, context/goal editing, direction checks, handoff, in-app approval, Hook server, credentials, direct delivery). Legacy tables and rows are kept.
- Claude source: live registry (`~/.claude/sessions/<pid>.json`, epoch-ms `statusUpdatedAt`), transcripts with bounded header/tail reads plus backward chunked reads (≤8 MiB) for long turns, subagent files folded into the parent, redaction of commands and messages.
- Codex source: `.jsonl` and `.jsonl.zst` rollouts (streamed zstd decompression), turn events, `UserMessage`/`AgentMessage`, `FileChange`, `CommandExecution`, `session_index.jsonl` titles, subagent threads folded.
- Session state (running / waiting / idle / unknown), first-observation baseline (history counts as seen), automation sessions (`codex_exec`, Claude SDK entrypoints) kept out of the active set, user-interrupted turns idle.
- Ideas with inbox, pending / brought / discarded with undo, legacy memo import, legacy JSON export.
- Catch-up projection (anchor, turns since anchor, last reply, errors, changed files, failed commands, incomplete-facts flag) and bring-back formatter.
- Tray panel with counts, session list and catch-up card (sanitized Markdown), bring-back to clipboard plus native open.
- Global-shortcut quick capture window (⌘⇧Space default), IME-safe Enter, text preserved across target switches, open-ID-guarded saves, focus return, target chips with ⌘1–⌘5 and ⌘↑ / ⌘↓ navigation.
- Floating bubble: edge snap with half-hide inside the screen beside the Dock, hover intent, compact list, focus-free pinning, Do Not Disturb, popover placement according to the bubble's half of the display.
- Notifications: ≥2-minute turn ends and registry waiting entries, each kind at most once per turn, persisted across restarts, default off while the bubble is on.
- Result-first catch-up card with recent activity, adaptive primary action and collapsed history; row state markers and time wording; one-row header, keyboard navigation and grouped “All” view.
- Incremental following of long Codex rollouts with filename-UUID identity; internal and child threads hidden; explicit “✓ Mark handled”, surface tags, compact pinning and in-place actions, and semi-automatic new sessions from ideas.
- English-default interface with English and Simplified Chinese catalogs, a Settings language switch, localized native messages, time and count wording, and preserved user text.
- Shared light/dark design tokens for the panel, capture, bubble and compact list, with contrast regression coverage.
- Static English and Chinese website pages and a bilingual 404 page; deployment and browser verification remain separate from local source checks.

## Checks

| Check | Observed result | Level |
| --- | --- | --- |
| `pnpm verify` | Passed: 8 hygiene tests, 228 Core and 365 Desktop tests, typechecks and builds | Synthetic fixtures; regression evidence |
| `pnpm check:repo` | Passed: Markdown allowlist, privacy patterns, local links to tracked files, no CJK outside the zh-CN catalog and tests | Tracked tree |
| `pnpm verify:smoke` | Passed: Core restart; Electron lifecycle (idea save/restart, catch-up viewed marker, bring-back status and clipboard, quick capture through the shortcut handler with Enter save and restart, bubble half-hide/hover/compact list, session and inbox capture) in the English default | Electron 44.0.0 / Node 24.18.1, private profile, fixture sources, native opens recorded rather than launched |
| Internationalization | Catalog key/type parity and English/Chinese rendering covered by the Desktop suite; switching 中文/English in Settings updated the bubble label, `<html lang>`, panel, compact list and quick capture live, without restart | Automated tests plus an isolated-profile run with Electron `capturePage` |
| Interface redesign | Contrast tests for light and dark tokens; `pnpm screenshots` renders the panel, compact list, quick capture and settings from synthetic sessions in English, Chinese and dark (`docs/images/`) | Synthetic data only |
| Website | English, Chinese and 404 pages rendered with Electron at 1280 px (light and dark) and 390 px (no horizontal scroll); relative links and assets resolve under the `/aimspan/` base | Local rendering; Pages deployment not yet run |
| Packaged app | `pnpm package:local-mac` built an ad-hoc-signed `AimSpan.app`; `codesign --verify --deep --strict` passed and the lifecycle smoke passed against the packaged executable | Local trial package; no notarization or updater |
| Real native sources | Verified against real local Claude Code and Codex data on the maintainer's Mac; read-only. Parsing recovered turn state, replies, changed files, failed commands and errors, including compressed Codex records | Earlier parsing and state checks; not rerun here; no real records included in the repository |
| Active set and incremental discovery | Earlier real-data checks covered first-observation baselines, automation exclusion, running-session identity while children write, appended-byte following, state changes after native events, and hidden internal threads | Earlier isolated-profile, read-only observations; current regression coverage uses synthetic sources; no general latency guarantee |
| Legacy import and recovery | Earlier read-only import into a temporary profile was repeated and restarted without duplicates or changes to the legacy source; the current Core suite passed synthetic preservation and import/export tests | Earlier real local data check plus current fixture regressions; no personal database contents or usage counts published |
| Bubble, compact list and catch-up UI | Earlier isolated-profile checks exercised popovers beside a side Dock, pin/unpin without closing the list, consistent tray/bubble counts, result-first cards, capture target selection, and light/dark surfaces | Earlier local observations, including simulated interaction; not a current visual acceptance result |
| Native-source preservation | Earlier read-only checks used isolated AimSpan profiles; current Core source-boundary and retention regressions passed. AimSpan's authority remains read-only for native agent directories | Earlier local verification plus current synthetic safeguards; no current native configuration timestamp audit |

## Not verified

- Real global-shortcut key press, real Chinese IME composition, real focus return to the previous app, and tray clicks — exercised only through the smoke harness.
- Bring-back opening the real Codex thread (`codex://threads/<id>`) or Claude.app; clipboard writes in the user's session.
- Bubble on multiple displays, display removal, full-screen Spaces; native notification display and click.
- `claude://code/continue?session=<id>`; Claude registry waiting values other than `busy`/`idle` were not observed.
- Long-term use with a dozen real parallel sessions.
- Website browser rendering, GitHub Pages deployment, hosted link availability, and a published download.

## Data and recovery

The legacy database remains separate from `companion.sqlite3`, with a consistent backup before idempotent import. Settings can export legacy tables as JSON. User databases, credentials, local backups and recovery exports stay outside tracked source.
