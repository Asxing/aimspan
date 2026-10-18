# AimSpan architecture

Electron + React desktop app with a TypeScript background Core and SQLite. This document describes the target structure for the refocused product in [PRODUCT](PRODUCT.md); tasks still converging toward it are listed in [ROADMAP](ROADMAP.md), and measured behavior lives in [STATUS](STATUS.md).

## Runtime shape

```text
~/.claude (sessions/, projects/)     ~/.codex (sessions/, session_index.jsonl)
      │ read-only, bounded, fs.watch-triggered incremental reads
      ▼
TypeScript Core (Electron utilityProcess)
  source adapters · session state · ideas · catch-up projection · legacy import
  SQLite (single writer)
      │ typed MessagePort requests and projections
      ▼
Electron Main
  tray + panel window · capture window · bubble window · notifications
  global shortcuts · clipboard · native deep links
      │ sandboxed preloads
      ▼
React renderers: panel (list + catch-up card) · capture · bubble
```

Core is a separate Node process and the only SQLite writer. Main performs no SQL. Renderers receive projections over a narrow preload API and have no file, database or network access. No model, credential or Agent-control code exists in the active build.

## Modules

| Module | Responsibility |
| --- | --- |
| `packages/core/src/claude.ts` | Claude live registry and transcript parsing |
| `packages/core/src/codex.ts` | Codex rollout parsing (`.jsonl` and `.jsonl.zst`) and title index |
| `packages/core/src/adapters.ts` | Discovery orchestration, bounded reads, fs.watch, incremental cache, diagnostics |
| `packages/core/src/store.ts` | SQLite schema, sessions, ideas, view markers, active-set rules, idempotency, legacy import/export |
| `packages/core/src/catchup.ts` | Catch-up projection from stored observations and the session anchor |
| `packages/core/src/worker.ts` | Serialized request handling and projection publishing |
| `packages/protocol` | Shared types and runtime request validators |
| `apps/desktop/src/main` | Lifecycle, tray, panel/capture/bubble windows, shortcuts, notifications, deep links |
| `apps/desktop/src/preload` | One narrow preload per window kind |
| `apps/desktop/src/renderer` | Panel list and catch-up card, capture box, bubble and compact list |
| `apps/desktop/src/shared/i18n` | English and Simplified Chinese catalogs, typed lookups, message references and localized errors shared by Main and renderers |

`packages/supervisor`, `packages/agent-runtime`, credential storage, Codex WebSocket delivery and the Hook server are absent from the active build. Local legacy user data remains available through the backup and export described below.

## Native sources

All reads are read-only, regular-file, size/entry/depth bounded and redacted before storage. AimSpan never writes `~/.claude` or `~/.codex`.

### Claude (`~/.claude`)

- **Live registry** `sessions/<pid>.json`: `pid, sessionId, cwd, entrypoint, kind, status, statusUpdatedAt, name`. Primary signal for running/waiting. A registry file whose `pid` is no longer alive is stale and ignored. Do not read the sibling `*.key` files.
- **Transcripts** `projects/<cwd-slug>/<sessionId>.jsonl`. CLI and desktop Code-tab sessions share this store (`entrypoint` is `cli`, `claude-desktop`, `claude-vscode`, `sdk-cli`).
  - Prompt: `type: "user"` record that is not meta/injected and is not a tool result.
  - Turn end: `assistant.message.stop_reason === "end_turn"`; `type: "system"` with `subtype: "turn_duration"` carries `durationMs`.
  - Errors: `system` `subtype: "api_error"`.
  - Away summary: `system` `subtype: "away_summary"`.
  - Titles: `custom-title` > `ai-title` > first prompt.
  - Changed files: `tool_use` blocks in `assistant.message.content[]` named `Edit`, `Write`, `MultiEdit`, `NotebookEdit` with `input.file_path`.
  - Failed commands: `Bash` tool_use whose following `toolUseResult` is an error or interrupted.
  - Subagents: `isSidechain: true` records are folded into the parent.

### Codex (`~/.codex`)

- **Rollouts** `sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl[.zst]`; most are zstd-compressed and decoded with Node's built-in zlib zstd. `archived_sessions/` is listed under “All” only.
- `session_meta`: `id`, `cwd`, `originator`, `source`, `thread_source`. A thread is a child when `thread_source` is present and not `user` (seen: `subagent`, `guardian_review`) or `source.subagent` is present; its parent is `source.subagent.thread_spawn.parent_thread_id` or the top-level `parent_thread_id`. Children are folded into the parent and never listed, even when the parent is not observed.
- Turns: `event_msg` `task_started` (`turn_id`, `started_at`), `task_complete` (`turn_id`, `completed_at`, `duration_ms`, `last_agent_message`), `turn_aborted` (`reason`).
- Prompts: `event_msg` `item_completed` with `item.type` `UserMessage` (`content[]` of `{type: "text", text}`); agent text is `AgentMessage` (`phase` distinguishes commentary from the final answer). `response_item` user messages also contain injected environment/instruction blocks and are not used for prompts.
- Changes and commands: `event_msg` `item_completed` with `item.type` `FileChange` (`changes` keyed by absolute path) and `CommandExecution` (`command`, `exit_code`, `status`).
- Titles: `session_index.jsonl` `{id, thread_name, updated_at}`, else first prompt.
- If a Codex rollout directory stops updating while Codex reports activity, Core emits a diagnostic; Codex may migrate history to SQLite, which is not read in this version.

### Long files

Codex rollouts can be many megabytes with very long lines (images, tool output). Plain `.jsonl` rollouts are followed incrementally: each file keeps its last parsed byte offset and the parser state, and later passes read only the appended bytes. A file seen for the first time is streamed once in bounded chunks; oversized lines are not decoded in full — only their record and payload types are sniffed, so lifecycle events (`task_started`, `task_complete`, `turn_aborted`) are never missed. A truncation or replacement (size shrink, identity change) restarts the file from the beginning.

### Discovery loop

`fs.watch` on the registry and session directories marks paths dirty; a debounced pass (≈500 ms) re-reads only dirty files using the existing `(dev, ino, size, mtime)` cache and tail reads. A slow full rescan (≈60 s) reconciles missed events. Unreadable or partial sources keep previous data and surface a diagnostic.

## State

Canonical records: `Session`, `Idea`, `SessionMarker` (view/pin/remove-from-active), `Observation` (bounded per-turn facts) and settings. Legacy tables (attention, contexts, briefs, deliveries, receipts) remain untouched and are only read by legacy export.

- Session identity binds device, agent and native ID; equal titles or directories never merge sessions.
- Session state is derived: running (registry/turn open, or a running subagent), waiting (the last turn ended after `max(handledAt, lastPromptAt)`, a subagent is waiting, or the registry reports waiting — viewing a card does not end waiting; only Mark handled or a new prompt does), idle, unknown.
- Active set: running ∪ waiting ∪ activity within 12 h ∪ pinned, minus sessions removed from active since their last prompt.
- Idea mutations carry operation IDs and revisions; replaying an operation returns the original result.

## Recent activity

Adapters keep, per session, the last 20 activity entries `{at, kind: "message" | "command" | "file" | "error", text, failed?}` (text redacted, ≤ 200 chars): Codex `AgentMessage`, `CommandExecution` (failed when exit code ≠ 0), `FileChange` paths, `turn_aborted`/errors; Claude assistant text blocks, `Bash`/edit `tool_use` with their results, `api_error`. Repeated edits of one file collapse to the latest entry. The catch-up projection returns the newest 5 and whether older entries were unread.

## Surface tags

A session's surface comes from native metadata: Claude `entrypoint` (`claude-desktop` → Desktop, `cli` → CLI, `claude-vscode` → VS Code, SDK entrypoints → Automated), Codex `originator` (`Codex Desktop` → Desktop, `codex_cli_rs`/`codex-tui` → CLI, `codex_vscode`/`vscode_agent_host` → VS Code, `codex_exec` → Automated). Unknown values show only the app name.

## Catch-up projection

Anchor = `max(lastPromptAt, lastViewedAt)`. Core stores, per turn, the end time, duration, last agent message (≤20,000 chars), error/abort markers, changed file paths and failed commands, and Claude away summaries. The projection returns turns after the anchor plus all `pending` ideas of the session. Opening a card issues `session.viewed`.

## Windows

- **Panel**: tray-anchored, frameless; can be pinned as an always-on-top window. Tray title shows running/waiting counts.
- **Capture**: frameless, centered at the top of the active display, shown by a global shortcut; hides on blur/Esc and restores focus to the previous app.
- **Bubble**: transparent, frameless, always on top, visible on all workspaces and above full-screen apps. Snap/opacity rules are pure functions of display bounds and drop position so they can be unit tested. The compact list is a sibling window positioned beside the bubble.

## Legacy data

Database `state/companion.sqlite3`. On first run an existing `state/aimspan.sqlite3` is backed up consistently and imported read-only; only memos become `pending` ideas (unknown sessions go to the inbox). Import is transactional and idempotent. “Export all legacy data as JSON” writes all legacy tables to a user-chosen JSON file.

## Build

`pnpm build` builds TS packages and Electron assets. `pnpm verify` and `pnpm verify:smoke` define the checks.
