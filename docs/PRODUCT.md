# AimSpan product and interface

Status: product specification confirmed on 2026-10-15. Implementation progress is in [ROADMAP](ROADMAP.md), measured results in [STATUS](STATUS.md), and technical structure in [ARCHITECTURE](ARCHITECTURE.md).

## The problem

During long tasks, each Codex or Claude turn can take minutes to tens of minutes. Users run several sessions in parallel and switch between them; the original train of thought and ideas that arise while waiting are easy to lose.

AimSpan does three things:

1. **Show which sessions are active**: running, waiting for you, or recently used.
2. **Capture ideas while you wait**: save an idea to its session or the inbox in seconds without interrupting your focus.
3. **Help you pick up where you left off**: a catch-up card shows what happened while you were away and helps bring your saved ideas back to the original session.

Users keep working in their existing apps. AimSpan does not start, drive or answer agents, and makes no model calls.

## Scope

- Platform: macOS only.
- Sources: Claude Code CLI and the Claude desktop app's Code tab (sharing `~/.claude`), plus Codex CLI and the Codex desktop app (sharing `~/.codex`). Other tools are outside the first release.
- Zero configuration: read native local records only; never write agent configuration or install hooks.
- Child agents are not listed separately; a running child makes its parent session count as running. Codex internal threads, including automatically generated “Guardian review” threads and any thread whose `thread_source` is not `user`, also count as children. Children whose parent cannot be found remain hidden.

### Retired features

Goal and constraint context, direction checks, model-based progress follow-up, handoff briefs, in-app approvals, direct sending to native sessions, the attention-item lifecycle, mobile and cross-device features are removed from the interface and protocol. Legacy tables are retained and can be exported from Settings.

## Session state and the active set

| State | Meaning |
| --- | --- |
| Running | The agent is executing this turn, including any running child agents |
| Waiting | A turn has ended and you have not marked it handled, or the session needs input or approval |
| Idle | The turn has ended and you have marked it handled, or there is no result requiring your attention |
| Unknown | There is insufficient evidence; this does not mean finished or failed |

Each session records the last prompt (`lastPromptAt`), last turn end (`lastTurnEndAt`), last catch-up card view in AimSpan (`lastViewedAt`), and last explicit handling (`handledAt`).

- **Waiting ends only when you explicitly handle the result**: after a turn ends, the session stays waiting until you click “✓ Mark handled” on its row or send a new prompt in the original app, which makes it running again. Merely opening the card only clears the new-result dot. An accidental click or a quick glance must not make a waiting session disappear from the list.
- A result is new when `lastTurnEndAt` is later than both `lastViewedAt` and `lastPromptAt`. A completed turn remains waiting when `lastTurnEndAt` is later than both `handledAt` and `lastPromptAt`.
- On first observation, historical turns count as handled; the baseline rule remains unchanged.

**Active set** = running + waiting + activity within the last 12 hours + manually pinned sessions. “Hide until next prompt” lasts until you next send that session a prompt. All other sessions remain in “All”.

- **First observation counts as viewed**: when AimSpan first discovers a session, its existing turns count as already seen. Only turns ending afterward count as new results. Otherwise, first launch would mark months-old sessions as waiting.
- **Automated sessions stay out of the active set**: non-interactive sessions such as Codex `codex exec` and Claude SDK or `claude -p` runs are excluded from Active, tray and bubble counts, and notifications. They appear only in “All”.
- **A turn you interrupt yourself** is idle and does not count as a new result.

## Ideas

- An idea is plain text, may span multiple lines, has a 4000-character limit, and is stored verbatim.
- An idea belongs to a session or the **Inbox**, for a future session or an undecided destination. It can later be moved to a session. There is no project hierarchy.
- States: `pending` → `brought` (undoable); `pending` → `discarded` (restorable). A discarded idea can be permanently deleted after a second confirmation. There is no other permanent deletion.
- Saving writes only to local storage and sends nothing to an agent.

## Catch-up card

Expand a session in AimSpan before switching back to see its catch-up card. The card uses native records only and requires no model.

**Anchor**: `max(lastPromptAt, lastViewedAt)`, the time you last left or viewed the session. Opening the card updates `lastViewedAt`. The anchor is internal; the interface does not use phrases such as “anchor” or “0 turns since you left”.

**Expanded card header**: the primary action sits directly to the right of the title. With pending ideas it is “Bring back N”, copying all pending ideas and opening the original session; otherwise it is “Open session ↗”. The adjacent ellipsis button (“More session actions”) opens a menu with “Open session only”, “Pin” / “Unpin”, “Hide until next prompt” (temporarily leave Active until another prompt), and “Archive” (stop appearing in Active). The body does not repeat state and time already shown in the header.

The body, from top to bottom:

1. **My ideas**: pending ideas for this session, each with three explicit buttons on its right:
   - “Send”: bring back this idea only by copying its exact text and opening the original session; mark it brought back, with 5 seconds to undo.
   - “Edit”: edit in place; Enter saves, Shift+Enter inserts a newline, and Esc cancels.
   - “Delete”: mark it discarded, with 5 seconds to undo. The collapsed “Deleted · N” section offers “Restore” or “Delete permanently”.
   Session cards show neither checkboxes nor “Move to session…” because the ideas already belong to that session. An input below the list adds ideas with Enter. Brought-back ideas appear in a collapsed “Brought back · N” section and can be returned to pending with “Undo bring back”.
2. **Results and activity**: show content appropriate to the state without duplication:
   - **Running**: a heading such as “Running · 28 min”, followed directly by the latest 5 activity entries showing what the agent is doing now; do not show the previous turn's reply.
   - **Waiting / Idle**: a heading such as “Waiting · ended 8 min ago” or “Idle · 2 h ago”, followed directly by the **Result** (the final reply, rendered as Markdown, initially about 8 lines with an expand action). Activity collapses to one line, such as “Process · 5 steps”, and appears only when expanded.

   Activity uses the same presentation in both states: newest first, one line per entry, with a relative time and type marker:
   - **Message**: what the agent said, using the first line and about 80 characters at most.
   - **Command**: the command it ran; failed commands appear in red and carry “failed”.
   - **File**: the file it changed; repeated edits to one file collapse to a single entry.
   - **Error or interruption**.
   When intermediate records have not been read, append “Earlier activity not read”. If Claude supplies an away summary, place it above the result under “Away summary · Generated by Claude”. Reply rendering does not execute raw HTML and is limited to 20,000 characters.

**Expanded styling**: distinguish the expanded card with the same thin border as the list and a soft shadow, without a heavy dark outline. When opening from the bubble or moving to a card with the keyboard, use only a subtle background to indicate focus, without a dark focus frame.

### Bring-back rules

- Copy a single idea verbatim; copy multiple ideas as a numbered list without an introductory sentence. The copied ideas become brought back, with 5 seconds to undo.
- Codex: open the thread with `codex://threads/<id>`. Claude: open the Claude app and show the target session title and project in AimSpan. Exact opening by session ID stays disabled until verified in the real app.
- Copying does not mean sending. AimSpan does not record delivery.
- Inbox ideas retain “Move to session…”, “New session · Codex” and “New session · Claude”.

## Main panel

### Menu bar

Beside the menu-bar icon, show `🟢running count 🟠waiting count`, omitting either count when zero. Use these colors consistently throughout the app: green for running (a slowly breathing dot in the interface), orange for waiting (a stationary dot). Clicking opens the list panel, which can be pinned as an always-on-top window.

### Header

One row only: search, the “Active N | All N” switch, a pin icon and a settings icon. No large heading or logo. Source-app filters appear only in “All”, as small tags below search.

### List

```text
┌─────────────────────────────────────────────────────────────────┐
│ Search                 Active 3 | All 128       Pin   Settings  │
├─────────────────────────────────────────────────────────────────┤
│▌● Claude · sample-app              Waiting · ended 12 min ago   │
│▌  Refine the product scope                            2 ideas   │
├─────────────────────────────────────────────────────────────────┤
│ ● Codex · docs-site                          Running · 6 min    │
│   Fix the navigation                                            │
├─────────────────────────────────────────────────────────────────┤
│   Claude · sample-research                      Ended 2 h ago   │
└─────────────────────────────────────────────────────────────────┘
```

Synthetic example. Each row shows the app icon, project name, title, state and time, and pending idea count only when greater than zero. Title priority: custom title, native title, then the first prompt.

**Visual state encoding**, beyond text:

| State | Marker | Time wording |
| --- | --- | --- |
| Waiting | Accent dot and a bar at the left edge; bold when there is a new result | “Waiting · ended 12 min ago” for an ended turn |
| Running | Animated dot that respects reduced-motion settings | “Running · 6 min” |
| Idle | No marker; gray | “Ended 8 min ago” |
| Unknown | Gray dashed dot | “Checking status” |

Sort waiting sessions first (longest wait first), then running sessions (most recent prompt first), then recent activity. Do not reorder while the user is browsing or editing; show “Updates available” instead. Group “All” by “Today”, “Yesterday”, “This week” and “Earlier”.

Click a row to expand its catch-up card; only one card is expanded at a time. Search covers the complete dataset: titles, projects and ideas.

The inbox appears as a row at the bottom only when it has pending ideas. The bottom status bar appears only for source problems, such as “2 sources need attention · View”. Manual refresh belongs in Settings.

### Keyboard

| Key | Action |
| --- | --- |
| ↑ / ↓ | Move selection between session rows |
| Enter | Expand or collapse the selected session's catch-up card |
| ⌘Enter | Bring back ideas if present; otherwise open the original session |
| ⌘O | Open the original session only |
| Esc | Collapse the card first, then close the panel |
| / | Focus search |

## Quick capture window

- Default global shortcut: ⌘⇧Space, configurable in Settings.
- Spotlight-like appearance: centered near the top of the active display, with rounded corners, a shadow and a frosted background. Target row above, text input below.
- **Target selection**: a directly clickable row above the input offers “This session” (the default target, showing app, project, title, state and existing idea count), “Inbox”, “New Codex”, “New Claude” and “Other…” (a searchable session list), mapped to ⌘1–⌘5. Highlight the selected target. For a new-session target, Enter copies and opens the corresponding app, and the hint changes accordingly.
- Default target: the running session with the most recent prompt within the last 30 minutes; otherwise Inbox.
- **Switching targets**: click a target, use ⌘1–⌘5, cycle with ⌘↑ / ⌘↓, or type `@` and a keyword to search. Plain ↑ / ↓ only move the cursor within multiline text. Switching targets preserves the input text.
- Enter saves; Shift+Enter inserts a newline. Enter during IME composition (`isComposing` or keyCode 229) does not submit.
- After saving, show “Saved to X” for about 1 second, close, and return focus to the original app. Esc or blur closes the window; unsaved text remains for the next opening.
- Footer: “Enter Save · ⌘↑↓ Switch target · Esc Close · Stays on this Mac”.

## Start a new session from an idea (semi-automatic)

AimSpan does not create or send a session for you; it reduces starting one to a paste:

- The capture targets include the fixed options “New session · Codex” and “New session · Claude”, after Inbox (their chips read “New Codex” and “New Claude”). Enter saves the idea to Inbox, marks it brought back, copies its text, and opens the app's new-session entry. The hints are “Copied. Paste in Claude and press Enter” or “Copied. Press ⌘N in Codex, then paste and press Enter”.
- Opening: Claude uses `claude://code/new`. Codex has no usable new-session link, so open the Codex app and prompt the user to press ⌘N before pasting. The project directory follows the app's own default and can be changed there. Both paths remain marked unverified until tested in the real apps; on failure, open only the app.
- Entry points: “＋ New session” at the bottom of the compact list opens capture with the last-used new-session app selected; each pending inbox idea offers “New session · Codex” and “New session · Claude”.
- Copying is not sending. AimSpan records no delivery and gains no ability to send content to agents.

## Floating bubble

Enabled by default and snapped to the right screen edge; it can be disabled in Settings.

**Appearance**: an approximately 44px circle, using the same counts as the menu bar. Stack two colored numbers vertically: green running count above, orange waiting count below. Hide zero counts and center the remaining number when there is only one. Stacking keeps both readable when half the circle is hidden at the edge. The outer ring breathes while any session is running. With neither state present, dim the bubble and show no numbers. Flash once for about 1.5 seconds, silently, when a new turn ends. The tooltip spells out the composition, such as “2 running · 6 waiting”.

**Interaction**:

| Action | Effect |
| --- | --- |
| Hover | Open the compact list only after the pointer stays nearly still over the bubble for about 350ms. Do not open while a mouse button is held, such as while dragging a scrollbar. Close about 500ms after leaving. |
| Click | Open the compact list without taking keyboard focus. After the pointer has entered the list, close it when the pointer stays outside for more than about 1 second. “Pin compact list” at the top right keeps it open; clicking “Unpin compact list”, the close button or the bubble closes it, as does Esc after focusing the list. Only actions that leave the list close it: opening a session, adding an idea, starting a new session or saving to Inbox. In-place actions (“Pin” / “Unpin” a session, “✓ Mark handled”) keep it open for handling several sessions. |
| Drag | Move the bubble. |
| Right-click | “Do not disturb for 1 hour”, “Hide bubble”, “Open main panel”, “Settings”. |

**Snapping and opacity**: on release within 24px of the outermost left or right edge of the entire display array, snap to that edge and hide half the bubble. Use the work area, excluding the Dock and menu bar; with a side Dock, sit just inside it without overlap. Do not snap to seams between displays. Normal opacity is 70% when snapped and 35% when freely floating; on hover, use 100% and fully reveal a snapped bubble. Remember its position. If display changes leave it out of bounds, return it to the primary display's right edge. Keep it visible across Spaces and above full-screen apps.

**Popover placement**, for the compact list and a panel opened from the bubble: horizontally, open on the bubble's opposite side—left from the right edge, right from the left edge, or toward more space when freely floating. Vertically, align with the bubble's top and grow downward when it is in the upper half of the display; align with its bottom and grow upward in the lower half. Finally, clamp to the work area so the entire popover remains visible.

**Compact list**: pinned sessions first, then waiting, then running; pinned sessions stay at the top regardless of state. Show at most 8 rows before scrolling. Each row contains a state marker, title, **surface tag** (such as “Claude Desktop”, “Claude CLI”, “Claude VS Code”, “Codex Desktop”, “Codex CLI” or “Codex VS Code”; app name only when unknown), time wording and idea count only when greater than zero. Hover reveals three small actions: add an idea, “Pin” / “Unpin”, and “✓ Mark handled” on waiting rows only. Clicking the row opens the panel beside the bubble, rather than at the menu bar, and expands that session's catch-up card. The add-idea action captures directly to that session. Keep “Save to inbox” fixed at the bottom.

Do not detect screen sharing. Use the context menu's “Hide for 1 hour” or a configurable show/hide shortcut instead.

## Visual design

The panel, capture window, bubble and compact list share colors, typography and corner radii, following the system's light or dark appearance. Text uses neutral colors; accent colors are reserved for state and primary actions.

## Notifications

- System notifications are off by default while the bubble is enabled.
- With the bubble disabled, notify only when a turn that ran for at least 2 minutes ends, or when a session begins waiting for input or approval. Use the session title with “Finished a turn” and “ · You saved N ideas” (singular “idea” for 1). Waiting uses “Waiting for your input”. Announce each kind—approval waiting and turn completion—at most once per turn, without repeating after a restart. Clicking opens the catch-up card.
- Provide a global Do Not Disturb switch; do not inspect the foreground window.

## Settings

Session sources and diagnostics (unreadable sources, Codex records that have not updated recently, and similar issues), shortcuts, bubble and notifications, legacy import status, and “Export all legacy data as JSON”.

## Legacy data

On first-run import of an old database, convert only old memos to pending ideas. Reattach those that match a session; place the rest in Inbox. Old attention, context, brief, receipt and other tables remain intact but hidden and can be recovered by export. Import is idempotent and deletes no legacy data.

## Acceptance scenarios

| Scenario | Pass condition |
| --- | --- |
| Run 2 Claude sessions (CLI and desktop Code tab) and 1 Codex desktop session together | Active matches reality; state updates within seconds |
| Capture an idea with a Chinese IME via the shortcut while waiting | Enter used to select an IME candidate does not submit; the idea goes to the correct session and survives restart |
| Open a catch-up card after time away | Saved ideas appear at the top, followed by the final reply, changed files and failed commands; viewing advances the anchor |
| Bring back multiple ideas | Clipboard contains a numbered list; ideas become brought back; Codex opens the matching thread, while Claude opens the app and shows the target session hint |
| Drag the bubble between a built-in and external display | Snap only at the outermost edges; return to the primary display's right edge after the external display is disconnected |
| Native records become unreadable or change format | Preserve existing sessions and ideas; explain the source problem in diagnostics instead of treating everything as finished |
| Throughout the workflow | No configuration files under `~/.claude` or `~/.codex` are modified |

## Brand and documentation ownership

The display name is AimSpan (Chinese display name: AimSpan｜意成); package and storage identifiers use `aimspan`. Keep the existing [brand artwork](../apps/desktop/src/renderer/assets/aimspan-icon.svg).

This file alone owns product behavior and interface design. [ARCHITECTURE](ARCHITECTURE.md) owns technical structure, [CORE-PROTOCOL](CORE-PROTOCOL.md) interfaces, [SECURITY](SECURITY.md) data and authority, [ROADMAP](ROADMAP.md) unfinished work, and [STATUS](STATUS.md) measured results only.
