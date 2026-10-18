# AimSpan Core interface

Core runs in an Electron utilityProcess. Main posts `{ type: "call", id, request }` over MessagePort and receives a response plus the latest workspace projection. Types and runtime validators live in `packages/protocol/src/index.ts`.

## Requests

| Method | Purpose |
| --- | --- |
| `workspace` | Full projection |
| `scan` | Force a discovery pass |
| `catchup` | Catch-up projection for one session |
| `session.viewed` | Set `lastViewedAt` (advances the catch-up anchor) |
| `session.pin` / `session.unpin` | Keep a session in the active set |
| `session.deactivate` | Remove from active until its next prompt |
| `idea.save` | Create or edit an idea (session ID or inbox) |
| `idea.move` | Reattach an idea to a session or the inbox |
| `idea.setStatus` | `pending` / `brought` / `discarded` (and back) |
| `idea.purge` | Permanently delete a discarded idea (explicit confirmation in UI) |
| `draft.save` | Persist the capture or card draft per target |
| `settings.save` | Shortcuts, bubble, notifications, sources |
| `legacy.export` | Write legacy tables to a Main-selected path |

Mutations carry an operation ID and, when editing existing content, the expected revision. Reusing an operation ID with different input fails; replay returns the original result. Mutations and operation receipts commit in one transaction.

## Projections

`Workspace` contains sessions (agent, native ID, project, title, state, timestamps, pinned/deactivated, pending idea count, has-new-result), ideas, drafts, settings, change sequence and diagnostics. Native transcript contents and full source listings stay in Core; diagnostics may carry a redacted source path (for example a watch fallback) so Settings can show which file needs attention.

`CatchUp` contains the anchor, current state, turns since the anchor (end time, duration, last agent message, errors, changed files, failed commands, away summary) and the session's pending ideas.

Bringing ideas back is a Main operation: Main formats the selected ideas (single → raw text, multiple → numbered list), writes the clipboard, opens the native target and then calls `idea.setStatus` with `brought`.
