import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import type { Observation } from "../src/store.js";
import { deriveState, hasNewResult, isActive } from "../src/state.js";
import { CLAUDE_REGISTRY_STATES } from "../src/claude.js";
import { CLAUDE_SURFACES, CODEX_SURFACES, NON_INTERACTIVE_IDENTIFIERS, isInteractiveSession, sessionSurface, validRequest, validRendererRequest } from "@aimspan/protocol";
import type { Session } from "@aimspan/protocol";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 16, 8, 0, seconds)).toISOString();
const open: Observation = { agent: "codex", nativeId: "parent", title: "任务", project: "/Users/__aimspan_fixture__/project", state: "working", at: at(0), confidence: "inferred", sources: [], version: "open", lastPromptAt: at(0), turns: [{ promptAt: at(0), turnId: "turn-1", errors: [], changedFiles: [], failedCommands: [] }] };
const ended: Observation = { ...open, state: "ended", at: at(10), version: "ended", turns: [{ ...open.turns![0]!, endedAt: at(10), lastAgentMessage: "完成" }] };
function fixture(t: { after(fn: () => void): void }) {
    const directory = mkdtempSync("/private/tmp/__aimspan_fixture__-state-");
    let now = at(1), store = new Store(directory, () => now);
    t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    return { directory, get store() { return store; }, now(value: number) { now = at(value); }, reopen() { store.close(); store = new Store(directory, () => now); } };
}

test("deriveState: prompt, finish, view, gap, abort and the exact two-hour boundary", () => {
    const s = { agent: "codex" as const, lastPromptAt: at(0), sourceChangedAt: at(0) };
    assert.equal(deriveState(s, at(7199.999)), "running");
    assert.equal(deriveState(s, at(7200)), "unknown");
    assert.equal(deriveState({ ...s, sourceChangedAt: at(100) }, at(7200)), "running");
    assert.equal(deriveState({ ...s, lastTurnEndAt: at(10) }, at(11)), "waiting");
    assert.equal(deriveState({ ...s, lastTurnEndAt: at(10), lastViewedAt: at(10) }, at(11)), "waiting");
    assert.equal(deriveState({ ...s, lastTurnEndAt: at(10), handledAt: at(10) }, at(11)), "idle");
    assert.equal(deriveState({ ...s, latestTurn: { promptAt: at(0), factsThrough: at(1) } }, at(2)), "unknown");
    assert.equal(deriveState({ ...s, lastTurnEndAt: at(2), latestTurn: { promptAt: at(0), endedAt: at(2), aborted: true } }, at(3)), "idle");
    assert.equal(deriveState({ agent: "codex" }, at(0)), "unknown");
    assert.equal(hasNewResult({ ...s, lastTurnEndAt: at(10), lastViewedAt: at(10) }), false);
});

test("the sole registry mapping contributes only busy/waiting; unknown/idle do not invent completion", () => {
    assert.deepEqual(Object.keys(CLAUDE_REGISTRY_STATES).sort(), ["busy", "waiting", "needs_user", "requires_action", "blocked", "idle", "paused", "needs_trust"].sort());
    for (const status of ["busy", "waiting", "needs_user", "requires_action", "blocked", "idle", "paused", "needs_trust", "running", "future", "toString"]) {
        const s = { agent: "claude-code" as const, registry: { live: true, status } };
        assert.equal(deriveState(s, at(0)), status === "busy" ? "running" : ["waiting", "needs_user", "requires_action", "blocked"].includes(status) ? "waiting" : "unknown");
        assert.equal(deriveState({ ...s, registry: { ...s.registry, live: false } }, at(0)), "unknown");
    }
    const waiting = { agent: "claude-code" as const, lastPromptAt: at(0), sourceChangedAt: at(0), registry: { live: true, status: "waiting" } };
    assert.equal(deriveState(waiting, at(1)), "waiting");
    assert.equal(deriveState({ ...waiting, subagentRunning: true }, at(1)), "running");
});

test("active set honors the 12-hour boundary, pin, removal, archive and unread child results", () => {
    const s = { agent: "codex" as const, archived: false, lastPromptAt: at(0), sourceChangedAt: at(0), lastTurnEndAt: at(10), lastViewedAt: at(20), handledAt: at(20) };
    assert.equal(isActive(s, at(20 + 43200 - 0.001)), true);
    assert.equal(isActive(s, at(20 + 43200)), false);
    assert.equal(isActive({ ...s, pinned: true }, at(100000)), true);
    assert.equal(isActive({ ...s, pinned: true, deactivatedAt: at(30) }, at(31)), false);
    assert.equal(isActive({ ...s, pinned: true, archived: true }, at(31)), false);
    assert.equal(isActive({ ...s, handledAt: undefined }, at(100000)), true);
    assert.equal(deriveState({ ...s, subagentWaitingAt: at(30) }, at(31)), "waiting");
});

test("persisted lifecycle, markers, operation replay and restart preserve notes and draft verbatim", t => {
    const f = fixture(t);
    let s = f.store.observe(open);
    assert.equal(s.state, "running");
    f.store.call({ method: "idea.save", sessionId: s.id, body: "  token=user-owned\n原文  ", operationId: "memo", expectedRevision: 0 });
    f.store.call({ method: "draft.save", expectedRevision: 0, operationId: "draft", target: s.id, body: "草稿" });
    f.now(11); s = f.store.observe(ended);
    assert.equal(s.state, "waiting"); assert.equal(s.hasNewResult, true);
    const viewed = { method: "session.viewed" as const, sessionId: s.id, expectedRevision: s.revision, operationId: "view", at: at(11) };
    s = f.store.call(viewed) as Session;
    assert.equal(s.state, "waiting"); assert.equal(s.hasNewResult, false);
    assert.deepEqual(f.store.call(viewed), s);
    assert.throws(() => f.store.call({ ...viewed, operationId: "stale" }), /core\.errorRecordChangedReloadBeforeSaving/);
    f.now(12);
    s = f.store.call({ method: "session.deactivate", sessionId: s.id, expectedRevision: s.revision, operationId: "remove" }) as Session;
    assert.equal(s.active, false);
    assert.equal(f.store.observe(ended).active, false);
    f.now(13);
    s = f.store.observe({ ...open, lastPromptAt: at(13), at: at(13), version: "new", turns: [{ ...open.turns![0]!, promptAt: at(13), turnId: "turn-2" }] });
    assert.equal(s.state, "running"); assert.equal(s.active, true); assert.equal(s.deactivatedAt, undefined);
    f.reopen();
    assert.equal(f.store.workspace().sessions[0]!.state, "running");
    assert.equal(f.store.workspace().ideas[0]!.body, "  token=user-owned\n原文  ");
    assert.equal(f.store.workspace().drafts[s.id]?.body, "草稿");
    assert.equal(f.store.turns(s.id).length, 2);
    f.now(8000);
    assert.equal(f.store.workspace().sessions[0]!.state, "unknown");
});

test("reparse and out-of-order observations merge facts without reopening turns or erasing markers", t => {
    const f = fixture(t); f.now(20);
    const s = f.store.observe(ended);
    assert.deepEqual(f.store.observe(ended), s);
    assert.deepEqual(f.store.observe(open), s);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM observations").get()!.n, 1);
    f.store.observe({ ...open, turns: [{ ...open.turns![0]!, changedFiles: ["/Users/__aimspan_fixture__/older.ts"] }] });
    assert.equal(f.store.requireSession(s.id).state, "idle");
    assert.deepEqual(f.store.turns(s.id)[0]!.changedFiles, ["/Users/__aimspan_fixture__/older.ts"]);
    f.store.observe({ ...ended, at: at(11), version: "unknown", state: "unknown", sourceUncertain: true, turns: [] });
    assert.equal(f.store.requireSession(s.id).state, "unknown");
    assert.equal(f.store.turns(s.id)[0]!.lastAgentMessage, "完成");
});

test("turn identity distinguishes simultaneous turns and reconciles later native IDs/prompt times", t => {
    const f = fixture(t); f.now(30);
    const s = f.store.observe(open);
    f.store.observe({ ...open, at: at(1), version: "prompt", lastPromptAt: at(1), turns: [{ ...open.turns![0]!, promptAt: at(1) }] });
    assert.equal(f.store.turns(s.id).length, 1);
    f.store.observe({ ...open, at: at(2), version: "second", turns: [{ ...open.turns![0]!, promptAt: at(1), turnId: "turn-2" }] });
    assert.equal(f.store.turns(s.id).length, 2);
    f.store.observe({ ...open, at: at(3), version: "anonymous", turns: [{ ...open.turns![0]!, promptAt: at(3), turnId: undefined }] });
    f.store.observe({ ...open, at: at(4), version: "identified", turns: [{ ...open.turns![0]!, promptAt: at(3), turnId: "turn-3" }] });
    assert.equal(f.store.turns(s.id).length, 3);
});

test("every persisted source string is redacted and per-turn facts remain bounded", t => {
    const f = fixture(t), secret = "api_key=synthetic-secret";
    const s = f.store.observe({ ...ended, nativeId: secret, parentNativeId: secret, title: secret, project: secret, entrypoint: secret, version: secret,
        registry: { live: true, status: secret, statusUpdatedAt: at(10) }, sources: [{ id: secret, kind: "agent", time: at(0), excerpt: secret }],
        turns: [{ ...ended.turns![0]!, turnId: secret, lastAgentMessage: secret + "x".repeat(21000), awaySummary: secret,
            errors: Array(100).fill(secret) as string[], changedFiles: Array(300).fill(secret) as string[], failedCommands: Array(60).fill(secret) as string[] }] });
    const dump = JSON.stringify([f.store.db.prepare("SELECT * FROM records").all(), f.store.db.prepare("SELECT * FROM changes").all(), f.store.db.prepare("SELECT * FROM observations").all(), f.store.db.prepare("SELECT * FROM metadata").all()]);
    assert.doesNotMatch(dump, /synthetic-secret/);
    const turn = f.store.turns(s.id)[0]!;
    assert.equal(turn.errors.length, 50); assert.equal(turn.changedFiles.length, 200); assert.equal(turn.failedCommands.length, 50);
    assert.ok(turn.lastAgentMessage!.length <= 20000);
});

test("pin/unpin and request validators require valid revisions and operation IDs", t => {
    const f = fixture(t); f.now(100000);
    let s = f.store.observe({ ...ended, at: at(10) });
    s = f.store.call({ method: "session.viewed", sessionId: s.id, at: at(20), expectedRevision: s.revision, operationId: "view" }) as Session;
    assert.equal(s.active, false);
    for (const method of ["session.pin", "session.unpin"] as const) {
        const r = { method, sessionId: s.id, expectedRevision: s.revision, operationId: method };
        s = f.store.call(r) as Session;
        assert.equal(s.active, method === "session.pin"); assert.deepEqual(f.store.call(r), s);
        assert.equal(validRequest({ ...r, expectedRevision: -1 }), false);
        assert.equal(validRequest({ ...r, operationId: "" }), false);
    }
    assert.equal(validRequest({ method: "session.viewed", sessionId: s.id, expectedRevision: s.revision, operationId: "v", at: "invalid" }), false);
    assert.throws(() => f.store.call({ method: "session.viewed", sessionId: s.id, expectedRevision: s.revision, operationId: "future", at: at(100001) }), /core\.error(?:View|Handled)TimeIsInTheFuture/);
});

test("liveness rechecks do not invalidate revisions; unknown samples retain all prior turn facts", t => {
    const f = fixture(t); f.now(20);
    const s = f.store.observe({ ...ended, sampledAt: at(10) });
    const seq = f.store.workspace().seq;
    f.now(30);
    assert.equal(f.store.observe({ ...ended, sampledAt: at(30) }).revision, s.revision);
    assert.equal(f.store.workspace().seq, seq);
    const unknown = f.store.observe({ ...ended, sampledAt: at(40), state: "unknown", turns: [], version: "unknown" });
    assert.equal(unknown.state, "unknown");
    assert.equal(f.store.turns(s.id)[0]!.lastAgentMessage, "完成");
    assert.equal(f.store.observe({ ...ended, sampledAt: at(35) }).state, "unknown");
});

test("distinct native identities cannot merge through equal titles, paths, agents or redaction", t => {
    const f = fixture(t);
    const sessions = [open, { ...open, nativeId: "another" }, { ...open, agent: "claude-code" as const },
        { ...open, nativeId: "api_key=synthetic-one" }, { ...open, nativeId: "api_key=synthetic-two" }].map(o => f.store.observe(o));
    assert.equal(new Set(sessions.map(s => s.id)).size, 5);
    assert.equal(f.store.workspace().sessions.length, 5);
});

test("bounded projections keep earlier stored turns and do not overwrite same-time identities", t => {
    const f = fixture(t); f.now(1000);
    let id = "";
    for (let i = 0; i < 40; i++) id = f.store.observe({ ...ended, at: at(i * 2 + 1), lastPromptAt: at(i * 2), version: String(i),
        turns: [{ ...ended.turns![0]!, promptAt: at(i * 2), endedAt: at(i * 2 + 1), turnId: String(i) }] }).id;
    assert.equal(f.store.turns(id).length, 20);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM observations WHERE session_id=?").get(id)!.n, 40);
});

test("a persisted running/waiting child activates its parent; only handling acknowledges a finished child", t => {
    const f = fixture(t); f.now(100000);
    let parent = f.store.observe(ended);
    parent = f.store.call({ method: "session.viewed", sessionId: parent.id, expectedRevision: parent.revision, at: at(20), operationId: "view-old" }) as Session;
    assert.equal(parent.active, false);
    f.store.observe({ ...open, nativeId: "child", parentNativeId: "parent", at: at(99990), lastPromptAt: at(99990),
        turns: [{ ...open.turns![0]!, promptAt: at(99990) }] });
    assert.equal(f.store.workspace().sessions.find(s => s.id === parent.id)!.state, "running");
    f.store.observe({ ...ended, nativeId: "child", parentNativeId: "parent", at: at(99999), lastPromptAt: at(99990),
        turns: [{ ...ended.turns![0]!, promptAt: at(99990), endedAt: at(99999) }] });
    assert.equal(f.store.workspace().sessions.find(s => s.id === parent.id)!.state, "waiting");
    parent = f.store.call({ method: "session.viewed", sessionId: parent.id, expectedRevision: parent.revision, operationId: "view-child" }) as Session;
    assert.equal(f.store.workspace().sessions.find(s => s.id === parent.id)!.state, "waiting");
    f.store.call({ method: "session.handled", sessionId: parent.id, expectedRevision: parent.revision, operationId: "handle-child" });
    assert.equal(f.store.workspace().sessions.find(s => s.id === parent.id)!.state, "idle");
});

test("first observation baselines historical ended sessions in a fresh profile", t => {
    const f = fixture(t); f.now(100000);
    for (const agent of ["codex", "claude-code"] as const) {
        const s = f.store.observe({ ...ended, agent });
        assert.equal(s.lastViewedAt, at(10));
        assert.equal(s.handledAt, at(10));
        assert.equal(s.state, "idle"); assert.equal(s.hasNewResult, false); assert.equal(s.active, false);
        assert.equal(f.store.observe({ ...ended, agent }).lastViewedAt, at(10));
    }
    f.reopen();
    assert.equal(f.store.workspace().sessions.filter(s => s.state === "waiting" || s.hasNewResult).length, 0);
    assert.equal(f.store.workspace().sessions.length, 2);
});

test("first observation also baselines historical folded child completions", t => {
    const f = fixture(t); f.now(100000);
    const s = f.store.observe({ ...ended, subagentWaitingAt: at(20), at: at(20) });
    assert.equal(s.lastViewedAt, at(20)); assert.equal(s.state, "idle"); assert.equal(s.active, false);
    assert.equal(s.hasNewResult, false);
});

test("pre-T4 stored sessions without lastViewedAt are baselined exactly once on upgrade", t => {
    const f = fixture(t); f.now(100000);
    for (const [nativeId, observation, baseline] of [["ended", ended, at(10)], ["open", open, at(0)]] as const) {
        const previous = { id: nativeId, revision: 3, updatedAt: at(0), deviceId: f.store.deviceId, agent: "codex", nativeId,
            title: "历史会话", project: open.project, state: "working", observedAt: at(0), confidence: "inferred", sourceVersion: "pre-T4-native", references: [], archived: false };
        f.store.db.prepare("INSERT INTO records VALUES('session',?,?,?)").run(nativeId, previous.revision, JSON.stringify(previous));
        f.store.setMeta(`native:codex:${nativeId}`, nativeId);
        const s = f.store.observe({ ...observation, nativeId });
        assert.equal(s.lastViewedAt, baseline);
        assert.equal(s.handledAt, baseline);
        assert.equal(s.hasNewResult, false);
        assert.notEqual(s.state, "waiting");
        f.reopen();
        assert.equal(f.store.observe({ ...observation, nativeId }).lastViewedAt, baseline);
        const completed = f.store.observe({ ...ended, nativeId, version: "new-result", at: at(30), lastPromptAt: at(20),
            turns: [{ ...ended.turns![0]!, promptAt: at(20), endedAt: at(30), turnId: "next" }] });
        assert.equal(completed.lastViewedAt, baseline); assert.equal(completed.state, "waiting"); assert.equal(completed.hasNewResult, true);
    }
});

test("a turn ending after first observation becomes waiting without moving the baseline", t => {
    const f = fixture(t); f.now(6);
    const s = f.store.observe({ ...open, at: at(5), lastMainRecordAt: at(5) });
    assert.equal(s.lastViewedAt, at(5)); assert.equal(s.state, "running");
    assert.equal(s.handledAt, at(5));
    f.now(11);
    const completed = f.store.observe(ended);
    assert.equal(completed.lastViewedAt, at(5)); assert.equal(completed.state, "waiting"); assert.equal(completed.hasNewResult, true);
    assert.equal(completed.handledAt, at(5));
    f.reopen();
    assert.equal(f.store.requireSession(s.id).hasNewResult, true);
});

test("legacy-imported sessions are baselined on their first native observation only", async t => {
    const f = fixture(t); f.now(200);
    const path = join(f.directory, "aimspan.sqlite3"), legacy = new DatabaseSync(path);
    legacy.exec("CREATE TABLE sessions(id,agent,native_session_id,title,project_path,observation_observed_at)");
    for (const [id, observedAt] of [["older", at(-10)], ["newer", at(100)]]) {
        legacy.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?)").run(id!, "codex", id!, "历史会话", open.project, observedAt!);
    }
    legacy.close();
    await f.store.importLegacy(path);
    assert.ok(f.store.workspace().sessions.every(s => s.lastViewedAt && !s.hasNewResult));
    for (const nativeId of ["older", "newer"]) {
        const s = f.store.observe({ ...ended, nativeId });
        assert.equal(s.state, "idle"); assert.equal(s.hasNewResult, false); assert.notEqual(s.sourceVersion, "legacy");
        assert.equal(s.lastViewedAt, nativeId === "older" ? at(10) : at(100));
        const next = f.store.observe({ ...ended, nativeId, version: "next", at: at(130), lastPromptAt: at(120),
            turns: [{ ...ended.turns![0]!, turnId: "next", promptAt: at(120), endedAt: at(130) }] });
        assert.equal(next.lastViewedAt, s.lastViewedAt); assert.equal(next.state, "waiting"); assert.equal(next.hasNewResult, true);
    }
    f.reopen();
    assert.ok(f.store.workspace().sessions.every(s => s.hasNewResult));
});

test("non-interactive identifiers preserve execution state but never become active or waiting", t => {
    const f = fixture(t);
    const automation: Observation[] = [
        { ...open, nativeId: "exec", originator: "codex_exec", entrypoint: "cli" },
        ...["sdk-cli", "sdk-ts", "sdk-py"].map(entrypoint => ({ ...open, agent: "claude-code" as const, nativeId: entrypoint, entrypoint })),
    ];
    for (const o of automation) {
        let s = f.store.observe(o);
        assert.equal(s.interactive, false); assert.equal(s.state, "running"); assert.equal(s.active, false);
        s = f.store.call({ method: "session.pin", sessionId: s.id, expectedRevision: s.revision, operationId: `pin:${s.id}` }) as Session;
        assert.equal(s.active, false);
        f.now(11);
        s = f.store.observe({ ...o, at: at(10), state: "ended", version: "done", turns: ended.turns! });
        assert.equal(s.state, "idle"); assert.equal(s.active, false);
        s = f.store.observe({ ...o, at: at(11), state: "waiting", version: "waiting", turns: ended.turns!, registry: { live: true, status: "waiting" } });
        assert.equal(s.state, "idle"); assert.equal(s.active, false);
        assert.equal(f.store.get<Session>("session", s.id)!.interactive, false);
    }
    f.reopen();
    assert.equal(f.store.workspace().sessions.length, 4);
    assert.ok(f.store.workspace().sessions.every(s => !s.interactive && !s.active && s.state !== "waiting"));
    for (const o of [{ ...open, originator: "sdk-cli" }, { ...open, agent: "claude-code" as const, entrypoint: "codex_exec" }, { ...open, nativeId: "unspecified" }]) {
        assert.equal(f.store.observe(o).interactive, true);
    }
});

test("non-interactive children cannot activate parents and non-interactive parents cannot inherit waiting", t => {
    const f = fixture(t); f.now(100000);
    const parent = f.store.observe(ended);
    f.store.observe({ ...open, nativeId: "automation-child", parentNativeId: parent.nativeId, originator: "codex_exec", at: at(99999), sourceChangedAt: at(99999) });
    let projected = f.store.workspace().sessions.find(s => s.id === parent.id)!;
    assert.equal(projected.state, "idle"); assert.equal(projected.active, false);
    const automatedParent = f.store.observe({ ...ended, nativeId: "automation-parent", originator: "codex_exec" });
    f.store.observe({ ...open, nativeId: "child", parentNativeId: automatedParent.nativeId, sourceChangedAt: at(99999) });
    f.store.observe({ ...ended, nativeId: "child", parentNativeId: automatedParent.nativeId });
    projected = f.store.workspace().sessions.find(s => s.id === automatedParent.id)!;
    assert.equal(projected.interactive, false); assert.equal(projected.active, false); assert.equal(projected.state, "idle");
});

test("latest aborted turn is idle with no new result through registry, child folding and restart", t => {
    const f = fixture(t);
    const s = f.store.observe({ ...open, agent: "claude-code" });
    f.now(12);
    const aborted = f.store.observe({ ...ended, agent: "claude-code", version: "abort", state: "unknown", subagentRunning: true,
        registry: { live: true, status: "busy" }, turns: [{ ...ended.turns![0]!, aborted: true, errors: ["interrupted"] }] });
    assert.equal(aborted.lastViewedAt, at(0)); assert.equal(aborted.lastTurnEndAt, at(10));
    assert.equal(aborted.state, "idle"); assert.equal(aborted.hasNewResult, false);
    f.store.observe({ ...open, agent: "claude-code", nativeId: "child", parentNativeId: "parent", at: at(11) });
    assert.equal(f.store.workspace().sessions.find(row => row.id === s.id)!.state, "idle");
    f.reopen();
    assert.equal(f.store.requireSession(s.id).state, "idle"); assert.equal(f.store.requireSession(s.id).hasNewResult, false);
    assert.equal(f.store.turns(s.id)[0]!.aborted, true); assert.deepEqual(f.store.turns(s.id)[0]!.errors, ["interrupted"]);
    const next = f.store.observe({ ...open, agent: "claude-code", version: "next", at: at(20), lastPromptAt: at(20),
        turns: [{ ...open.turns![0]!, turnId: "next", promptAt: at(20) }] });
    assert.equal(next.state, "running"); assert.equal(next.hasNewResult, false);
});

test("T20 handled is revisioned, monotonic, replayable and independent of viewed through restart", t => {
    const f = fixture(t);
    f.store.observe(open); f.now(100000);
    let s = f.store.observe(ended);
    const baseline = s.handledAt;
    s = f.store.call({ method: "session.viewed", sessionId: s.id, expectedRevision: s.revision, operationId: "view", at: at(20) }) as Session;
    assert.equal(s.state, "waiting"); assert.equal(s.active, true); assert.equal(s.hasNewResult, false);
    assert.equal(s.handledAt, baseline);
    f.reopen();
    assert.equal(f.store.requireSession(s.id).state, "waiting");
    const request = { method: "session.handled" as const, sessionId: s.id, expectedRevision: s.revision, operationId: "handle", at: at(30) };
    assert.equal(validRendererRequest(request), true);
    s = f.store.call(request) as Session;
    assert.equal(s.state, "idle"); assert.equal(s.active, false); assert.equal(s.handledAt, at(30)); assert.equal(s.lastViewedAt, at(20));
    assert.deepEqual(f.store.call(request), s);
    assert.throws(() => f.store.call({ ...request, operationId: "stale" }), /core\.errorRecordChangedReloadBeforeSaving/);
    assert.throws(() => f.store.call({ ...request, at: at(31) }), /core\.errorOperationIdReusedForDifferentContent/);
    for (const patch of [{ at: "invalid" }, { expectedRevision: -1 }, { operationId: "" }, { sessionId: "" }]) assert.equal(validRequest({ ...request, ...patch }), false);
    assert.throws(() => f.store.call({ ...request, expectedRevision: s.revision, operationId: "future", at: at(100001) }), /core\.error(?:View|Handled)TimeIsInTheFuture/);
    s = f.store.call({ ...request, expectedRevision: s.revision, operationId: "older", at: at(15) }) as Session;
    assert.equal(s.handledAt, at(30));
    f.reopen();
    assert.equal(f.store.requireSession(s.id).handledAt, at(30));
    s = f.store.observe({ ...ended, at: at(50), lastPromptAt: at(40), turns: [{ ...ended.turns![0]!, turnId: "next", promptAt: at(40), endedAt: at(50) }] });
    assert.equal(s.state, "waiting"); assert.equal(s.hasNewResult, true);
    s = f.store.call({ method: "session.handled", sessionId: s.id, expectedRevision: s.revision, operationId: "handle-unviewed" }) as Session;
    assert.equal(s.state, "idle"); assert.equal(s.hasNewResult, true); assert.equal(s.lastViewedAt, at(20));
});

test("T20 handling cannot dismiss live registry waiting; a new prompt ends completed-turn waiting", t => {
    const f = fixture(t); f.now(50);
    let s = f.store.observe({ ...ended, agent: "claude-code", registry: { live: true, status: "waiting" } });
    s = f.store.call({ method: "session.handled", sessionId: s.id, expectedRevision: s.revision, operationId: "handle" }) as Session;
    assert.equal(s.state, "waiting");
    s = f.store.observe({ ...ended, agent: "claude-code", at: at(51), registry: { live: true, status: "idle" } });
    assert.equal(s.state, "idle");
    f.store.observe(open);
    const waiting = f.store.observe(ended);
    assert.equal(waiting.state, "waiting");
    const next = f.store.observe({ ...open, at: at(20), lastPromptAt: at(20), turns: [{ ...open.turns![0]!, turnId: "next", promptAt: at(20) }] });
    assert.equal(next.state, "running"); assert.equal(next.hasNewResult, false);
});

test("T20 migration 4 baselines handled once and preserves ideas, drafts, operations and observations", t => {
    const f = fixture(t); f.now(100);
    const originals = [
        { ...f.store.observe({ ...ended, nativeId: "viewed", originator: "Codex Desktop" }), lastViewedAt: at(5), handledAt: undefined },
        { ...f.store.observe({ ...ended, nativeId: "unviewed" }), lastViewedAt: undefined, handledAt: undefined, subagentWaitingAt: at(15) },
        { ...f.store.observe({ ...open, nativeId: "open" }), lastViewedAt: undefined, handledAt: undefined },
        { ...f.store.observe({ ...ended, nativeId: "already-handled" }), handledAt: at(40) },
    ];
    for (const s of originals) f.store.put("session", s);
    const s = originals[0]!;
    f.store.call({ method: "idea.save", sessionId: s.id, body: "  原文 token=user-owned  ", expectedRevision: 0, operationId: "idea" });
    f.store.call({ method: "draft.save", target: s.id, body: "草稿", expectedRevision: 0, operationId: "draft" });
    const retained = () => ["ideas", "drafts", "operations", "observations"].map(table => f.store.db.prepare(`SELECT * FROM ${table}`).all());
    const before = retained();
    f.store.db.exec("DELETE FROM schema_migrations WHERE version=4");
    f.reopen();
    assert.deepEqual(retained(), before);
    for (const [index, baseline] of [at(5), at(15), at(0), at(40)].entries()) assert.equal(f.store.requireSession(originals[index]!.id).handledAt, baseline);
    assert.equal(f.store.requireSession(s.id).state, "waiting");
    assert.equal(f.store.requireSession(s.id).surface, "desktop");
    assert.deepEqual(f.store.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map(row => row.version), [1, 2, 3, 4]);
    const migrated = f.store.all<Session>("session");
    f.reopen();
    assert.deepEqual(f.store.all<Session>("session"), migrated);
    assert.equal(f.store.observe({ ...ended, nativeId: "viewed" }).handledAt, at(5));
});

test("T20 every known native surface has one mapping and automation matches the shared gate", t => {
    const f = fixture(t);
    const expected = {
        "claude-code": { "claude-desktop": "desktop", cli: "cli", "claude-vscode": "vscode", "sdk-cli": "automation", "sdk-ts": "automation", "sdk-py": "automation" },
        codex: { "Codex Desktop": "desktop", codex_cli_rs: "cli", "codex-tui": "cli", codex_vscode: "vscode", vscode_agent_host: "vscode", codex_exec: "automation", codex_work_desktop: "desktop" },
    };
    assert.deepEqual(CLAUDE_SURFACES, expected["claude-code"]); assert.deepEqual(CODEX_SURFACES, expected.codex);
    for (const agent of ["codex", "claude-code"] as const) {
        for (const [identifier, surface] of [...Object.entries(expected[agent]), ["future", "unknown"], ["toString", "unknown"], ["__proto__", "unknown"], ["", "unknown"]]) {
            const observation: Observation = { ...open, agent, nativeId: `${agent}:${identifier}`, ...(agent === "codex" ? { originator: identifier!, entrypoint: "cli" } : { entrypoint: identifier! }) };
            assert.equal(sessionSurface(observation), surface);
            assert.equal(isInteractiveSession(observation), surface !== "automation");
            assert.equal(f.store.observe(observation).surface, surface);
            assert.equal(NON_INTERACTIVE_IDENTIFIERS[agent].includes(identifier!), surface === "automation");
        }
    }
    const s = f.store.observe({ ...open, nativeId: "stale", originator: "codex_vscode", at: at(5) });
    assert.equal(f.store.observe({ ...open, nativeId: "stale", originator: "Codex Desktop" }).surface, "vscode");
    f.reopen();
    assert.equal(f.store.requireSession(s.id).surface, "vscode");
});

test("T20 only registry waiting can keep a handled parent waiting for a completed child", t => {
    const f = fixture(t); f.now(100);
    const parent = f.store.observe({ ...ended, agent: "claude-code" });
    f.store.observe({ ...open, agent: "claude-code", nativeId: "child", parentNativeId: "parent" });
    f.store.observe({ ...ended, agent: "claude-code", nativeId: "child", parentNativeId: "parent", at: at(20),
        turns: [{ ...ended.turns![0]!, endedAt: at(20) }], registry: { live: true, status: "idle" } });
    assert.equal(f.store.workspace().sessions.find(s => s.id === parent.id)!.state, "waiting");
    f.store.call({ method: "session.handled", sessionId: parent.id, expectedRevision: parent.revision, operationId: "handle-parent" });
    assert.equal(f.store.workspace().sessions.find(s => s.id === parent.id)!.state, "idle");
    f.store.observe({ ...ended, agent: "claude-code", nativeId: "child", parentNativeId: "parent", at: at(30), registry: { live: true, status: "waiting" } });
    assert.equal(f.store.workspace().sessions.find(s => s.id === parent.id)!.state, "waiting");
});
