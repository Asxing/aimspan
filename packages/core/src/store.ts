import type { SourceDiagnostic } from "@aimspan/protocol";
import { DatabaseSync, backup } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Session, Idea, Draft, Settings, Workspace, SourceRef, CoreRequest, TurnCompletion, CatchUp, ActivityEntry } from "@aimspan/protocol";
import { DEFAULT_SETTINGS, CAPTURE_DRAFT_KEY, isInteractiveSession, isIdeaTargetSession, isRegistryWaiting, notificationIdentity, notificationsEnabled, sessionSurface, validRequest, validSettings } from "@aimspan/protocol";
import { digest, privateDirectory, privateFile, redact, readSource, inside } from "./security.js";
import { boundedAgentMessage, type SourceTurn } from "./source.js";
import type { SessionFacts } from "@aimspan/protocol";
import { projectSessions, time } from "./state.js";
import { exportLegacyTables, legacyRows } from "./legacy.js";
import { projectCatchUp } from "./catchup.js";
import { mergeActivity } from "./activity.js";
export interface Observation {
    agent: Session["agent"];
    nativeId: string;
    title: string;
    project: string;
    parentNativeId?: string;
    isChild?: boolean;
    archived?: boolean;
    state: "working" | "waiting" | "ended" | "failed" | "unknown";
    at: string;
    confidence: Session["confidence"];
    sources: SourceRef[];
    version: string;
    eventId?: string;
    human?: boolean;
    lastPromptAt?: string;
    lastMainRecordAt?: string;
    sourceChangedAt?: string;
    sourceUncertain?: boolean;
    sampledAt?: string;
    subagentWaitingAt?: string;
    entrypoint?: string;
    originator?: string;
    registry?: SessionFacts["registry"];
    turns?: SourceTurn[];
    trailingCompletion?: TurnCompletion;
    previousCompletion?: TurnCompletion;
    subagentRunning?: boolean;
    activity?: ActivityEntry[];
    activityIncomplete?: boolean;
}
function sourceReferences(references: readonly (SourceRef & { label?: string })[] = []): SourceRef[] {
    return references.map(ref => ({ id: ref.id,
        kind: ref.kind ?? (ref.label === "用户消息" ? "user" : "agent"), // i18n-allow: parse legacy native source labels without rewriting stored rows
        time: ref.time, excerpt: ref.excerpt }));
}
const defaults = { pinned: false, subagentRunning: false, active: false, hasNewResult: false, pendingIdeaCount: 0, interactive: true,
    surface: "unknown" as const, activity: [] as ActivityEntry[], activityIncomplete: false };
const stamp = (value?: string) => value && Number.isFinite(Date.parse(value)) ? redact(new Date(value).toISOString(), 40) : undefined;
const latest = (...values: (string | undefined)[]) => values.map(stamp).filter((v): v is string => !!v).sort().at(-1);
const sourceIdentity = (value: string) => {
    const safe = redact(value, 256);
    return safe === value ? safe : redact(`redacted-${digest(value)}`, 256);
};
function cleanTurn(turn: SourceTurn): SourceTurn | undefined {
    const promptAt = stamp(turn.promptAt);
    if (!promptAt) return undefined;
    return {
        promptAt, ...(turn.turnId ? { turnId: sourceIdentity(turn.turnId) } : {}),
        ...(stamp(turn.endedAt) ? { endedAt: stamp(turn.endedAt) } : {}),
        ...(stamp(turn.factsThrough) ? { factsThrough: stamp(turn.factsThrough) } : {}),
        ...(turn.aborted ? { aborted: true } : {}),
        ...(typeof turn.durationMs === "number" && Number.isFinite(turn.durationMs) && turn.durationMs >= 0 ? { durationMs: turn.durationMs } : {}),
        ...(turn.lastAgentMessage ? boundedAgentMessage(turn.lastAgentMessage, turn.lastAgentMessageTruncated) : {}),
        ...(turn.awaySummary ? { awaySummary: redact(turn.awaySummary, 4000) } : {}),
        errors: turn.errors.slice(0, 50).map(v => redact(v, 500)),
        changedFiles: turn.changedFiles.slice(0, 200).map(v => redact(v, 4096)),
        failedCommands: turn.failedCommands.slice(0, 50).map(v => redact(v, 300)),
    };
}
// Preserve repeated failures within a turn, but don't multiply them on replay.
/** Changed files keep last-occurrence order: the newer observation decides recency. */
function mergeRecency(older: string[], newer: string[], cap: number): string[] {
    const recent = new Set(newer);
    return [...older.filter(v => !recent.has(v)), ...newer].slice(-cap);
}
function mergeFacts(a: string[], b: string[], cap: number): string[] {
    const counts = new Map<string, number>();
    for (const v of a) counts.set(v, (counts.get(v) ?? 0) + 1);
    const result = [...a];
    for (const v of b) { const count = counts.get(v) ?? 0; if (count) counts.set(v, count - 1); else if (result.length < cap) result.push(v); }
    return result;
}
export class Store {
    readonly db: DatabaseSync;
    readonly deviceId: string;
    diagnostics: SourceDiagnostic[] = [];
    constructor(readonly directory: string, private readonly clock = () => new Date().toISOString()) {
        privateDirectory(directory);
        const path = join(directory, "companion.sqlite3");
        if (existsSync(path))
            privateFile(path);
        this.db = new DatabaseSync(path);
        privateFile(path);
        this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
        this.db.exec(`CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id));
  CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS source_events(id TEXT PRIMARY KEY,session_id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS imported(source TEXT PRIMARY KEY,report TEXT NOT NULL);`);
        this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY)");
        if (!this.db.prepare("SELECT version FROM schema_migrations WHERE version=1").get()) this.transaction(() => {
            this.db.exec(`CREATE TABLE observations(
                session_id TEXT NOT NULL, turn_key TEXT NOT NULL, prompt_at TEXT NOT NULL,
                turn_id TEXT, observed_at TEXT NOT NULL, json TEXT NOT NULL,
                PRIMARY KEY(session_id,turn_key));
                CREATE INDEX observations_prompt ON observations(session_id,prompt_at);
                CREATE INDEX observations_turn_id ON observations(session_id,turn_id);
                INSERT INTO schema_migrations VALUES(1);`);
        });
        if (!this.db.prepare("SELECT version FROM schema_migrations WHERE version=2").get()) this.transaction(() => {
            this.db.exec(`CREATE TABLE ideas(
                id TEXT PRIMARY KEY, session_id TEXT, status TEXT NOT NULL CHECK(status IN ('pending','brought','discarded')),
                revision INTEGER NOT NULL, json TEXT NOT NULL);
                CREATE INDEX ideas_session_status ON ideas(session_id,status);
                CREATE TABLE drafts(target TEXT PRIMARY KEY, revision INTEGER NOT NULL, json TEXT NOT NULL);
                CREATE TABLE idea_imports(source_key TEXT PRIMARY KEY, idea_id TEXT NOT NULL);`);
            const memos = this.db.prepare("SELECT id,json FROM records WHERE kind='memo' ORDER BY id LIMIT 100001").all();
            if (memos.length > 100000) throw new Error("core.errorMemoMigrationExceedsTheRowLimit");
            for (const row of memos) {
                const memo = JSON.parse(String(row.json)) as { sessionId?: string; body: string; createdAt: string; updatedAt: string };
                const sessionId = memo.sessionId && memo.sessionId !== "import-unassigned" && this.get("session", memo.sessionId) ? memo.sessionId : null;
                this.importIdea(`memo:${row.id}`, sessionId, memo.body, memo.createdAt, memo.updatedAt);
            }
            const drafts = this.db.prepare("SELECT key,json FROM metadata WHERE key LIKE 'draft:%' LIMIT 100001").all();
            if (drafts.length > 100000) throw new Error("core.errorDraftMigrationExceedsTheRowLimit");
            for (const row of drafts) this.putDraft({ target: String(row.key).slice(6), body: JSON.parse(String(row.json)) as string, revision: 1, updatedAt: this.now() });
            this.db.exec("INSERT INTO schema_migrations VALUES(2)");
        });
        if (!this.db.prepare("SELECT version FROM schema_migrations WHERE version=3").get()) this.transaction(() => {
            // Copy once into a new namespace; retain every legacy row, including orphan targets.
            // A cleared shared draft must never resurrect an older per-target draft on restart.
            if (!this.db.prepare("SELECT target FROM drafts WHERE target=?").get(CAPTURE_DRAFT_KEY)) {
                const rows = this.db.prepare(`SELECT json FROM drafts WHERE target='capture:null' OR target GLOB 'capture:"*"' ORDER BY target LIMIT 100001`).all();
                if (rows.length > 100000) throw new Error("core.errorCaptureDraftMigrationExceedsTheRowLimit");
                const newest = rows.map(row => JSON.parse(String(row.json)) as Draft).filter(draft => draft.body.length > 0)
                    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))[0];
                if (newest) this.putDraft({ target: CAPTURE_DRAFT_KEY, body: newest.body, revision: 1, updatedAt: newest.updatedAt });
            }
            this.db.exec("INSERT INTO schema_migrations VALUES(3)");
        });
        if (!this.db.prepare("SELECT version FROM schema_migrations WHERE version=4").get()) this.transaction(() => {
            for (const session of this.all<Session>("session")) {
                const handledAt = session.handledAt ?? stamp(session.lastViewedAt)
                    ?? latest(session.lastTurnEndAt, session.subagentWaitingAt)
                    ?? latest(session.lastActivityAt, session.observedAt) ?? stamp(session.updatedAt) ?? this.now();
                this.put("session", { ...session, handledAt, surface: sessionSurface(session),
                    activity: mergeActivity([], session.activity ?? []), activityIncomplete: session.activityIncomplete ?? false,
                    revision: session.revision + 1, updatedAt: this.now() });
            }
            this.db.exec("INSERT INTO schema_migrations VALUES(4)");
        });
        this.deviceId = this.meta<string>("deviceId") ?? randomUUID();
        this.setMeta("deviceId", this.deviceId);
    }
    close() { this.db.close(); }
    now() { return this.clock(); }
    meta<T>(key: string): T | undefined { const r = this.db.prepare("SELECT json FROM metadata WHERE key=?").get(key); return r ? JSON.parse(String(r.json)) as T : undefined; }
    setMeta(key: string, value: unknown) { this.db.prepare("INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json").run(key, JSON.stringify(value)); }
    all<T>(kind: string): T[] { return this.db.prepare("SELECT json FROM records WHERE kind=? ORDER BY id").all(kind).map(r => JSON.parse(String(r.json)) as T); }
    get<T>(kind: string, id: string): T | null { const r = this.db.prepare("SELECT json FROM records WHERE kind=? AND id=?").get(kind, id); return r ? JSON.parse(String(r.json)) as T : null; }
    put<T extends {
        id: string;
        revision: number;
        updatedAt: string;
    }>(kind: string, value: T) { const s = JSON.stringify(value); this.db.prepare("INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,json=excluded.json").run(kind, value.id, value.revision, s); this.db.prepare("INSERT INTO changes(kind,id,json) VALUES(?,?,?)").run(kind, value.id, s); return value; }
    transaction<T>(work: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try {
        const r = work();
        this.db.exec("COMMIT");
        return r;
    }
    catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
    } }
    once<T>(id: string, payload: unknown, work: () => T): T { return this.transaction(() => { const hash = digest(payload); const r = this.db.prepare("SELECT fingerprint,result FROM operations WHERE id=?").get(id); if (r) {
        if (r.fingerprint !== hash)
            throw new Error("core.errorOperationIdReusedForDifferentContent");
        return JSON.parse(String(r.result)) as T;
    } const result = work(); this.db.prepare("INSERT INTO operations VALUES(?,?,?)").run(id, hash, JSON.stringify(result ?? null)); return result; }); }
    requireSession(id: string) { const s = this.get<Session>("session", id); if (!s)
        throw new Error("core.errorSessionNoLongerExists"); return projectSessions([{ ...defaults, ...s, references: sourceReferences(s.references) }], this.now())[0]!; }
    revision<T extends {
        revision: number;
    }>(item: T | null, expected: number) { if ((item?.revision ?? 0) !== expected)
        throw new Error("core.errorRecordChangedReloadBeforeSaving"); }
    settings(): Settings {
        const stored: Settings & { doNotDisturbUntil?: number } = this.meta("settings") ?? DEFAULT_SETTINGS;
        // Before T9 a saved notification preference was always a user choice. T9
        // also saved automatic bubble defaults, which have no explicit marker.
        const notificationsExplicit = stored.notificationsExplicit ?? (stored.bubbleEnabled === undefined || stored.notifications !== (stored.bubbleEnabled === false));
        const dndUntil = stored.dndUntil ?? stored.doNotDisturbUntil;
        return { roots: stored.roots, ...(stored.observeAll === undefined ? {} : { observeAll: stored.observeAll }), notifications: notificationsEnabled({ ...stored, notificationsExplicit }), notificationsExplicit, pinned: stored.pinned, language: stored.language ?? DEFAULT_SETTINGS.language,
            captureShortcut: stored.captureShortcut ?? DEFAULT_SETTINGS.captureShortcut!, bubbleShortcut: stored.bubbleShortcut ?? "", bubbleEnabled: stored.bubbleEnabled ?? true,
            lastNewSessionApp: stored.lastNewSessionApp ?? "codex",
            ...(stored.bubblePosition ? { bubblePosition: stored.bubblePosition } : {}),
            ...(stored.bubbleHiddenUntil === undefined ? {} : { bubbleHiddenUntil: stored.bubbleHiddenUntil }),
            ...(dndUntil === undefined ? {} : { dndUntil }) };
    }
    setSettings(settings: Settings) { if (!validSettings(settings))
        throw new Error("core.errorInvalidSettings");
        const current = this.settings();
        const notificationsExplicit = settings.notificationsExplicit ?? current.notificationsExplicit ?? false;
        const bubbleEnabled = settings.bubbleEnabled ?? current.bubbleEnabled;
        this.setMeta("settings", { ...this.meta<Record<string, unknown>>("settings"), roots: settings.roots, observeAll: settings.observeAll,
            notifications: notificationsEnabled({ ...settings, bubbleEnabled: bubbleEnabled ?? true, notificationsExplicit }), notificationsExplicit, pinned: settings.pinned, language: settings.language,
            captureShortcut: settings.captureShortcut ?? current.captureShortcut, bubbleShortcut: settings.bubbleShortcut ?? current.bubbleShortcut, bubbleEnabled,
            lastNewSessionApp: settings.lastNewSessionApp ?? current.lastNewSessionApp,
            bubblePosition: settings.bubblePosition ?? current.bubblePosition, bubbleHiddenUntil: settings.bubbleHiddenUntil ?? current.bubbleHiddenUntil,
            dndUntil: settings.dndUntil ?? current.dndUntil }); for (const session of this.all<Session>("session")) {
        if (settings.observeAll===false && !settings.roots.some(r => inside(r, session.project)) && session.state !== "unknown")
            this.put("session", { ...session, sourceUncertain: true, subagentRunning: false, subagentWaitingAt: undefined, registry: { live: false }, state: "unknown", confidence: "unknown", revision: session.revision + 1, updatedAt: this.now() });
    } return this.settings(); }
    workspace(): Workspace {
        const at = this.now();
        const sessions = projectSessions(this.all<Session>("session").map(s => ({ ...defaults, ...s, references: sourceReferences(s.references) })), at).filter(s => !s.isChild);
        const ideas = this.db.prepare("SELECT json FROM ideas ORDER BY id").all().map(row => JSON.parse(String(row.json)) as Idea);
        const counts = new Map<string | null, number>();
        for (const idea of ideas) if (idea.status === "pending") counts.set(idea.sessionId, (counts.get(idea.sessionId) ?? 0) + 1);
        for (const session of sessions) {
            session.pendingIdeaCount = counts.get(session.id) ?? 0;
            const identity = this.meta<string>(`lastNotification:${session.id}`);
            if (identity) session.lastNotifiedIdentity = identity;
        }
        const drafts = Object.fromEntries(this.db.prepare("SELECT target,json FROM drafts").all().map(row => [String(row.target), JSON.parse(String(row.json)) as Draft]));
        const reports = this.db.prepare("SELECT report FROM imported").all().map(row => JSON.parse(String(row.report)) as { sessions?: number; ideas?: number });
        const legacyImport = { databases: reports.length, sessions: reports.reduce((sum, r) => sum + (r.sessions ?? 0), 0), ideas: reports.reduce((sum, r) => sum + (r.ideas ?? 0), 0) };
        return { sessions, drafts, ideas, inboxIdeaCount: counts.get(null) ?? 0, settings: this.settings(), seq: Number(this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM changes").get()!.seq), deviceId: this.deviceId, diagnostics: [...this.diagnostics], legacyImport };
    }

    observe(o: Observation): Session {
        return this.transaction(() => {
            const key = digest(`${this.deviceId}:${o.agent}:${o.nativeId}`).slice(0, 32);
            const nativeId = sourceIdentity(o.nativeId);
            const nativeKey = `native:${o.agent}:${nativeId}`;
            const id = this.meta<string>(nativeKey) ?? key;
            const old = this.get<Session>("session", id);
            // Imported rows are placeholders until their first native observation.
            const firstObservation = !old || old.sourceVersion === "legacy";
            const at = this.now();
            const observedAt = stamp(o.at) ?? stamp(at)!;
            const fresh = firstObservation || time(observedAt) >= time(old?.observedAt);
            const evidenceAt = stamp(o.sampledAt) ?? observedAt;
            const evidenceFresh = firstObservation || time(evidenceAt) >= time(old?.evidenceAt ?? old?.observedAt);
            // Read before merging this scan's header: a newly discovered header
            // prompt alone cannot establish continuity across an omitted interval.
            const storedLatest = o.trailingCompletion ? this.db.prepare("SELECT * FROM observations WHERE session_id=? ORDER BY prompt_at DESC,turn_key DESC LIMIT 2").all(id) : [];
            for (const incoming of (o.turns ?? []).slice(-20)) {
                const turn = cleanTurn(incoming);
                if (!turn) continue;
                // A lifecycle start may be replaced by the actual prompt time.
                // A native turn ID lets both windows resolve to the same row.
                const turnKey = digest([turn.promptAt, turn.turnId ?? ""]);
                const matchingPrompt = turn.turnId ? [] : this.db.prepare("SELECT * FROM observations WHERE session_id=? AND prompt_at=? LIMIT 2").all(id, turn.promptAt);
                const row = (turn.turnId ? this.db.prepare("SELECT * FROM observations WHERE session_id=? AND turn_id=? LIMIT 1").get(id, turn.turnId) : undefined)
                    ?? this.db.prepare("SELECT * FROM observations WHERE session_id=? AND turn_key=?").get(id, turnKey)
                    ?? (turn.turnId ? this.db.prepare("SELECT * FROM observations WHERE session_id=? AND prompt_at=? AND turn_id IS NULL LIMIT 1").get(id, turn.promptAt) : matchingPrompt.length === 1 ? matchingPrompt[0] : undefined);
                const previous = row ? JSON.parse(String(row.json)) as SourceTurn : undefined;
                const newer = !row || time(observedAt) >= time(String(row.observed_at));
                const merged: SourceTurn = previous ? {
                    ...(newer ? { ...previous, ...turn } : { ...turn, ...previous }),
                    endedAt: latest(previous.endedAt, turn.endedAt),
                    aborted: previous.aborted || turn.aborted || undefined,
                    errors: mergeFacts(previous.errors, turn.errors, 50),
                    changedFiles: newer ? mergeRecency(previous.changedFiles, turn.changedFiles, 200) : mergeRecency(turn.changedFiles, previous.changedFiles, 200),
                    failedCommands: mergeFacts(previous.failedCommands, turn.failedCommands, 50),
                } : turn;
                if (newer && !turn.factsThrough) delete merged.factsThrough;
                const json = JSON.stringify(merged);
                if (row?.json === json) continue;
                this.db.prepare(`INSERT INTO observations VALUES(?,?,?,?,?,?) ON CONFLICT(session_id,turn_key)
                    DO UPDATE SET prompt_at=excluded.prompt_at,turn_id=excluded.turn_id,observed_at=excluded.observed_at,json=excluded.json`)
                    .run(id, row ? String(row.turn_key) : turnKey, merged.promptAt, merged.turnId ?? null, latest(observedAt, row ? String(row.observed_at) : undefined)!, json);
            }
            let turns = this.turns(id), current = turns.at(-1);
            let unmatchedCompletion = old?.unmatchedCompletion;
            const completionAt = stamp(o.trailingCompletion?.endedAt);
            if (o.agent === "claude-code" && completionAt) {
                const completion: TurnCompletion = { endedAt: completionAt, ...(o.trailingCompletion?.lastAgentMessage ? boundedAgentMessage(o.trailingCompletion.lastAgentMessage, o.trailingCompletion.lastAgentMessageTruncated) : {}) };
                const row = storedLatest[0], previous = row ? JSON.parse(String(row.json)) as SourceTurn : undefined;
                const noNewerPrompt = previous && time(latest(old?.lastPromptAt, o.lastPromptAt, current?.promptAt)) <= time(previous.promptAt);
                const mergedLatest = this.db.prepare("SELECT turn_key,prompt_at FROM observations WHERE session_id=? ORDER BY prompt_at DESC,turn_key DESC LIMIT 2").all(id);
                const unambiguous = row && storedLatest[1]?.prompt_at !== row.prompt_at && mergedLatest[0]?.turn_key === row.turn_key && mergedLatest[1]?.prompt_at !== row.prompt_at;
                const canClose = previous && unambiguous && noNewerPrompt && !old?.unmatchedCompletion && time(previous.promptAt) < time(completionAt)
                    && !previous.aborted && (!previous.endedAt || previous.endedAt === completionAt)
                    && current && !current.aborted && (!current.endedAt || current.endedAt === completionAt);
                if (canClose && row && current) {
                    const closed: SourceTurn = { ...current, ...completion, factsThrough: current.factsThrough ?? String(row.observed_at), durationMs: current.durationMs ?? time(completionAt) - time(current.promptAt) };
                    const json = JSON.stringify(closed);
                    // Keep factsThrough: the terminal event closes the turn, but
                    // cannot make facts from the omitted interval complete.
                    if (row.json !== json) this.db.prepare("UPDATE observations SET observed_at=?,json=? WHERE session_id=? AND turn_key=?")
                        .run(latest(String(row.observed_at), observedAt)!, json, id, String(row.turn_key));
                    turns = this.turns(id); current = turns.at(-1);
                    if (time(unmatchedCompletion?.endedAt) <= time(completionAt)) unmatchedCompletion = undefined;
                } else if (evidenceFresh && time(completionAt) >= time(unmatchedCompletion?.endedAt)) unmatchedCompletion = completion;
            } else if (evidenceFresh && current && !o.sourceUncertain && o.state !== "unknown"
                && (time(current.promptAt) > time(unmatchedCompletion?.endedAt) || time(current.endedAt) >= time(unmatchedCompletion?.endedAt))) {
                unmatchedCompletion = undefined;
            }
            const lastPromptAt = latest(old?.lastPromptAt, o.lastPromptAt, current && (!current.endedAt || current.promptAt < current.endedAt) ? current.promptAt : undefined);
            let previousCompletion = old?.previousCompletion;
            const previousEnd = stamp(o.previousCompletion?.endedAt);
            if (previousEnd && time(previousEnd) < time(lastPromptAt) && time(previousEnd) >= time(previousCompletion?.endedAt)) {
                previousCompletion = { endedAt: previousEnd, ...(o.previousCompletion?.lastAgentMessage ? boundedAgentMessage(o.previousCompletion.lastAgentMessage, o.previousCompletion.lastAgentMessageTruncated) : {}) };
            }
            const lastTurnEndAt = latest(old?.lastTurnEndAt, ...turns.map(t => t.endedAt), previousCompletion?.endedAt);
            const lastActivityAt = latest(old?.lastActivityAt, o.lastMainRecordAt, observedAt);
            const entrypoint = o.agent === "codex" ? o.originator ?? o.entrypoint : o.entrypoint;
            const needsBaseline = firstObservation || old?.baselinePending === true || old?.lastViewedAt === undefined;
            const turnComplete = !current?.factsThrough || time(current.factsThrough) >= time(current.endedAt) && !!current.endedAt;
            const establishBaseline = needsBaseline && evidenceFresh && !o.sourceUncertain
                // An explicit abort is a terminal, certain observation even though its state reads "unknown".
                && o.confidence !== "unknown" && (o.state !== "unknown" || current?.aborted === true) && !unmatchedCompletion && turnComplete;
            // A bounded initial pass is still historical discovery, including after
            // restart or an explicit view. Only the first certain pass closes it.
            const lastViewedAt = establishBaseline
                ? latest(old?.lastViewedAt, latest(lastTurnEndAt, o.subagentWaitingAt) ?? lastActivityAt) : old?.lastViewedAt;
            const registry = o.registry ? { live: o.registry.live, ...(o.registry.status ? { status: redact(o.registry.status, 120) } : {}), ...(stamp(o.registry.statusUpdatedAt) ? { statusUpdatedAt: stamp(o.registry.statusUpdatedAt) } : {}) } : undefined;
            const s: Session = {
                ...defaults, ...old, id, revision: old?.revision ?? 0, updatedAt: old?.updatedAt ?? at,
                deviceId: this.deviceId, agent: o.agent, nativeId,
                title: fresh ? redact(o.title, 120) || old?.title || nativeId : old!.title,
                project: fresh ? redact(o.project, 4096) || old?.project || "" : old!.project,
                state: "unknown", observedAt: latest(old?.observedAt, observedAt)!,
                confidence: fresh ? o.confidence : old!.confidence,
                sourceVersion: fresh ? redact(o.version, 256) : old!.sourceVersion,
                references: fresh && o.sources.length ? o.sources.slice(-16).map(r => ({ id: redact(r.id, 256), kind: r.kind, time: stamp(r.time) ?? observedAt, excerpt: redact(r.excerpt, 1600) })) : sourceReferences(old?.references),
                sourceArchived: fresh ? o.archived ?? old?.sourceArchived ?? false : old!.sourceArchived,
                archived: fresh ? (o.archived ?? old?.sourceArchived ?? false) || (old?.manualArchived ?? (old?.sourceArchived === undefined && old?.archived) ?? false) : old!.archived,
                ...(fresh && o.parentNativeId ? { parentNativeId: sourceIdentity(o.parentNativeId) } : {}),
                ...(o.isChild ? { isChild: true } : {}),
                lastPromptAt, lastTurnEndAt,
                lastViewedAt,
                handledAt: establishBaseline ? latest(old?.handledAt, lastViewedAt) : needsBaseline ? old?.handledAt : old?.handledAt ?? lastViewedAt,
                baselinePending: needsBaseline && !establishBaseline || undefined,
                activity: fresh ? mergeActivity(old?.activity ?? [], o.activity ?? []) : mergeActivity(o.activity ?? [], old?.activity ?? []),
                activityIncomplete: evidenceFresh && o.activityIncomplete !== undefined
                    ? o.activityIncomplete || !!o.sourceUncertain && (old?.activityIncomplete ?? false) : old?.activityIncomplete ?? false,
                lastActivityAt,
                unmatchedCompletion,
                previousCompletion,
                sourceChangedAt: latest(old?.sourceChangedAt, o.sourceChangedAt ?? o.lastMainRecordAt ?? o.at),
                ...(evidenceFresh ? { evidenceAt, registry, subagentRunning: o.subagentRunning ?? false, subagentWaitingAt: stamp(o.subagentWaitingAt), sourceUncertain: !!o.sourceUncertain || o.state === "unknown" } : {}),
                ...(fresh && entrypoint ? { entrypoint: redact(entrypoint, 120) } : {}),
                ...(current ? { latestTurn: { identity: `turn:${this.db.prepare("SELECT turn_key FROM observations WHERE session_id=? ORDER BY prompt_at DESC,turn_key DESC LIMIT 1").get(id)!.turn_key}`,
                    promptAt: current.promptAt, endedAt: current.endedAt, durationMs: current.durationMs, aborted: current.aborted, factsThrough: current.factsThrough } } : {}),
            };
            s.surface = sessionSurface(s);
            if (evidenceFresh && isRegistryWaiting(s) && (!old || !isRegistryWaiting(old) || old.registryWaitingEntry === undefined)) {
                s.registryWaitingEntry = (old?.registryWaitingEntry ?? 0) + 1;
            }
            s.interactive = isInteractiveSession({ agent: s.agent, entrypoint: s.entrypoint });
            if (time(lastPromptAt) > time(old?.lastPromptAt) && time(lastPromptAt) >= time(s.deactivatedAt)) delete s.deactivatedAt;
            const projected = projectSessions([JSON.parse(JSON.stringify(s)) as Session], at)[0]!;
            if (old && JSON.stringify({ ...projected, evidenceAt: old.evidenceAt }) === JSON.stringify(old)) {
                // Rechecking liveness advances its ordering boundary, not the user revision.
                if (projected.evidenceAt !== old.evidenceAt) this.db.prepare("UPDATE records SET json=? WHERE kind='session' AND id=?").run(JSON.stringify(projected), id);
                return projected;
            }
            this.setMeta(nativeKey, id);
            return this.put("session", { ...projected, revision: (old?.revision ?? 0) + 1, updatedAt: at });
        });
    }
    turns(sessionId: string, limit = 20): SourceTurn[] {
        return this.db.prepare("SELECT json FROM observations WHERE session_id=? ORDER BY prompt_at DESC,turn_key DESC LIMIT ?")
            .all(sessionId, Math.max(1, Math.min(20, Math.floor(limit) || 20))).map(row => JSON.parse(String(row.json)) as SourceTurn).reverse();
    }
    catchup(sessionId: string): CatchUp {
        const now = this.now();
        const session = projectSessions(this.all<Session>("session").map(s => ({ ...defaults, ...s, references: sourceReferences(s.references) })), now).find(s => s.id === sessionId);
        if (!session) throw new Error("core.errorSessionNoLongerExists");
        // Unlike discovery's 20-turn tail, the card includes every stored turn in its window.
        const turns = this.db.prepare("SELECT json FROM observations WHERE session_id=? ORDER BY prompt_at,turn_key")
            .all(sessionId).map(row => JSON.parse(String(row.json)) as SourceTurn);
        const ideas = this.db.prepare("SELECT json FROM ideas WHERE session_id=? AND status='pending' ORDER BY id")
            .all(sessionId).map(row => JSON.parse(String(row.json)) as Idea);
        return projectCatchUp(session, turns, ideas, now);
    }
    missingSources(seen: ReadonlySet<string>) {
        for (const session of this.all<Session>("session")) {
            if (seen.has(session.id) || session.sourceUncertain && !session.registry?.live && !session.subagentRunning && !session.subagentWaitingAt) continue;
            this.put("session", { ...session, sourceUncertain: true, registry: { live: false }, subagentRunning: false, subagentWaitingAt: undefined, state: "unknown", revision: session.revision + 1, updatedAt: this.now() });
        }
    }
    /** Hide rows discovered by older parsers without deleting their ideas or history. */
    hideCodexChildren(children: readonly Pick<Observation, "nativeId" | "parentNativeId">[]) {
        for (const child of children) {
            const id = this.meta<string>(`native:codex:${sourceIdentity(child.nativeId)}`);
            const session = id ? this.get<Session>("session", id) : null;
            if (!session || session.isChild) continue;
            this.put("session", { ...session, isChild: true, active: false,
                ...(child.parentNativeId ? { parentNativeId: sourceIdentity(child.parentNativeId) } : {}),
                revision: session.revision + 1, updatedAt: this.now() });
        }
    }
    private idea(id: string): Idea | null {
        const row = this.db.prepare("SELECT json FROM ideas WHERE id=?").get(id);
        return row ? JSON.parse(String(row.json)) as Idea : null;
    }
    private putIdea(idea: Idea) {
        const json = JSON.stringify(idea);
        this.db.prepare("INSERT INTO ideas VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,status=excluded.status,revision=excluded.revision,json=excluded.json").run(idea.id, idea.sessionId, idea.status, idea.revision, json);
        this.db.prepare("INSERT INTO changes(kind,id,json) VALUES('idea',?,?)").run(idea.id, json);
        return idea;
    }
    private importIdea(sourceKey: string, sessionId: string | null, body: string, createdAt: string, updatedAt: string) {
        // The source key outlives a purge, so another import cannot resurrect an idea.
        if (this.db.prepare("SELECT idea_id FROM idea_imports WHERE source_key=?").get(sourceKey)) return false;
        const id = randomUUID();
        // Historical text predates the 4000-code-point input limit; migrate it losslessly.
        this.putIdea({ id, sessionId, body, status: "pending", createdAt, updatedAt, revision: 1 });
        this.db.prepare("INSERT INTO idea_imports VALUES(?,?)").run(sourceKey, id);
        return true;
    }
    private putDraft(draft: Draft) {
        const json = JSON.stringify(draft);
        this.db.prepare("INSERT INTO drafts VALUES(?,?,?) ON CONFLICT(target) DO UPDATE SET revision=excluded.revision,json=excluded.json").run(draft.target, draft.revision, json);
        this.db.prepare("INSERT INTO changes(kind,id,json) VALUES('draft',?,?)").run(draft.target, json);
        return draft;
    }
    private requireIdea(id: string, expectedRevision: number) {
        const idea = this.idea(id);
        if (!idea) throw new Error("core.errorIdeaNoLongerExists");
        this.revision(idea, expectedRevision);
        return idea;
    }
    call(r: CoreRequest): unknown { if (!validRequest(r))
        throw new Error("core.errorInvalidRequest"); switch (r.method) {
        case "workspace": return this.workspace();
        case "catchup": return this.catchup(r.sessionId);
        case "notification.claim": return this.once(r.operationId, r, () => {
            const session = this.requireSession(r.sessionId);
            if (![notificationIdentity(session, "waiting"), notificationIdentity(session, "completion")].includes(r.identity)) return false;
            const key = `notification:${digest([r.sessionId, r.identity])}`;
            if (this.meta(key)) return false;
            this.revision(null, r.expectedRevision);
            this.setMeta(key, { revision: 1, at: this.now() });
            this.setMeta(`lastNotification:${r.sessionId}`, r.identity);
            return true;
        });
        case "idea.save": return this.once(r.operationId, r, () => {
            if (r.sessionId !== null) this.requireSession(r.sessionId);
            const old = r.id ? this.requireIdea(r.id, r.expectedRevision) : null;
            this.revision(old, r.expectedRevision);
            if (old && old.sessionId !== r.sessionId) throw new Error("core.errorUseIdeaMoveToChangeTheOwner");
            if (!r.body.trim()) throw new Error("core.errorIdeaIsEmpty");
            const at = this.now();
            return this.putIdea({ ...old, id: old?.id ?? randomUUID(), sessionId: r.sessionId, body: r.body,
                status: old?.status ?? "pending", createdAt: old?.createdAt ?? at, updatedAt: at, revision: (old?.revision ?? 0) + 1 });
        });
        case "idea.move": return this.once(r.operationId, r, () => {
            const idea = this.requireIdea(r.id, r.expectedRevision);
            if (r.sessionId !== null && !isIdeaTargetSession(this.requireSession(r.sessionId)))
                throw new Error("core.errorChooseARootInteractiveSessionOrTheInboxChildAndNonInteractiveSessionsCannotReceiveMovedIdeas");
            return this.putIdea({ ...idea, sessionId: r.sessionId, revision: idea.revision + 1, updatedAt: this.now() });
        });
        case "idea.setStatus": return this.once(r.operationId, r, () => {
            const idea = this.requireIdea(r.id, r.expectedRevision);
            if (idea.status === r.status) return idea;
            if (idea.status !== "pending" && r.status !== "pending") throw new Error("core.errorRestoreTheIdeaToPendingFirst");
            const { broughtAt: _brought, discardedAt: _discarded, ...rest } = idea;
            const at = this.now();
            return this.putIdea({ ...rest, status: r.status, revision: idea.revision + 1, updatedAt: at,
                ...(r.status === "brought" ? { broughtAt: at } : {}), ...(r.status === "discarded" ? { discardedAt: at } : {}) });
        });
        case "idea.purge": return this.once(r.operationId, r, () => {
            const idea = this.requireIdea(r.id, r.expectedRevision);
            if (idea.status !== "discarded") throw new Error("core.errorOnlyDiscardedIdeasCanBePurged");
            this.db.prepare("DELETE FROM ideas WHERE id=?").run(idea.id);
            const result = { id: idea.id, revision: idea.revision + 1, purged: true };
            this.db.prepare("INSERT INTO changes(kind,id,json) VALUES('idea',?,?)").run(idea.id, JSON.stringify(result));
            return result;
        });
        case "draft.save": return this.once(r.operationId, r, () => {
            if (r.target !== "inbox" && r.target !== "capture") this.requireSession(r.target);
            const key = r.target === "capture" ? CAPTURE_DRAFT_KEY : r.target;
            const row = this.db.prepare("SELECT revision FROM drafts WHERE target=?").get(key);
            this.revision(row ? { revision: Number(row.revision) } : null, r.expectedRevision);
            return this.putDraft({ target: key, body: r.body, revision: r.expectedRevision + 1, updatedAt: this.now() });
        });
        case "legacy.export": return this.once(r.operationId, r, () => this.exportLegacy(r.path));
        case "session.archive": return this.once(r.operationId, r, () => { const s = this.requireSession(r.sessionId); return this.put("session", { ...projectSessions([{ ...s, manualArchived: r.archived, archived: r.archived || !!s.sourceArchived }], this.now())[0]!, revision: s.revision + 1, updatedAt: this.now() }); });
        case "session.viewed":
        case "session.handled":
        case "session.pin":
        case "session.unpin":
        case "session.deactivate": return this.once(sourceIdentity(r.operationId), r, () => {
            const s = this.requireSession(r.sessionId); this.revision(s, r.expectedRevision);
            const at = stamp(this.now())!;
            if (r.method === "session.viewed") {
                if (time(r.at) > time(at)) throw new Error("core.errorViewTimeIsInTheFuture");
                s.lastViewedAt = latest(s.lastViewedAt, r.at ?? at);
            }
            if (r.method === "session.handled") {
                if (time(r.at) > time(at)) throw new Error("core.errorHandledTimeIsInTheFuture");
                s.handledAt = latest(s.handledAt, r.at ?? at);
            }
            if (r.method === "session.pin" || r.method === "session.unpin") s.pinned = r.method === "session.pin";
            if (r.method === "session.deactivate") s.deactivatedAt = at;
            return this.put("session", { ...projectSessions([s], at)[0]!, revision: s.revision + 1, updatedAt: at });
        });
        case "settings.save": return this.setSettings(r.settings);
        default: throw new Error("core.errorRequestNeedsTheNativeAdapter");
    } }
    private exportLegacy(path: string) {
        const databases = this.db.prepare("PRAGMA database_list").all().filter(row => row.name !== "temp").map(row => ({ name: String(row.name), schema: String(row.name), db: this.db }));
        const opened: DatabaseSync[] = [];
        const imports = this.db.prepare("SELECT source,report FROM imported LIMIT 257").all();
        if (imports.length > 256) throw new Error("core.errorTooManyLegacyDatabasesToExport");
        try {
            for (const row of imports) {
                const report = JSON.parse(String(row.report)) as { recovery?: string };
                const source = report.recovery && existsSync(report.recovery) ? report.recovery : String(row.source);
                if (!existsSync(source)) throw new Error("core.errorLegacyDatabaseUnavailableExportCanceled");
                readSource(source, 32);
                const db = new DatabaseSync(source, { readOnly: true });
                opened.push(db);
                db.exec("BEGIN");
                databases.push({ name: `legacy:${row.source}`, schema: "main", db });
            }
            return exportLegacyTables(path, databases);
        } finally { for (const db of opened) db.close(); }
    }
    async importLegacy(path: string) {
        if (!existsSync(path)) return;
        const previous = this.db.prepare("SELECT report FROM imported WHERE source=?").get(path);
        // Previous versions imported unrelated features too. Leave those rows intact;
        // migration 2 already converted their memo records without re-importing them.
        if (previous) return;
        readSource(path, 32);
        const legacy = new DatabaseSync(path, { readOnly: true });
        const recovery = join(this.directory, `legacy-${randomUUID()}.sqlite3`);
        let snapshot: DatabaseSync | undefined;
        try {
            await backup(legacy, recovery);
            privateFile(recovery);
            snapshot = new DatabaseSync(recovery, { readOnly: true });
            const source = snapshot;
            const report = this.transaction(() => {
                const mapping = new Map<string, string>();
                let sessions = 0, ideas = 0;
                for (const row of legacyRows(source, "sessions")) {
                    const agent = row.agent === "codex" ? "codex" : "claude-code";
                    const nativeId = String(row.native_session_id ?? row.id);
                    const session = this.observeLegacySession(agent, nativeId, row);
                    mapping.set(String(row.id), session.id);
                    sessions++;
                }
                const links = new Map<string, string>();
                for (const row of legacyRows(source, "matter_session_links")) {
                    const sessionId = mapping.get(String(row.session_id));
                    if (!row.unlinked_at && sessionId && !links.has(String(row.matter_id))) links.set(String(row.matter_id), sessionId);
                }
                for (const name of ["memos", "notes", "captures"]) {
                    for (const row of legacyRows(source, name)) {
                        const sessionId = mapping.get(String(row.session_id)) ?? links.get(String(row.matter_id)) ?? null;
                        if (this.importIdea(`legacy:${digest(path)}:${name}:${row.id}`, sessionId, String(row.body ?? ""), String(row.created_at ?? this.now()), String(row.updated_at ?? row.created_at ?? this.now()))) ideas++;
                    }
                }
                const summary = { sessions, ideas, recovery };
                this.db.prepare("INSERT INTO imported VALUES(?,?)").run(path, JSON.stringify(summary));
                this.setMeta("importReport", summary);
                return summary;
            });
            return report;
        } finally { snapshot?.close(); legacy.close(); }
    }
    private observeLegacySession(agent: Session["agent"], nativeId: string, row: Record<string, unknown>): Session {
        const key = `native:${agent}:${sourceIdentity(nativeId)}`;
        const existingId = this.meta<string>(key);
        const existing = existingId ? this.get<Session>("session", existingId) : null;
        if (existing) return existing;
        const at = stamp(String(row.observation_observed_at ?? this.now())) ?? this.now();
        const id = digest(`${this.deviceId}:${agent}:${nativeId}`).slice(0, 32);
        const session: Session = { ...defaults, id, revision: 1, updatedAt: this.now(), deviceId: this.deviceId, agent, nativeId: sourceIdentity(nativeId), title: redact(String(row.title ?? "Imported session"), 300), project: redact(String(row.project_path ?? ""), 4096), state: "unknown", observedAt: at, lastActivityAt: at, lastViewedAt: at, handledAt: at, confidence: "unknown", sourceVersion: "legacy", references: [], archived: false };
        this.put("session", session);
        this.setMeta(key, id);
        return session;
    }
}
