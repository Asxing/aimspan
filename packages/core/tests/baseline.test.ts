import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Discovery } from "../src/adapters.js";
import { Store } from "../src/store.js";
import { parseClaudeRecords } from "../src/claude.js";
import type { Observation } from "../src/store.js";
import type { Session } from "@aimspan/protocol";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 18, 8, 0, seconds)).toISOString();
const project = "/Users/__aimspan_fixture__/project";
const jsonl = (records: unknown[]) => records.map(record => JSON.stringify(record)).join("\n") + "\n";
const codexTurn = (start: number, end: number) => [
    { type: "event_msg", timestamp: at(start), payload: { type: "task_started", turn_id: `turn-${start}` } },
    { type: "event_msg", timestamp: at(end), payload: { type: "task_complete", turn_id: `turn-${start}`, last_agent_message: `answer ${end}` } },
];
const observation: Observation = { agent: "claude-code", nativeId: "history", title: "History", project,
    state: "ended", at: at(5), confidence: "explicit", sources: [], version: "fixture",
    turns: [{ promptAt: at(0), endedAt: at(5), errors: [], changedFiles: [], failedCommands: [] }] };

function fixture(t: { after(fn: () => void): void }) {
    const root = mkdtempSync("/private/tmp/__aimspan_fixture__-baseline-");
    const codex = join(root, "codex"), claude = join(root, "claude");
    mkdirSync(join(codex, "sessions"), { recursive: true });
    mkdirSync(join(claude, "projects", "fixture"), { recursive: true });
    let store = new Store(join(root, "state"), () => at(100));
    t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
    return { codex, claude, get store() { return store; }, reopen() { store.close(); store = new Store(join(root, "state"), () => at(100)); } };
}

test("T20 baseline: Codex multi-pass history stays seen after restart and only later completions are new", async t => {
    const f = fixture(t), path = join(f.codex, "sessions", "rollout-baseline.jsonl");
    const filler = { type: "response_item", payload: { output: "x".repeat(90 * 1024) } };
    writeFileSync(path, jsonl([{ type: "session_meta", payload: { id: "history", cwd: project } },
        ...codexTurn(0, 5), filler, ...codexTurn(10, 15), filler, ...codexTurn(20, 25)]));
    const discovery = () => new Discovery(f.store, f, {}, { maxFileBytes: 64 * 1024 });
    let reader = discovery();
    await reader.scan();
    assert.equal(f.store.workspace().sessions[0]!.sourceUncertain, true);
    assert.equal(f.store.workspace().sessions[0]!.baselinePending, true);
    assert.equal(f.store.workspace().sessions[0]!.lastViewedAt, undefined);
    assert.equal(f.store.workspace().sessions[0]!.handledAt, undefined);
    f.reopen(); reader = discovery();
    const snapshots = [];
    for (let pass = 0; pass < 10; pass++) {
        await reader.scan();
        const s = f.store.workspace().sessions[0]!;
        snapshots.push(s);
        if (!s.sourceUncertain) break;
    }
    assert.ok(snapshots.length >= 3);
    const complete = snapshots.at(-1)!;
    assert.equal(complete.sourceUncertain, false);
    assert.equal(complete.lastTurnEndAt, at(25));
    assert.equal(complete.state, "idle", "finishing the initial read must not make historical results wait");
    assert.ok(snapshots.every(s => s.state !== "waiting" && !s.hasNewResult), "partial history must not produce attention");
    assert.equal(complete.lastViewedAt, at(25)); assert.equal(complete.handledAt, at(25));
    assert.equal(complete.baselinePending, undefined);
    f.reopen(); reader = discovery();
    for (let pass = 0; pass < 10; pass++) { await reader.scan(); if (!f.store.workspace().sessions[0]!.sourceUncertain) break; }
    assert.equal(f.store.workspace().sessions[0]!.lastViewedAt, at(25));
    appendFileSync(path, jsonl(codexTurn(30, 35)));
    await reader.scan();
    const next = f.store.workspace().sessions[0]!;
    assert.equal(next.state, "waiting"); assert.equal(next.hasNewResult, true);
    assert.equal(next.lastViewedAt, at(25)); assert.equal(next.handledAt, at(25));
});

test("T20 baseline: Claude uncertain first observation waits for a certain transcript before baselining", t => {
    const f = fixture(t);
    const turn = (start: number, end: number) => [
        { type: "user", timestamp: at(start), sessionId: "history", cwd: project, message: { content: "prompt" } },
        { type: "assistant", timestamp: at(end), message: { content: "reply", stop_reason: "end_turn" } },
    ];
    const parse = (records: unknown[]) => parseClaudeRecords(records, { nativeId: "history", mtime: at(25) });
    const partial = f.store.observe(parse([...turn(0, 5), { type: "aimspan_read_gap" }]));
    assert.equal(partial.hasNewResult, false);
    assert.equal(partial.baselinePending, true);
    f.reopen();
    const complete = f.store.observe(parse([...turn(0, 5), ...turn(10, 15)]));
    assert.equal(complete.state, "idle", "Claude recovery must baseline all initial history");
    assert.equal(complete.hasNewResult, false);
    assert.equal(complete.lastViewedAt, at(15)); assert.equal(complete.handledAt, at(15));
    const next = f.store.observe(parse([...turn(0, 5), ...turn(10, 15), ...turn(20, 25)]));
    assert.equal(next.state, "waiting"); assert.equal(next.hasNewResult, true);
});

test("T20 baseline: pending survives view and handling, suppresses historical children, and honors live registry waiting", t => {
    const f = fixture(t);
    let s = f.store.observe({ ...observation, sourceUncertain: true, subagentWaitingAt: at(10) });
    assert.equal(s.state, "unknown"); assert.equal(s.hasNewResult, false);
    s = f.store.call({ method: "session.viewed", sessionId: s.id, expectedRevision: s.revision, operationId: "view", at: at(6) }) as Session;
    s = f.store.call({ method: "session.handled", sessionId: s.id, expectedRevision: s.revision, operationId: "handle", at: at(7) }) as Session;
    assert.equal(s.baselinePending, true);
    f.reopen();
    const later: Observation = { ...observation, at: at(15), subagentWaitingAt: at(20),
        turns: [{ ...observation.turns![0]!, endedAt: at(15) }] };
    s = f.store.observe({ ...later, sourceUncertain: true });
    assert.equal(s.state, "unknown"); assert.equal(s.hasNewResult, false);
    assert.equal(s.lastViewedAt, at(6)); assert.equal(s.handledAt, at(7));
    s = f.store.observe({ ...later, confidence: "unknown" });
    assert.equal(s.baselinePending, true);
    assert.equal(f.store.observe({ ...observation, sampledAt: at(4) }).baselinePending, true, "stale certainty must not finish discovery");
    // A separately persisted child's completion must not bypass the parent's pending baseline.
    f.store.observe({ ...observation, nativeId: "child", parentNativeId: "history", state: "working", turns: [{ ...observation.turns![0]!, endedAt: undefined }] });
    f.store.observe({ ...later, nativeId: "child", parentNativeId: "history" });
    assert.notEqual(f.store.workspace().sessions.find(row => row.id === s.id)!.state, "waiting");
    s = f.store.observe({ ...later, sourceUncertain: true, registry: { live: true, status: "waiting" } });
    assert.equal(s.state, "waiting"); assert.equal(s.hasNewResult, false); assert.equal(s.baselinePending, true);
    s = f.store.observe(later);
    assert.equal(s.baselinePending, undefined);
    assert.equal(s.lastViewedAt, at(20)); assert.equal(s.handledAt, at(20));
    assert.equal(s.state, "idle"); assert.equal(s.hasNewResult, false);
});

test("T20 baseline: later uncertain observations never reset an established baseline", t => {
    const f = fixture(t);
    f.store.observe(observation);
    const later: Observation = { ...observation, at: at(15), turns: [{ ...observation.turns![0]!, endedAt: at(15) }] };
    const partial = f.store.observe({ ...later, sourceUncertain: true });
    assert.equal(partial.baselinePending, undefined);
    assert.equal(partial.lastViewedAt, at(5)); assert.equal(partial.handledAt, at(5));
    f.reopen();
    const complete = f.store.observe(later);
    assert.equal(complete.state, "waiting"); assert.equal(complete.hasNewResult, true);
    assert.equal(complete.lastViewedAt, at(5)); assert.equal(complete.handledAt, at(5));
});

test("T20 baseline: first certain open turn uses activity time and its later completion is new", t => {
    const f = fixture(t);
    const open: Observation = { ...observation, state: "working", at: at(3),
        turns: [{ ...observation.turns![0]!, endedAt: undefined }] };
    f.store.observe({ ...open, sourceUncertain: true });
    const certain = f.store.observe({ ...open, at: at(4) });
    assert.equal(certain.state, "running"); assert.equal(certain.baselinePending, undefined);
    assert.equal(certain.lastViewedAt, at(4)); assert.equal(certain.handledAt, at(4));
    const completed = f.store.observe(observation);
    assert.equal(completed.state, "waiting"); assert.equal(completed.hasNewResult, true);
});

test("T20 baseline: legacy placeholders remain pending until fresh native evidence is certain", t => {
    const f = fixture(t);
    const legacy = f.store.observe({ ...observation, at: at(50), state: "unknown", confidence: "unknown", version: "legacy", turns: [] });
    f.store.put("session", { ...legacy, lastViewedAt: at(50), handledAt: at(50) });
    const pending = f.store.observe({ ...observation, sourceUncertain: true });
    assert.equal(pending.baselinePending, true);
    const certain = f.store.observe({ ...observation, at: at(15), sampledAt: at(60), turns: [{ ...observation.turns![0]!, endedAt: at(15) }] });
    assert.equal(certain.baselinePending, undefined);
    assert.equal(certain.lastViewedAt, at(50)); assert.equal(certain.handledAt, at(50));
    const next = f.store.observe({ ...observation, at: at(70), turns: [{ ...observation.turns![0]!, promptAt: at(65), endedAt: at(70) }] });
    assert.equal(next.state, "waiting"); assert.equal(next.hasNewResult, true);
});
