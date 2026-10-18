import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { formatBringBack, validRequest, validRendererRequest, type CatchUp, type Idea, type Session } from "@aimspan/protocol";
import { Store } from "../src/store.js";
import type { SourceTurn } from "../src/source.js";
import { parseClaudeRecords } from "../src/claude.js";
import { parseCodexRecords } from "../src/codex.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 16, 8, 0, seconds)).toISOString();
const path = (name: string) => `/Users/__aimspan_fixture__/project/${name}`;
function fixture(t: TestContext) {
    const directory = mkdtempSync("/private/tmp/__aimspan_fixture__-catchup-");
    let store = new Store(directory, () => at(100));
    t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    return { get store() { return store; }, reopen() { store.close(); store = new Store(directory, () => at(100)); } };
}
function turn(prompt: number, end?: number, extra: Partial<SourceTurn> = {}): SourceTurn {
    return { promptAt: at(prompt), ...(end === undefined ? {} : { endedAt: at(end) }), errors: [], changedFiles: [], failedCommands: [], ...extra };
}
function seed(store: Store, turns: SourceTurn[] = [], markers: Partial<Session> = {}): Session {
    const session = store.observe({ agent: "claude-code", nativeId: "parent", title: "合成会话", project: path(""),
        state: "ended", at: at(90), confidence: "explicit", sources: [], version: "fixture", turns });
    // Exercise missing/old markers without changing production first-observation baselines.
    return store.put("session", { ...session, lastPromptAt: undefined, lastViewedAt: undefined, ...markers });
}
function read(store: Store, sessionId: string): CatchUp {
    return store.call({ method: "catchup", sessionId }) as CatchUp;
}

test("catchup chooses the later prompt/view marker and excludes ends exactly at the anchor", t => {
    const f = fixture(t);
    const turns = [turn(1, 5), turn(6, 10), turn(11, 20)];
    for (const markers of [
        { lastPromptAt: at(10), lastViewedAt: at(5) },
        { lastPromptAt: at(5), lastViewedAt: at(10) },
        { lastPromptAt: at(10) }, { lastViewedAt: at(10) },
    ]) {
        const s = seed(f.store, turns, markers), card = read(f.store, s.id);
        assert.equal(card.anchor, at(10));
        assert.equal(card.turnsSinceAnchor, 1);
        assert.equal(card.state, f.store.workspace().sessions[0]!.state);
    }
});

test("no markers includes only the last turn; no observations has an explicit empty projection", t => {
    const f = fixture(t);
    let s = seed(f.store);
    assert.deepEqual(read(f.store, s.id), {
        activity: [], activityIncomplete: false,
        anchor: null, state: "unknown", durationMsOfCurrentOrLastTurn: null, turnsSinceAnchor: 0,
        pendingIdeas: [], truncated: false, factsIncomplete: false, errors: [], changedFiles: [], failedCommands: [],
    });
    s = seed(f.store, [turn(1, 5, { changedFiles: [path("old")] }), turn(6, 10, { lastAgentMessage: "最后一轮", durationMs: 1234 })]);
    const card = read(f.store, s.id);
    assert.equal(card.anchor, null);
    assert.equal(card.turnsSinceAnchor, 1);
    assert.equal(card.durationMsOfCurrentOrLastTurn, 1234);
    assert.deepEqual(card.changedFiles, []);
    assert.deepEqual(card.lastAgentMessage, { body: "最后一轮", fromBeforeAnchor: false });
});

test("window facts aggregate by end time, files keep last occurrence, repeated failures remain", t => {
    const f = fixture(t);
    const s = seed(f.store, [
        turn(0, 1, { errors: ["before"], changedFiles: [path("before")], failedCommands: ["before"], awaySummary: "旧摘要" }),
        turn(2, 20, { errors: ["retry"], changedFiles: [path("a"), path("c"), path("b")], failedCommands: ["pnpm test"], lastAgentMessage: "最后完成", awaySummary: "新摘要" }),
        turn(3, 10, { errors: ["retry"], changedFiles: [path("a"), path("b")], failedCommands: ["pnpm test"], lastAgentMessage: "先完成" }),
        turn(30, undefined, { errors: ["open"], changedFiles: [path("open")], failedCommands: ["open"], lastAgentMessage: "尚未结束", awaySummary: "未结束摘要" }),
    ], { lastViewedAt: at(1) });
    const card = read(f.store, s.id);
    assert.equal(card.turnsSinceAnchor, 2);
    assert.deepEqual(card.changedFiles, [path("a"), path("c"), path("b")]);
    assert.deepEqual(card.errors, ["retry", "retry"]);
    assert.deepEqual(card.failedCommands, ["pnpm test", "pnpm test"]);
    assert.equal(card.awaySummary, "新摘要");
    assert.deepEqual(card.lastAgentMessage, { body: "最后完成", fromBeforeAnchor: false });
    assert.equal(card.durationMsOfCurrentOrLastTurn, 70_000);
    assert.equal(card.state, "running");
});

test("an open turn only supplies duration; fallback replies are marked and old facts stay outside", t => {
    const f = fixture(t);
    const s = seed(f.store, [turn(1, 5, { lastAgentMessage: "上轮结果", awaySummary: "旧摘要", errors: ["旧错误"] }), turn(10)], { lastPromptAt: at(10) });
    const card = read(f.store, s.id);
    assert.equal(card.turnsSinceAnchor, 0);
    assert.equal(card.durationMsOfCurrentOrLastTurn, 90_000);
    assert.deepEqual(card.lastAgentMessage, { body: "上轮结果", fromBeforeAnchor: true });
    assert.equal(card.awaySummary, undefined);
    assert.deepEqual(card.errors, []);
    const noMarkers = seed(f.store, [], {});
    assert.equal(read(f.store, noMarkers.id).turnsSinceAnchor, 0);
    assert.equal(read(f.store, noMarkers.id).lastAgentMessage?.fromBeforeAnchor, true);
});

test("empty latest ended reply does not borrow text from an earlier completed turn", t => {
    const f = fixture(t);
    const s = seed(f.store, [turn(1, 5, { lastAgentMessage: "旧回复" }), turn(6, 10)], { lastViewedAt: at(0) });
    assert.equal(read(f.store, s.id).lastAgentMessage, undefined);
    assert.equal(read(f.store, s.id).durationMsOfCurrentOrLastTurn, 4000);
    f.store.put("session", { ...s, lastViewedAt: at(10) });
    assert.equal(read(f.store, s.id).lastAgentMessage, undefined);
});

test("factsIncomplete concerns ended turns in the window and stays separate from text truncation", t => {
    const f = fixture(t);
    const s = seed(f.store, [turn(1, 10, { factsThrough: at(3), lastAgentMessage: "尾部仍可读" }), turn(11, 20, { factsThrough: at(20) })], { lastViewedAt: at(0) });
    assert.equal(read(f.store, s.id).factsIncomplete, true);
    assert.equal(read(f.store, s.id).truncated, false);
    f.store.put("session", { ...s, lastViewedAt: at(10) });
    assert.equal(read(f.store, s.id).factsIncomplete, false);
    f.store.put("session", { ...s, lastViewedAt: at(20) });
    assert.equal(read(f.store, s.id).factsIncomplete, false);
});

test("aborted turns count and expose interruption even without a native error string", t => {
    const f = fixture(t);
    const s = seed(f.store, [turn(1, 2, { aborted: true, errors: ["API failure"] }), turn(3, 4, { aborted: true, errors: ["interrupted"] })], { lastViewedAt: at(0) });
    const card = read(f.store, s.id);
    assert.equal(card.turnsSinceAnchor, 2);
    assert.equal(card.state, "idle");
    assert.deepEqual(card.errors, ["API failure", "aborted", "interrupted"]);
});

test("pending ideas include all ages, only this session, and survive read/view/restart verbatim", t => {
    const f = fixture(t);
    const s = seed(f.store, [turn(1, 2, { lastAgentMessage: "完成" })], { lastViewedAt: at(0) });
    const other = f.store.observe({ agent: "codex", nativeId: "other", title: s.title, project: s.project, state: "unknown", at: at(0), confidence: "unknown", sources: [], version: "other" });
    const body = "  用户原文 token=不要脱敏\n中文😀  ";
    const save = (sessionId: string | null, operationId: string) => f.store.call({ method: "idea.save", sessionId, body, expectedRevision: 0, operationId }) as Idea;
    const pending = save(s.id, "pending");
    save(other.id, "other"); save(null, "inbox");
    for (const status of ["brought", "discarded"] as const) {
        const idea = save(s.id, `save-${status}`);
        f.store.call({ method: "idea.setStatus", id: idea.id, status, expectedRevision: idea.revision, operationId: status });
    }
    const before = f.store.workspace(), writes = f.store.db.prepare("SELECT total_changes() AS n").get()!.n;
    const card = read(f.store, s.id);
    assert.deepEqual(card.pendingIdeas, [pending]);
    assert.equal(card.pendingIdeas[0]!.body, body);
    assert.deepEqual(read(f.store, s.id), card);
    assert.equal(f.store.db.prepare("SELECT total_changes() AS n").get()!.n, writes);
    assert.deepEqual(f.store.workspace(), before);
    f.reopen();
    assert.deepEqual(read(f.store, s.id), card);
    f.store.call({ method: "session.viewed", sessionId: s.id, expectedRevision: s.revision, operationId: "view" });
    const after = read(f.store, s.id);
    assert.equal(after.anchor, at(100));
    assert.equal(after.turnsSinceAnchor, 0);
    assert.equal(after.lastAgentMessage?.fromBeforeAnchor, true);
    assert.deepEqual(after.pendingIdeas, [pending]);
});

test("catchup reads beyond the discovery tail and uses Workspace's folded child state", t => {
    const f = fixture(t);
    let s = seed(f.store);
    for (let i = 0; i < 25; i++) {
        s = f.store.observe({ agent: "claude-code", nativeId: "parent", title: s.title, project: s.project, state: "ended", at: at(i * 2 + 2), confidence: "explicit", sources: [], version: String(i),
            turns: [turn(i * 2 + 1, i * 2 + 2, { changedFiles: [path(String(i))] })] });
    }
    f.store.put("session", { ...s, lastPromptAt: at(0), lastViewedAt: at(0) });
    f.store.observe({ agent: "claude-code", nativeId: "child", parentNativeId: "parent", title: "子会话", project: s.project, state: "working", at: at(90), confidence: "explicit", sources: [], version: "child", turns: [turn(90)] });
    const card = read(f.store, s.id);
    assert.equal(f.store.turns(s.id).length, 20);
    assert.equal(card.turnsSinceAnchor, 25);
    assert.equal(card.changedFiles.length, 25);
    assert.equal(card.state, "running");
    assert.equal(card.state, f.store.workspace().sessions.find(session => session.id === s.id)!.state);
});

test("huge replies stay capped and flagged through storage and restart; exact cap is not truncated", t => {
    const f = fixture(t);
    const s = seed(f.store, [turn(1, 2, { lastAgentMessage: "字".repeat(20_001) })], { lastViewedAt: at(0) });
    assert.equal(read(f.store, s.id).lastAgentMessage!.body.length, 20_000);
    assert.equal(read(f.store, s.id).truncated, true);
    f.reopen();
    assert.equal(read(f.store, s.id).truncated, true);
    seed(f.store, [turn(3, 4, { lastAgentMessage: "字".repeat(20_000) })], { lastViewedAt: at(0) });
    assert.equal(read(f.store, s.id).truncated, false);
    seed(f.store, [turn(5, 6, { lastAgentMessage: "新回复" })], { lastViewedAt: at(0) });
    assert.equal(read(f.store, s.id).truncated, false);
    assert.equal(read(f.store, s.id).lastAgentMessage!.body, "新回复");
});

test("native parsers retain truncation metadata, including Codex final-phase and Claude tail completions", t => {
    const f = fixture(t), huge = "字".repeat(20_001), exact = "字".repeat(20_000);
    const fallback = { nativeId: "parsed", mtime: at(10) };
    const claude = (body: string, prompt = true) => parseClaudeRecords([
        ...(prompt ? [{ type: "user", timestamp: at(1), message: { content: "合成指令" } }] : []),
        { type: "assistant", timestamp: at(5), message: { content: body, stop_reason: "end_turn" } },
    ], fallback);
    const codex = (body: string, explicit: boolean) => parseCodexRecords([
        { type: "event_msg", timestamp: at(1), payload: { type: "task_started", turn_id: "parsed-turn" } },
        { type: "event_msg", timestamp: at(2), payload: { type: "item_completed", item: { type: "AgentMessage", content: body, phase: "final_answer" } } },
        { type: "event_msg", timestamp: at(3), payload: { type: "item_completed", item: { type: "AgentMessage", content: "后续状态", phase: "commentary" } } },
        { type: "event_msg", timestamp: at(5), payload: { type: "task_complete", turn_id: "parsed-turn", ...(explicit ? { last_agent_message: body } : {}) } },
    ], fallback);
    for (const body of [huge, exact, "短回复"]) for (const observation of [claude(body), codex(body, true), codex(body, false)]) {
        const s = f.store.observe(observation);
        assert.equal(read(f.store, s.id).truncated, body === huge);
        assert.equal(read(f.store, s.id).lastAgentMessage!.body, body.slice(0, 20_000));
    }
    assert.equal(claude(huge, false).trailingCompletion?.lastAgentMessageTruncated, true);
    assert.equal(claude(exact, false).trailingCompletion?.lastAgentMessageTruncated, false);
});

test("a same-turn replacement clears an earlier truncation flag without erasing facts", t => {
    const f = fixture(t);
    const s = seed(f.store, [turn(1, 2, { lastAgentMessage: "x".repeat(20_001), changedFiles: [path("a")] })]);
    seed(f.store, [turn(1, 2, { lastAgentMessage: "完整的新文本" })]);
    const card = read(f.store, s.id);
    assert.equal(card.truncated, false);
    assert.deepEqual(card.lastAgentMessage, { body: "完整的新文本", fromBeforeAnchor: false });
    assert.deepEqual(card.changedFiles, [path("a")]);
});

test("legacy capped replies remain visible and conservatively flagged without rewriting stored rows", t => {
    const f = fixture(t);
    const s = seed(f.store, [turn(1, 2, { lastAgentMessage: "x".repeat(20_000) })]);
    // A pre-T6 row has the cap but no evidence whether truncation actually occurred.
    f.store.db.prepare("UPDATE observations SET json=json_remove(json,'$.lastAgentMessageTruncated') WHERE session_id=?").run(s.id);
    const before = f.store.db.prepare("SELECT json FROM observations WHERE session_id=?").all(s.id);
    assert.equal(read(f.store, s.id).truncated, true);
    assert.equal(read(f.store, s.id).lastAgentMessage!.body.length, 20_000);
    assert.deepEqual(f.store.db.prepare("SELECT json FROM observations WHERE session_id=?").all(s.id), before);
});

test("a Claude terminal event across a read gap preserves both incompleteness and reply truncation", t => {
    const f = fixture(t), fallback = { nativeId: "gap", mtime: at(0) };
    const opened = parseClaudeRecords([
        { type: "user", timestamp: at(1), message: { content: "合成指令" } },
        { type: "aimspan_read_gap" },
    ], fallback);
    const s = f.store.observe(opened);
    const completed = parseClaudeRecords([
        { type: "assistant", timestamp: at(5), message: { content: "字".repeat(20_001), stop_reason: "end_turn" } },
    ], fallback);
    f.store.observe(completed);
    const card = read(f.store, s.id);
    assert.equal(card.turnsSinceAnchor, 1);
    assert.equal(card.factsIncomplete, true);
    assert.equal(card.truncated, true);
    assert.equal(card.lastAgentMessage!.body.length, 20_000);
    f.reopen();
    assert.deepEqual(read(f.store, s.id), card);
});

test("catchup validates session IDs, is available to Renderer, and rejects unknown sessions", t => {
    const f = fixture(t);
    const request = { method: "catchup", sessionId: "synthetic" };
    assert.equal(validRequest(request), true);
    assert.equal(validRendererRequest(request), true);
    for (const sessionId of [undefined, null, "", "x".repeat(161), "nul\0", 1]) assert.equal(validRequest({ ...request, sessionId }), false);
    assert.throws(() => f.store.call({ method: "catchup", sessionId: "missing" }), /core\.errorSessionNoLongerExists/);
});

test("bring-back formatting preserves single text and numbers multiline/CJK selections without a prefix", () => {
    const body = "  保留原文 token=用户文本\n\n末尾😀  \n";
    assert.equal(formatBringBack([]), "");
    assert.equal(formatBringBack([{ body }]), body);
    const selected = Object.freeze([Object.freeze({ body: "第一行\n第二行\n\n" }), Object.freeze({ body: "日本語\r\n한국어\r中文😀" })]);
    assert.equal(formatBringBack(selected), "1. 第一行\n   第二行\n   \n   \n2. 日本語\r\n   한국어\r   中文😀");
    assert.equal(formatBringBack([{ body: "甲" }, { body: "乙" }]), "1. 甲\n2. 乙");
    assert.equal(formatBringBack(Array.from({ length: 10 }, (_, i) => ({ body: `${i}\n续行` }))).split("\n").slice(-2).join("\n"), "10. 9\n   续行");
});

test("T6 review: incremental observations keep last-occurrence file order (A→B then A→B→A gives B, A)", t => {
    const f = fixture(t);
    seed(f.store, [turn(1, undefined, { changedFiles: [path("A"), path("B")] })]);
    const s = seed(f.store, [turn(1, 5, { changedFiles: [path("B"), path("A")] })]);
    assert.deepEqual(read(f.store, s.id).changedFiles, [path("B"), path("A")]);
});

test("T20 catchup projects newest five activities independently of the anchor and keeps gap metadata", t => {
    const f = fixture(t);
    const observation = { agent: "codex" as const, nativeId: "activity", title: "Activity", project: path(""), state: "working" as const,
        at: at(20), confidence: "explicit" as const, sources: [], version: "activity",
        activity: Array.from({ length: 25 }, (_, i) => ({ at: at(i), kind: "message" as const, text: `message ${i}\nprivate second line` })),
        activityIncomplete: true };
    let s = f.store.observe(observation);
    assert.equal(s.activity.length, 20);
    const card = read(f.store, s.id);
    assert.deepEqual(card.activity.map(entry => entry.text), ["message 24", "message 23", "message 22", "message 21", "message 20"]);
    assert.equal(card.activityIncomplete, true);
    assert.equal(card.factsIncomplete, false);
    assert.equal(card.truncated, false);
    s = f.store.call({ method: "session.viewed", sessionId: s.id, expectedRevision: s.revision, operationId: "view" }) as Session;
    assert.deepEqual(read(f.store, s.id).activity, card.activity);
    assert.equal(read(f.store, s.id).activityIncomplete, true);
    f.reopen();
    assert.deepEqual(read(f.store, s.id).activity, card.activity);
    assert.deepEqual(f.store.observe(observation).activity, s.activity);
    assert.equal(f.store.requireSession(s.id).revision, s.revision);
});

test("T20 activity merges by event time, deduplicates file edits and resists stale rescans", t => {
    const f = fixture(t);
    const observation = { agent: "codex" as const, nativeId: "activity", title: "Activity", project: path(""), state: "working" as const,
        at: at(5), confidence: "explicit" as const, sources: [], version: "activity",
        activity: [{ at: at(1), kind: "file" as const, text: path("a.ts") }, { at: at(2), kind: "command" as const, text: "pnpm test", failed: false }], activityIncomplete: false };
    f.store.observe(observation);
    const newer = { ...observation, at: at(10), activityIncomplete: true, activity: [
        { at: at(2), kind: "command" as const, text: "pnpm test", failed: true },
        { at: at(8), kind: "file" as const, text: path("a.ts") },
        { at: at(9), kind: "message" as const, text: "token=synthetic-secret\nsecond line" },
    ] };
    const s = f.store.observe(newer);
    assert.equal(s.activity.length, 3); assert.equal(s.activity[0]!.text, "token=[redacted]");
    assert.equal(s.activity[1]!.at, at(8)); assert.equal(s.activity[2]!.failed, true);
    assert.equal(f.store.observe(newer).revision, s.revision);
    const stale = f.store.observe(observation);
    assert.deepEqual(stale.activity, s.activity); assert.equal(stale.activityIncomplete, true);
    assert.equal(stale.revision, s.revision);
    const uncertain = f.store.observe({ ...newer, at: at(11), sourceUncertain: true, activity: [], activityIncomplete: false });
    assert.equal(uncertain.activityIncomplete, true); assert.deepEqual(uncertain.activity, s.activity);
    const recovered = f.store.observe({ ...newer, at: at(12), activityIncomplete: false });
    assert.equal(recovered.activityIncomplete, false);
    assert.deepEqual(recovered.activity, s.activity);
    const dump = JSON.stringify(f.store.db.prepare("SELECT * FROM records UNION ALL SELECT kind,id,seq,json FROM changes").all());
    assert.doesNotMatch(dump, /synthetic-secret|second line/);
});
