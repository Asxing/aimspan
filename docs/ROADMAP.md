# AimSpan roadmap

Product scope is in [PRODUCT](PRODUCT.md), technical structure in [ARCHITECTURE](ARCHITECTURE.md), and measured results in [STATUS](STATUS.md). This roadmap lists unfinished work only.

## Not yet verified

- Real global-shortcut key presses, Chinese IME composition, focus return to the previous app, and menu-bar clicks; currently covered only through the smoke harness.
- Bring-back opening a real Codex thread or Claude app; the bubble on multiple displays and in full-screen Spaces; native notification display and click.
- Long-term use with a dozen real parallel sessions.
- Whether `claude://code/continue?session=<id>` opens the exact Claude session. Until verified, open only the app and show a session hint.
- Actual navigation through `codex://threads/<id>` in the current Codex desktop app.
- Whether `claude://code/new` opens a new Code session in the macOS Claude app, and whether Codex offers a usable new-session entry.
- How Claude's live-registry `status` values map to waiting for input or approval.

## Deferred

- Optional hook installation for lower latency and more accurate approval-waiting state. Configuration writes require a separate safety design.
- Reading Codex's SQLite history store.
- Dropping text onto the bubble to capture ideas; attaching images to ideas.
- Detecting the foreground window to suppress notifications; detecting screen sharing.
- Complete bilingual coverage.
- Mobile, cross-device and remote capabilities.

## Planned

- Officially signed and notarized macOS builds.
- Automatic updates.
