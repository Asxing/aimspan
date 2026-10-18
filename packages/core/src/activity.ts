import type { ActivityEntry } from "@aimspan/protocol";
import { redact } from "./security.js";

export const MAX_ACTIVITY = 20;

/** Sanitize before truncating, so credentials straddling the cap cannot leak. */
/** `/bin/zsh -lc 'pnpm test'` → `pnpm test`: the shell wrapper is noise in a one-line summary. */
export function unwrapShell(command: string): string {
    const match = /^\s*(?:\/(?:usr\/)?bin\/)?(?:zsh|bash|sh)\s+-l?c\s+([\s\S]*)$/.exec(command);
    if (!match) return command;
    const inner = match[1]!.trim();
    const quoted = /^(['"])([\s\S]*)\1$/.exec(inner);
    return quoted ? quoted[2]! : inner;
}

export function activityEntry(at: string, kind: ActivityEntry["kind"], body: string, failed?: boolean): ActivityEntry {
    const safe = redact(kind === "command" ? unwrapShell(body) : body, 200);
    // Messages and commands keep their first line: a heredoc or multi-line script is noise in a one-line summary.
    return { at, kind, text: kind === "message" || kind === "command" ? safe.split(/\r\n|\r|\n/, 1)[0]! : safe,
        ...(failed === undefined ? {} : { failed }) };
}

/** Newest wins, including file recency; replaying a scan cannot multiply entries. */
export function mergeActivity(older: readonly ActivityEntry[], newer: readonly ActivityEntry[]): ActivityEntry[] {
    const kept = new Map<string, ActivityEntry>();
    const ordered = [...newer, ...older].filter(entry => Number.isFinite(Date.parse(entry.at)))
        .map(entry => activityEntry(new Date(entry.at).toISOString(), entry.kind, entry.text, entry.failed))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const result: ActivityEntry[] = [];
    for (const entry of ordered) {
        if (!entry.text) continue;
        const key = JSON.stringify(entry.kind === "file" ? [entry.kind, entry.text] : [entry.kind, entry.at, entry.text]);
        const existing = kept.get(key);
        // A partial rescan may lack the outcome; never erase a known command result.
        if (existing) { if (existing.failed === undefined && entry.failed !== undefined) existing.failed = entry.failed; continue; }
        kept.set(key, entry); result.push(entry);
    }
    return result.slice(0, MAX_ACTIVITY);
}

export function addActivity(entries: ActivityEntry[], entry: ActivityEntry) {
    entries.splice(0, entries.length, ...mergeActivity(entries, [entry]));
}
