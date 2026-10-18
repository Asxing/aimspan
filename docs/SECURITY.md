# AimSpan security and data handling

## Authority

AimSpan observes and records; it does not act on Agents. The active build has no model calls, no credentials, no Hook server, no native request answering and no message delivery. Bringing ideas back writes the clipboard and opens a native app or deep link after an explicit user click; it never types or sends into a session.

AimSpan never writes `~/.claude` or `~/.codex`. Optional Hook installation is deferred and requires its own design before it may modify user configuration.

## Local state

Core alone writes the private SQLite database. Renderers are sandboxed, context-isolated, without Node integration, and can only call their declared preload interface. Main validates the sender window and an operation allowlist per window kind.

## Native sources

Reads are limited to the supported Claude and Codex stores, read-only and bounded by file size, entry count, depth and per-pass totals. Symlinks, non-regular files, files owned by another user and files replaced during a read are skipped. Claude registry `*.key` files are never opened. These checks are application safeguards, not an OS sandbox against hostile same-user software.

Stored observations are bounded (agent message ≤20,000 chars, file and command lists capped) and pass through redaction. No complete transcript mirror is created. Source text is treated as untrusted data and rendered as sanitized Markdown without raw HTML or script execution; links open only after a click and only for `http`, `https` and known native schemes.

Unknown or partial reads keep previous data and surface a diagnostic; they never clear sessions or ideas.

## User data

Ideas are user-authored and stored verbatim. Deletion only happens through an explicit purge of an already discarded idea. Removing features never deletes data: legacy tables, the legacy database and its consistent backup are preserved, and credentials previously stored in the OS keychain are left untouched.

## Recovery

Legacy import uses a consistent SQLite backup and a transaction into the separate new database; retries do not duplicate records. A JSON export of legacy tables is available from settings. User databases, local backups and exported recovery data stay outside tracked source.
