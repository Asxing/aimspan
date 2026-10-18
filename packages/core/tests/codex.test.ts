import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { CodexSource, codexRecords, parseCodexRecords } from "../src/codex.js";
import type { CodexObservation } from "../src/codex.js";
import type { SourceTurn, ClaudeTurn } from "../src/index.js";
import { Discovery, parseRecords } from "../src/adapters.js";
import { readSourceBytes, redact, digest } from "../src/security.js";
import { Store } from "../src/store.js";

const project = "/Users/__aimspan_fixture__/project";
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 16, 8, 0, seconds)).toISOString();
const fallback = { nativeId: "fallback", mtime: at(0) };
const meta = (id = "parent", fields: Record<string, unknown> = {}) => ({ type: "session_meta", payload: { id, cwd: project, originator: "codex_cli_rs", ...fields } });
const event = (type: string, seconds: number, fields: Record<string, unknown> = {}) => ({ type: "event_msg", timestamp: at(seconds), payload: { type, ...fields } });
const start = (seconds = 0, id = "turn-1") => event("task_started", seconds, { turn_id: id, started_at: Date.parse(at(seconds)) / 1000 });
const complete = (seconds = 3, fields: Record<string, unknown> = {}) => event("task_complete", seconds, { turn_id: "turn-1", completed_at: at(seconds), ...fields });
const item = (type: string, seconds: number, fields: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => event("item_completed", seconds, { item: { type, ...fields }, ...extra });
const text = (body: string) => [{ type: "text", text: body }];
const prompt = (seconds = 1, body = "检查键盘操作") => item("UserMessage", seconds, { content: text(body) });
const reply = (seconds: number, body: string, phase = "commentary") => item("AgentMessage", seconds, { content: text(body), phase });
const parse = (records: unknown[]) => parseCodexRecords([meta(), ...records], fallback);
const jsonl = (records: unknown[]) => records.map(value => JSON.stringify(value)).join("\n") + "\n";
const childMeta = (id: string, parent = "parent") => meta(id, { source: { subagent: { thread_spawn: { parent_thread_id: parent } } } });

function fixture(t: { after(fn: () => void): void }) {
    const root = mkdtempSync("/private/tmp/__aimspan_fixture__-codex-");
    const codex = join(root, "codex"), claude = join(root, "claude"), sessions = join(codex, "sessions"), archived = join(codex, "archived_sessions"), index = join(codex, "session_index.jsonl");
    for (const directory of [sessions, archived, claude]) mkdirSync(directory, { recursive: true });
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const write = (name: string, records: unknown[], options: { compressed?: boolean; archived?: boolean; mtime?: number } = {}) => {
        const directory = join(options.archived ? archived : sessions, "2026", "10", "16");
        mkdirSync(directory, { recursive: true });
        const path = join(directory, `rollout-${name}.jsonl${options.compressed ? ".zst" : ""}`);
        writeFileSync(path, options.compressed ? zstdCompressSync(Buffer.from(jsonl(records))) : jsonl(records));
        utimesSync(path, new Date(at(options.mtime ?? 10)), new Date(at(options.mtime ?? 10)));
        return path;
    };
    const source = (input = codex) => new CodexSource(input, { now: () => Date.parse(at(100)) });
    return { root, codex, claude, sessions, archived, index, write, source };
}

test("Codex exposes the shared turn fields, originator and normalized epoch/ISO timestamps", () => {
    const opened = parse([start()]);
    assert.equal(opened.state, "working");
    assert.equal(opened.originator, "codex_cli_rs");
    assert.equal(opened.project, project);
    assert.equal(opened.archived, false);
    assert.equal(opened.subagentRunning, false);
    assert.deepEqual(opened.turns, [{ turnId: digest("turn-1"), promptAt: at(0), errors: [], changedFiles: [], failedCommands: [] }]);
    const shared: SourceTurn = opened.turns[0]!;
    const alias: ClaudeTurn = shared;
    assert.equal(alias, shared);
    const ended = parse([start(), prompt(), complete(8, { completed_at: Date.parse(at(8)) / 1000, duration_ms: 1234, last_agent_message: "完成" })]);
    assert.equal(ended.state, "ended");
    assert.equal(ended.lastPromptAt, at(1));
    assert.equal(ended.lastMainRecordAt, at(8));
    assert.deepEqual(ended.turns, [{ turnId: digest("turn-1"), promptAt: at(1), endedAt: at(8), durationMs: 1234, lastAgentMessage: "完成", lastAgentMessageTruncated: false, errors: [], changedFiles: [], failedCommands: [] }]);
    assert.equal(parseRecords("codex", [meta(), start()], fallback).turns.length, 1);
    assert.equal(parse([start(), complete(8)]).turns[0]!.durationMs, 8000);
});

test("only native UserMessage items supply prompt/title; either start/prompt ordering creates one turn", () => {
    const injected = { type: "response_item", timestamp: at(0), payload: { role: "user", content: [{ type: "input_text", text: "injected instructions" }] } };
    assert.equal(parse([injected]).turns.length, 0);
    assert.equal(parse([injected]).lastPromptAt, undefined);
    const parsed = parse([injected, prompt(1, "first prompt"), start(2), prompt(3, "next prompt")]);
    assert.equal(parsed.title, "first prompt");
    assert.equal(parsed.turns.length, 2);
    assert.equal(parsed.lastPromptAt, at(3));
    assert.equal(parse([prompt(1, "字".repeat(200))]).title.length, 120);
});

test("task_complete prefers explicit text, then last final phase, then last agent message", () => {
    const records = [start(), prompt(), reply(2, "first final", "final_answer"), reply(3, "last final", "final"), reply(4, "late commentary")];
    assert.equal(parse([...records, complete(5)]).turns[0]!.lastAgentMessage, "last final");
    assert.equal(parse([...records, complete(5, { last_agent_message: "native final" })]).turns[0]!.lastAgentMessage, "native final");
    assert.equal(parse([start(), reply(1, "earlier"), reply(2, "latest"), complete(3)]).turns[0]!.lastAgentMessage, "latest");
    assert.equal(parse([start(), complete(2), reply(3, "late text")]).state, "ended");
    assert.equal(parse([start(), complete(2), reply(3, "late text")]).turns[0]!.lastAgentMessage, undefined);
});

test("abort closes a turn and late results, same-ID starts or read gaps cannot reopen it", () => {
    const records = [start(), prompt(), event("turn_aborted", 2, { turn_id: "turn-1", completed_at: Date.parse(at(2)) / 1000, duration_ms: 900, reason: "token=synthetic-abort stopped" })];
    for (const suffix of [[], [reply(3, "late message")], [start(3)], [{ type: "aimspan_read_gap" }, start(3)]]) {
        const parsed = parse([...records, ...suffix]);
        assert.equal(parsed.state, "unknown");
        assert.equal(parsed.lastPromptAt, at(1));
        assert.equal(parsed.turns.length, 1);
        assert.equal(parsed.turns[0]!.aborted, true);
        assert.equal(parsed.turns[0]!.endedAt, at(2));
        assert.equal(parsed.turns[0]!.durationMs, 900);
        assert.deepEqual(parsed.turns[0]!.errors, ["aborted: token=[redacted] stopped"]);
    }
    const late = item("CommandExecution", 3, { command: "interrupted command", status: "failed" });
    assert.deepEqual(parse([...records, late]).turns[0]!.failedCommands, ["interrupted command"]);
    const resumed = parse([...records, start(4, "turn-2"), prompt(5, "resume"), complete(6, { turn_id: "turn-2" })]);
    assert.equal(resumed.state, "ended");
    assert.equal(resumed.turns.length, 2);
    assert.equal(resumed.turns[1]!.endedAt, at(6));
});

test("turn IDs isolate delayed completions and command results; terminal IDs suppress duplicate starts", () => {
    const records = [start(), prompt(), complete(2), start(3, "turn-2"), prompt(4, "second")];
    const parsed = parse([...records, complete(5), item("CommandExecution", 6, { command: "old failure", status: "failed" }, { turn_id: "turn-1" })]);
    assert.equal(parsed.state, "working");
    assert.equal(parsed.turns[1]!.endedAt, undefined);
    assert.deepEqual(parsed.turns[1]!.failedCommands, []);
    assert.equal(parse([start(), complete(2), start(3)]).state, "ended");
    assert.equal(parse([complete(5, { error: { message: "API_KEY=synthetic-error failure" } }), start(1)]).state, "failed");
    assert.deepEqual(parse([start(), complete(5, { error: { message: "API_KEY=synthetic-error failure" } })]).turns[0]!.errors, ["API_KEY=[redacted] failure"]);
});

test("FileChange captures both paths, never diffs; commands use argv and cap failures", () => {
    const files = item("FileChange", 2, { changes: { [`${project}/a.ts`]: { type: "update", unified_diff: "NEVER STORE DIFF", move_path: `${project}/b.ts` }, [`${project}/b.ts`]: { type: "delete" } } });
    const failures = [item("CommandExecution", 3, { command: ["node", "test.js", "TOKEN=synthetic-command"], exit_code: 1 }), item("CommandExecution", 4, { command: "status failed", exit_code: 0, status: "failed" })];
    const parsed = parse([start(), files, ...failures, item("CommandExecution", 5, { command: "success", exit_code: 0 }), item("CommandExecution", 6, { command: "running", status: "in_progress" })]);
    assert.deepEqual(parsed.turns[0]!.changedFiles, [`${project}/a.ts`, `${project}/b.ts`]);
    assert.deepEqual(parsed.turns[0]!.failedCommands, ["node test.js TOKEN=[redacted]", "status failed"]);
    assert.doesNotMatch(JSON.stringify(parsed), /NEVER STORE DIFF|synthetic-command/);
    const changes = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`${project}/${i}`, { move_path: `${project}/moved-${i}` }]));
    const many = parse([start(), item("FileChange", 1, { changes }), ...Array.from({ length: 60 }, (_, i) => item("CommandExecution", i + 2, { command: `${i} ${"x".repeat(400)}`, status: "failed" }))]);
    assert.equal(many.turns[0]!.changedFiles.length, 200);
    assert.equal(many.turns[0]!.failedCommands.length, 50);
    assert.ok(many.turns[0]!.failedCommands.every(command => command.length === 300));
});

test("all captured native strings use shared redaction before caching, including capped messages", () => {
    const parsed = parseCodexRecords([
        meta("token=synthetic-id", { cwd: `${project}/password=synthetic-project`, originator: "API_KEY=synthetic-origin" }), start(), prompt(1, "TOKEN=synthetic-prompt title"),
        item("FileChange", 2, { changes: { [`${project}/token=synthetic-path`]: { move_path: `${project}/token=synthetic-move` } } }),
        item("CommandExecution", 3, { command: 'curl -H "Authorization: Bearer synthetic-header" TOKEN=synthetic-\\\ncontinued', status: "failed" }),
        complete(4, { last_agent_message: "password=synthetic-message\n" + "字".repeat(21000), error: { message: "token=synthetic-error " + "e".repeat(600) } }),
    ], { ...fallback, title: "api_key=synthetic-title title" });
    assert.doesNotMatch(JSON.stringify(parsed), /synthetic|continued/);
    assert.equal(parsed.turns[0]!.lastAgentMessage!.length, 20000);
    assert.equal(parsed.turns[0]!.errors[0]!.length, 500);
});

test("keeps last 20 turns and last 12 references, deduplicating repeated complete records", () => {
    const records = Array.from({ length: 25 }, (_, i) => [start(i * 3, `turn-${i}`), prompt(i * 3 + 1, `prompt ${i}`), complete(i * 3 + 2, { turn_id: `turn-${i}`, last_agent_message: `answer ${i}` })]).flat();
    const parsed = parse([...records, ...records]);
    assert.equal(parsed.turns.length, 20);
    assert.equal(parsed.sources.length, 12);
    assert.equal(parsed.turns[0]!.promptAt, at(16));
    assert.equal(parsed.turns.at(-1)!.lastAgentMessage, "answer 24");
    assert.equal(parsed.title, "prompt 0");
});

test("invalid interior lines and oversized records create fact boundaries; incomplete last line is tolerated", () => {
    for (const middle of ['{"broken":\n', jsonl([prompt(1, "x".repeat(300000))])]) {
        const parsed = parseCodexRecords(codexRecords(jsonl([meta(), start()]) + middle + jsonl([complete(2, { last_agent_message: "unanchored" }), start(3, "next"), prompt(4, "new"), complete(5, { turn_id: "next", last_agent_message: "new answer" })]) + '{"unfinished":'), fallback);
        // The same explicit turn ID closes the header turn; facts stop at the boundary.
        assert.equal(parsed.turns[0]!.lastAgentMessage, "unanchored");
        assert.equal(parsed.turns[0]!.endedAt, at(2));
        assert.equal(parsed.turns[0]!.factsThrough, at(0));
        assert.equal(parsed.turns[1]!.lastAgentMessage, "new answer");
    }
    const parsed = parseCodexRecords(codexRecords(jsonl([meta(), start(), prompt()]) + '{"unfinished":'), fallback);
    assert.equal(parsed.state, "working");
});

test("record loop budgets retain newest turns without stitching over skipped records", () => {
    const values = [meta(), start(), ...Array.from({ length: 6000 }, (_, i) => ({ type: "ignored", i })), complete(2, { last_agent_message: "unanchored" }), start(3, "new"), prompt(4), complete(5, { turn_id: "new", last_agent_message: "latest" })];
    for (const records of [values, codexRecords(jsonl(values))]) {
        const parsed = parseCodexRecords(records, fallback);
        assert.equal(parsed.turns[0]!.endedAt, at(2));
        assert.equal(parsed.turns[0]!.factsThrough, at(0));
        assert.equal(parsed.turns.at(-1)!.lastAgentMessage, "latest");
    }
});

test("compressed rollouts use the same parsing and cache; title index latest line wins independently", async t => {
    const f = fixture(t), compressed = f.write("compressed", [meta(), start(), prompt(), complete(4, { last_agent_message: "done" })], { compressed: true });
    const original = readFileSync(compressed), reads: string[] = [];
    const source = new CodexSource(f.codex, { now: () => Date.parse(at(100)), read(path, ...args) { reads.push(path); assert.ok(!path.endsWith(".sqlite")); return readSourceBytes(path, ...args); } });
    writeFileSync(join(f.codex, "state.sqlite"), "never read");
    writeFileSync(f.index, jsonl([{ id: "parent", thread_name: "old", updated_at: at(9) }, { id: "parent", thread_name: "latest", updated_at: at(1) }]));
    let result = await source.scan();
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.sessions[0]!.observation.title, "latest");
    assert.equal(result.sessions[0]!.observation.turns[0]!.lastAgentMessage, "done");
    const version = result.sessions[0]!.observation.version;
    await source.scan();
    assert.equal(reads.filter(path => path === compressed).length, 1);
    appendFileSync(f.index, jsonl([{ id: "parent", thread_name: "TOKEN=synthetic-index renamed", updated_at: at(10) }]));
    result = await source.scan();
    assert.equal(result.sessions[0]!.observation.title, "TOKEN=[redacted] renamed");
    assert.notEqual(result.sessions[0]!.observation.version, version);
    assert.equal(reads.filter(path => path === compressed).length, 1);
    rmSync(f.index);
    assert.equal((await source.scan()).sessions[0]!.observation.title, "检查键盘操作");
    assert.deepEqual(readFileSync(compressed), original);
    assert.equal((await f.source(f.sessions).scan()).sessions.length, 1);
});

test("corrupt, unreadable and oversized compressed files diagnose independently of healthy sessions", async t => {
    const f = fixture(t);
    const maxDecompressedBytes = 1024 * 1024;
    f.write("good", [meta("good"), start(), prompt(), complete()]);
    const bad = f.write("bad", [meta("bad")], { compressed: true });
    writeFileSync(bad, "not zstd");
    const unreadable = f.write("unreadable", [meta("unreadable"), start()]);
    const oversized = f.write("oversized", [meta("oversized")], { compressed: true });
    writeFileSync(oversized, zstdCompressSync(Buffer.alloc(maxDecompressedBytes + 1, 32)));
    const source = new CodexSource(f.codex, { maxDecompressedBytes, now: () => Date.parse(at(100)), read(path, ...args) { if (path === unreadable) throw new Error("token=synthetic-error"); return readSourceBytes(path, ...args); } });
    const result = await source.scan();
    assert.deepEqual(result.sessions.map(candidate => candidate.observation.nativeId), ["good"]);
    for (const path of [bad, unreadable, oversized]) assert.ok(result.diagnostics.some(message => message.path === path));
    assert.equal(result.diagnostics.length, 3);
    assert.ok(result.diagnostics.some(message => message.code === "codex-decompressed-limit"));
    assert.doesNotMatch(JSON.stringify(result), /synthetic-error/);
});

test("read failure keeps cached facts as unknown while another file advances", async t => {
    const f = fixture(t), broken = f.write("broken", [meta("broken"), start(), prompt(), complete(3, { last_agent_message: "keep answer" })]);
    f.write("healthy", [meta("healthy"), start()]);
    const source = f.source();
    await source.scan();
    writeFileSync(broken, '{"partial":');
    f.write("healthy", [meta("healthy"), start(), complete(4, { last_agent_message: "new result" })]);
    const result = await source.scan();
    const previous = result.sessions.find(candidate => candidate.observation.nativeId === "broken")!.observation;
    assert.equal(previous.state, "unknown");
    assert.equal(previous.turns[0]!.lastAgentMessage, "keep answer");
    assert.equal(result.sessions.find(candidate => candidate.observation.nativeId === "healthy")!.observation.state, "ended");
    assert.ok(result.diagnostics.length > 0);
});

test("subagent threads fold through ancestors, never become sessions, and cached parents refresh", async t => {
    const f = fixture(t), parent = f.write("parent", [meta(), start(), prompt(), complete()]);
    const child = f.write("child", [childMeta("child"), start(), prompt(4, "child prompt")], { compressed: true });
    f.write("orphan", [childMeta("orphan", "missing"), start()]);
    const reads: string[] = [];
    const source = new CodexSource(f.codex, { now: () => Date.parse(at(100)), read(path, ...args) { reads.push(path); return readSourceBytes(path, ...args); } });
    let result = await source.scan();
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]!.observation.subagentRunning, true);
    assert.equal(result.sessions[0]!.observation.turns.length, 1);
    assert.equal(result.sessions[0]!.observation.title, "检查键盘操作");
    assert.equal(result.sessions[0]!.observation.state, "working");
    f.write("child", [childMeta("child"), start(), complete(5)], { compressed: true });
    result = await source.scan();
    assert.equal(result.sessions[0]!.observation.subagentRunning, false);
    assert.equal(result.sessions[0]!.observation.state, "ended");
    assert.equal(reads.filter(path => path === parent).length, 1);
    const grandchild = f.write("grandchild", [childMeta("grandchild", "child"), start(6)]);
    assert.equal((await source.scan()).sessions[0]!.observation.subagentRunning, true);
    rmSync(grandchild); rmSync(child);
    assert.equal((await source.scan()).sessions[0]!.observation.subagentRunning, false);
    assert.equal((Reflect.get(source, "cache") as Map<string, unknown>).has(child), false);
});

test("aborted parents cannot be reopened by children; stale child work does not imply running", async t => {
    const f = fixture(t);
    f.write("parent", [meta(), start(), prompt(), event("turn_aborted", 2, { turn_id: "turn-1" })]);
    f.write("child", [childMeta("child"), start(3)]);
    assert.equal((await f.source().scan()).sessions[0]!.observation.state, "unknown");
    f.write("parent", [meta(), start(), complete()]);
    f.write("child", [childMeta("child"), start(3)], { mtime: -7200 });
    const result = await f.source().scan();
    assert.equal(result.sessions[0]!.observation.subagentRunning, false);
    assert.ok(result.diagnostics.some(message => message.code === "codex-stale"));
});

test("archive flag survives discovery into Store, native IDs keep equal titles/projects separate", async t => {
    const f = fixture(t);
    f.write("active", [meta("active"), start(), prompt(), complete()]);
    f.write("archived", [meta("archived"), start(), prompt(), complete()], { compressed: true, archived: true });
    f.write("duplicate", [meta("active"), start()], { archived: true, mtime: 20 });
    const store = new Store(join(f.root, "state"), () => at(100)); t.after(() => store.close());
    const observations: CodexObservation[] = [], original = store.observe.bind(store);
    store.observe = value => { if (value.agent === "codex") observations.push(value as CodexObservation); return original(value); };
    await new Discovery(store, { codex: f.sessions, claude: f.claude }, {}, { now: () => Date.parse(at(100)) }).scan();
    assert.equal(observations.length, 2);
    assert.equal(observations.find(value => value.nativeId === "active")!.archived, false);
    assert.equal(observations.find(value => value.nativeId === "archived")!.archived, true);
    assert.equal(store.workspace().sessions.find(value => value.nativeId === "archived")!.archived, true);
    assert.equal(store.workspace().sessions.find(value => value.nativeId === "active")!.archived, false);
});

test("staleness uses rollout mtime, re-evaluates cached observations and recovers on append", async t => {
    const f = fixture(t), path = f.write("parent", [meta(), start(), prompt()], { mtime: 0 });
    let now = Date.parse(at(7199)), reads = 0;
    const source = new CodexSource(f.codex, { now: () => now, read(path, ...args) { reads++; return readSourceBytes(path, ...args); } });
    assert.equal((await source.scan()).sessions[0]!.observation.state, "working");
    now = Date.parse(at(7200));
    const stale = await source.scan();
    assert.equal(stale.sessions[0]!.observation.state, "unknown");
    assert.ok(stale.diagnostics.some(message => message.code === "codex-stale"));
    assert.equal(reads, 1);
    appendFileSync(path, jsonl([complete(7201)]));
    assert.equal((await source.scan()).sessions[0]!.observation.state, "ended");
});

test("plain streams retain turn continuity while compressed windows retain their gap boundary", async t => {
    const f = fixture(t);
    for (const compressed of [false, true]) {
        const records = [meta(`session-${compressed}`), start(), prompt(), { type: "ignored", data: "x".repeat(600000) }, complete(3, { last_agent_message: "unanchored answer" }), start(4, "new"), prompt(5, "new prompt"), complete(6, { turn_id: "new", last_agent_message: "tail answer" })];
        f.write(`session-${compressed}`, records, { compressed });
    }
    for (const candidate of (await f.source().scan()).sessions) {
        const turns = candidate.observation.turns;
        assert.equal(turns.length, 2);
        assert.equal(turns[0]!.endedAt, at(3));
        assert.equal(turns[0]!.lastAgentMessage, "unanchored answer");
        assert.equal(turns[0]!.factsThrough, candidate.path.endsWith(".zst") ? at(1) : undefined);
        assert.equal(turns[1]!.lastAgentMessage, "tail answer");
    }
});

test("overlapping byte windows reconstruct complete lines without dropping an intervening prompt", async t => {
    const f = fixture(t);
    const records = [meta(), start(), prompt(), prompt(2, "x".repeat(60000)), complete(3, { last_agent_message: "answer to second" }), { type: "ignored", data: "x".repeat(220000) }];
    f.write("overlap", records);
    const observation = (await f.source().scan()).sessions[0]!.observation;
    assert.equal(observation.turns.length, 2);
    assert.equal(observation.turns[0]!.endedAt, undefined);
    assert.equal(observation.turns[1]!.lastAgentMessage, "answer to second");
});

test("truncated append is tolerated and a complete subsequent read closes the original turn", async t => {
    const f = fixture(t), path = f.write("parent", [meta(), start(), prompt()]);
    const ending = JSON.stringify(complete(3, { last_agent_message: "completed append" }));
    appendFileSync(path, ending.slice(0, 30));
    utimesSync(path, new Date(at(10)), new Date(at(10)));
    const source = f.source();
    assert.equal((await source.scan()).sessions[0]!.observation.state, "working");
    appendFileSync(path, ending.slice(30) + "\n");
    const observation = (await source.scan()).sessions[0]!.observation;
    assert.equal(observation.turns.length, 1);
    assert.equal(observation.turns[0]!.lastAgentMessage, "completed append");
});

test("symlinks, hard links and replaced chunks cannot be consumed as rollouts", async t => {
    const f = fixture(t), path = f.write("parent", [meta(), start()]);
    symlinkSync(path, join(f.sessions, "linked.jsonl"));
    symlinkSync(f.archived, join(f.sessions, "linked-directory"));
    linkSync(path, join(f.sessions, "hardlink.jsonl"));
    assert.equal((await f.source().scan()).sessions.length, 0);
    rmSync(join(f.sessions, "hardlink.jsonl"));
    const source = new CodexSource(f.codex, { read(path, ...args) { const result = readSourceBytes(path, ...args); return { ...result, mtime: result.mtime + 1 }; } });
    assert.equal((await source.scan()).sessions.length, 0);
});

test("disappeared rollout/index caches are evicted without deleting persisted sessions or ideas", async t => {
    const f = fixture(t), path = f.write("parent", [meta(), start(), prompt(), complete()]);
    writeFileSync(f.index, jsonl([{ id: "parent", thread_name: "indexed" }]));
    const store = new Store(join(f.root, "state"), () => at(100)); t.after(() => store.close());
    const discovery = new Discovery(store, f, {}, { now: () => Date.parse(at(100)) });
    await discovery.scan();
    const session = store.workspace().sessions[0]!;
    store.call({ method: "idea.save", sessionId: session.id, body: "保留原文", expectedRevision: 0, operationId: "save" });
    rmSync(path); rmSync(f.index);
    await discovery.scan();
    const source = Reflect.get(discovery, "codexSource") as CodexSource;
    assert.equal((Reflect.get(source, "cache") as Map<string, unknown>).size, 0);
    assert.equal(Reflect.get(source, "indexCache"), undefined);
    assert.equal(store.workspace().sessions.length, 1);
    assert.equal(store.workspace().ideas[0]!.body, "保留原文");
});

test("discovery re-applies project filtering even when rollout parsing is cached", async t => {
    const f = fixture(t);
    f.write("parent", [meta(), start(), prompt(), complete()]);
    const store = new Store(join(f.root, "state"), () => at(100)); t.after(() => store.close());
    store.setSettings({ ...store.settings(), observeAll: false, roots: ["/Users/__aimspan_fixture__/other"] });
    const discovery = new Discovery(store, f, {}, { now: () => Date.parse(at(100)) });
    await discovery.scan();
    assert.equal(store.workspace().sessions.length, 0);
    store.setSettings({ ...store.settings(), roots: [project] });
    await discovery.scan();
    assert.equal(store.workspace().sessions.length, 1);
});

test("file and cache budgets are bounded across scans of disjoint source sets", async t => {
    // This checks count limits only; a generous time budget keeps a loaded machine from cutting the pass short.
    const f = fixture(t), source = new CodexSource(f.codex, { now: () => Date.parse(at(100)), budgetNow: () => 0 });
    f.write("old", [meta("old"), start()]);
    await source.scan();
    rmSync(f.sessions, { recursive: true }); mkdirSync(f.sessions);
    const body = jsonl([meta(), start()]);
    for (let i = 0; i < 5001; i++) writeFileSync(join(f.sessions, `rollout-${i}.jsonl`), body);
    const result = await source.scan();
    assert.ok(result.diagnostics.some(message => message.code === "codex-limit"));
    assert.equal((Reflect.get(source, "cache") as Map<string, unknown>).size, 5000);
    assert.ok(![...(Reflect.get(source, "cache") as Map<string, unknown>).keys()].some(path => path.endsWith("rollout-old.jsonl")));
});

test("an unreadable title index cannot block rollouts or expose raw error text", async t => {
    const f = fixture(t);
    f.write("parent", [meta(), start(), complete()]);
    writeFileSync(f.index, jsonl([{ id: "parent", thread_name: "remember title" }]));
    let failIndex = false;
    const source = new CodexSource(f.codex, { now: () => Date.parse(at(100)), read(path, ...args) { if (path === f.index && failIndex) throw new Error("token=synthetic-index-error"); return readSourceBytes(path, ...args); } });
    await source.scan();
    failIndex = true;
    appendFileSync(f.index, '{"unfinished":');
    const result = await source.scan();
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]!.observation.title, "remember title");
    assert.ok(result.diagnostics.some(message => message.code === "codex-index"));
    assert.doesNotMatch(JSON.stringify(result), /synthetic-index-error/);
});

test("active Codex updates preserve explicit user archives; archived children do not activate parents", async t => {
    const f = fixture(t);
    f.write("parent", [meta(), start(), complete()]);
    f.write("archived-child", [childMeta("child"), start(4)], { archived: true });
    assert.equal((await f.source().scan()).sessions[0]!.observation.subagentRunning, false);
    const store = new Store(join(f.root, "state"), () => at(100)); t.after(() => store.close());
    const discovery = new Discovery(store, f, {}, { now: () => Date.parse(at(100)) });
    await discovery.scan();
    const session = store.workspace().sessions[0]!;
    store.call({ method: "session.archive", sessionId: session.id, archived: true, operationId: "archive" });
    f.write("parent", [meta(), start(), complete(5, { last_agent_message: "updated" })]);
    await discovery.scan();
    assert.equal(store.workspace().sessions[0]!.archived, true);
});

test("a completed hidden Codex child keeps its viewed parent waiting until explicitly handled", async t => {
    const f = fixture(t);
    f.write("parent", [meta(), start(), prompt(), complete()]);
    const store = new Store(join(f.root, "state"), () => at(100)); t.after(() => store.close());
    const discovery = new Discovery(store, f);
    await discovery.scan();
    const parent = store.workspace().sessions[0]!;
    store.call({ method: "session.viewed", sessionId: parent.id, expectedRevision: parent.revision, operationId: "parent-view", at: at(10) });
    f.write("child", [childMeta("child"), start(20), complete(30)]);
    await discovery.scan();
    const waiting = store.workspace().sessions[0]!;
    assert.equal(store.workspace().sessions.length, 1);
    assert.equal(waiting.state, "waiting"); assert.equal(waiting.active, true);
    assert.equal(waiting.subagentWaitingAt, at(30));
    store.call({ method: "session.viewed", sessionId: parent.id, expectedRevision: waiting.revision, operationId: "child-view" });
    await discovery.scan();
    const viewed = store.workspace().sessions[0]!;
    assert.equal(viewed.state, "waiting");
    store.call({ method: "session.handled", sessionId: parent.id, expectedRevision: viewed.revision, operationId: "child-handle" });
    await discovery.scan();
    assert.equal(store.workspace().sessions[0]!.state, "idle");
});

test("T22 codex_exec children are hidden and fold into the interactive parent", async t => {
    const f = fixture(t);
    f.write("parent", [meta(), start(), prompt(), complete()]);
    // The child's own (first) session_meta carries both its originator and its parent link.
    f.write("automation", [meta("automation", { originator: "codex_exec", source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } } }), start(20)]);
    const result = await f.source().scan();
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]!.observation.subagentRunning, true);
    const store = new Store(join(f.root, "state"), () => at(30)); t.after(() => store.close());
    for (const candidate of result.sessions) store.observe(candidate.observation);
    assert.equal(store.workspace().sessions.some(s => s.nativeId === "automation"), false);
    assert.equal(store.workspace().sessions[0]!.state, "running");
});

// Native lifecycle payloads round to seconds; record timestamps retain milliseconds.
const nativeAt = (ms: number) => new Date(Date.parse(at(0)) + ms).toISOString();
const nativeEvent = (type: string, ms: number, turnId: string, fields: Record<string, unknown> = {}) => ({
    type: "event_msg", timestamp: nativeAt(ms), payload: {
        type, turn_id: turnId,
        ...(type === "task_started" ? { started_at: Math.floor(Date.parse(nativeAt(ms)) / 1000) } : type === "task_complete" || type === "turn_aborted" ? { completed_at: Math.floor(Date.parse(nativeAt(ms)) / 1000) } : { completed_at_ms: Date.parse(nativeAt(ms)) }),
        ...fields,
    },
});
const nativeItem = (type: string, ms: number, turnId: string, fields: Record<string, unknown> = {}) => nativeEvent("item_completed", ms, turnId, { item: { type, ...fields } });

test("R1 precision: integer lifecycle seconds cannot discard millisecond completions", () => {
    const records = Array.from({ length: 3 }, (_, i) => [
        nativeEvent("task_started", i * 3000 + 125, `native-${i}`),
        nativeItem("UserMessage", i * 3000 + 250, `native-${i}`, { content: text(`prompt ${i}`) }),
        nativeItem("AgentMessage", i * 3000 + 2500, `native-${i}`, { content: text(`answer ${i}`), phase: "final_answer" }),
        nativeEvent("task_complete", i * 3000 + 2750, `native-${i}`),
    ]).flat();
    const parsed = parse(records);
    assert.equal(parsed.state, "ended");
    assert.equal(parsed.turns.length, 3);
    for (let i = 0; i < 3; i++) {
        assert.equal(parsed.turns[i]!.endedAt, nativeAt(i * 3000 + 2750));
        assert.equal(parsed.turns[i]!.lastAgentMessage, `answer ${i}`);
        assert.equal(parsed.turns[i]!.durationMs, 2500);
    }
});

test("R1 ordering: file order survives backwards timestamps and payload-only completions", () => {
    const started = nativeEvent("task_started", 1500, "a");
    const answer = nativeItem("AgentMessage", 2500, "a", { content: text("answer"), phase: "final_answer" });
    for (const completed of [nativeEvent("task_complete", 2250, "a"), { type: "event_msg", payload: { type: "task_complete", turn_id: "a", completed_at: Math.floor(Date.parse(nativeAt(2000)) / 1000) } }]) {
        const parsed = parse([started, answer, completed]);
        assert.equal(parsed.state, "ended");
        assert.equal(parsed.turns[0]!.lastAgentMessage, "answer");
        assert.ok(parsed.turns[0]!.endedAt);
    }
    const later = parse([started, nativeEvent("task_complete", 3500, "a"), nativeEvent("task_started", 3000, "b")]);
    assert.equal(later.state, "working");
    assert.equal(later.turns.length, 2);
});

test("R1 abort: a distinct turn starts and completes without a new UserMessage", () => {
    const aborted = [nativeEvent("task_started", 125, "a"), nativeEvent("turn_aborted", 1250, "a", { reason: "interrupted" })];
    for (const middle of [[], [{ type: "aimspan_read_gap" }]]) {
        const opened = parse([...aborted, ...middle, nativeEvent("task_started", 2250, "b")]);
        assert.equal(opened.state, "working");
        assert.equal(opened.turns.length, 2);
        const ended = parse([...aborted, ...middle, nativeEvent("task_started", 2250, "b"), nativeEvent("task_complete", 3250, "b", { last_agent_message: "B completed" }), nativeEvent("task_started", 4250, "a"), nativeEvent("task_complete", 5250, "a")]);
        assert.equal(ended.state, "ended");
        assert.equal(ended.turns[0]!.aborted, true);
        assert.equal(ended.turns[1]!.lastAgentMessage, "B completed");
        assert.equal(ended.turns[1]!.endedAt, nativeAt(3250));
        assert.equal(ended.turns.length, 2);
    }
});

test("R1 steering: same turn_id retains earlier facts and the original prompt time", () => {
    const records = [nativeEvent("task_started", 125, "a"), nativeItem("UserMessage", 250, "a", { content: text("original task") }), nativeItem("FileChange", 1250, "a", { changes: { [`${project}/earlier.ts`]: { type: "update" } } })];
    // Native producers may put turn_id on the event payload or on the item.
    for (const steering of [nativeItem("UserMessage", 2250, "a", { content: text("steer the same task") }), { type: "event_msg", timestamp: nativeAt(2250), payload: { type: "item_completed", completed_at_ms: Date.parse(nativeAt(2250)), item: { type: "UserMessage", turn_id: "a", content: text("steer the same task") } } }]) {
        const parsed = parse([...records, steering, nativeEvent("task_complete", 4250, "a", { last_agent_message: "done" })]);
        assert.equal(parsed.turns.length, 1);
        assert.equal(parsed.turns[0]!.promptAt, nativeAt(250));
        assert.equal(parsed.lastPromptAt, nativeAt(2250));
        assert.equal(parsed.turns[0]!.durationMs, 4000);
        assert.deepEqual(parsed.turns[0]!.changedFiles, [`${project}/earlier.ts`]);
        assert.equal(parsed.turns[0]!.lastAgentMessage, "done");
    }
});

test("R1 credentials: whitespace flags and whole argv values are redacted before caching", async t => {
    const f = fixture(t);
    const commands: (string | string[])[] = [
        ["deploy", "--token", "synthetic-secret-0123456789"],
        ["deploy", "--api-key", "synthetic multi word key", "--password", "synthetic\npassword", "--secret", 'synthetic"quoted;value'],
        "deploy --token synthetic-token --api-key synthetic-key --password 'synthetic password' --secret synthetic-secret",
        'deploy --password "synthetic \\"quoted\\" password" --token synthetic\\ value',
        "deploy --secret \\\nsynthetic-continued",
    ];
    f.write("flags", [meta(), nativeEvent("task_started", 125, "a"), ...commands.map((command, i) => nativeItem("CommandExecution", 1250 + i * 1000, "a", { command, exit_code: 1 }))]);
    const source = f.source(), parsed = (await source.scan()).sessions[0]!.observation;
    assert.equal(parsed.turns[0]!.failedCommands.length, commands.length);
    assert.doesNotMatch(JSON.stringify(parsed), /synthetic|multi word key|password\\n|quoted;value/);
    assert.doesNotMatch(JSON.stringify((await source.scan()).sessions), /synthetic/);
});

test("realdata metadata: a 77 KiB first-line session_meta survives plain and zstd windows", async t => {
    const f = fixture(t);
    for (const compressed of [false, true]) {
        const first = { ...meta(`metadata-${compressed}`, { base_instructions: { text: "i".repeat(77 * 1024) } }), timestamp: nativeAt(0) };
        f.write(`metadata-${compressed}`, [first, { type: "ignored", data: "x".repeat(300000) }, nativeEvent("task_started", 1125, "a"), nativeItem("UserMessage", 1250, "a", { content: text("native task") }), nativeEvent("task_complete", 2250, "a", { last_agent_message: "native result" })], { compressed });
    }
    const result = await f.source().scan();
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.sessions.length, 2);
    for (const { observation } of result.sessions) {
        assert.equal(observation.project, project);
        assert.equal(observation.turns.at(-1)!.lastAgentMessage, "native result");
        assert.doesNotMatch(JSON.stringify(observation), /base_instructions|iiiiiiii/);
    }
});

test("realdata large zstd: decompressed rollouts above the old 64 MiB cap keep their tail", async t => {
    const f = fixture(t), path = f.write("large", [], { compressed: true });
    const first = jsonl([{ ...meta("large", { base_instructions: { text: "i".repeat(77 * 1024) } }), timestamp: nativeAt(0) }]);
    const tail = jsonl([nativeEvent("task_started", 1125, "a"), nativeItem("UserMessage", 1250, "a", { content: text("large native task") }), nativeItem("AgentMessage", 2500, "a", { content: text("large native answer"), phase: "final_answer" }), nativeEvent("task_complete", 2750, "a")]);
    writeFileSync(path, zstdCompressSync(Buffer.concat([Buffer.from(first), Buffer.alloc(65 * 1024 * 1024, 10), Buffer.from(tail)])));
    const source = f.source(), result = await source.scan();
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]!.observation.state, "ended");
    assert.equal(result.sessions[0]!.observation.turns.at(-1)!.lastAgentMessage, "large native answer");
    assert.equal((await source.scan()).sessions[0]!.observation.version, result.sessions[0]!.observation.version);
});

test("R1 shared redactor: long credential flags preserve prose and noncredential -p", () => {
    for (const command of [
        "deploy --token synthetic-token --api-key synthetic-key --password synthetic-password --secret synthetic-secret",
        'deploy --password "synthetic multi word value"',
        "deploy --token synthetic\\ escaped",
        "deploy --secret \\\nsynthetic-continued",
        "deploy --secret \"synthetic\"'suffix'",
    ]) assert.doesNotMatch(redact(command), /synthetic|multi word|escaped|continued|suffix/);
    for (const ordinary of ["deploy -p project/path --port 1234", "The token and password are optional.", "Bearer bonds are negotiable; token: Identifier", "command --token", "--tokenization ordinary", "foo--secret ordinary"]) assert.equal(redact(ordinary), ordinary);
    assert.equal(redact("deploy --token synthetic-secret trailing", 25), "deploy --token [redacted]");
});

test("realdata streaming limit: budget failures preserve cached facts and allow other files", async t => {
    const f = fixture(t), budget = 1024 * 1024;
    const initial = [meta("large"), nativeEvent("task_started", 125, "a"), nativeEvent("task_complete", 2250, "a", { last_agent_message: "keep this answer" })];
    const path = f.write("large", initial, { compressed: true });
    f.write("healthy", [meta("healthy"), nativeEvent("task_started", 125, "b"), nativeEvent("task_complete", 2250, "b", { last_agent_message: "healthy answer" })]);
    const source = new CodexSource(f.codex, { maxDecompressedBytes: budget, now: () => Date.parse(at(100)) });
    await source.scan();
    writeFileSync(path, zstdCompressSync(Buffer.concat([Buffer.from(jsonl(initial)), Buffer.alloc(budget, 10)])));
    const limited = await source.scan();
    assert.equal(limited.sessions.length, 2);
    assert.ok(limited.diagnostics.some(message => message.code === "codex-decompressed-limit"));
    const cached = limited.sessions.find(value => value.observation.nativeId === "large")!.observation;
    assert.equal(cached.state, "unknown");
    assert.equal(cached.turns[0]!.lastAgentMessage, "keep this answer");
    assert.equal(limited.sessions.find(value => value.observation.nativeId === "healthy")!.observation.state, "ended");
    f.write("large", initial, { compressed: true });
    assert.deepEqual((await source.scan()).diagnostics, []);
});

test("realdata first-line limit: oversized metadata is rejected independently for both formats", async t => {
    const f = fixture(t);
    f.write("healthy", [meta("healthy"), start(), complete()]);
    for (const compressed of [false, true]) f.write(`large-metadata-${compressed}`, [meta(`oversized-${compressed}`, { base_instructions: { text: "i".repeat(1024 * 1024) } }), start(), complete()], { compressed });
    const result = await f.source().scan();
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]!.observation.nativeId, "healthy");
    assert.equal(result.diagnostics.length, 2);
});

test("realdata tail: a completion whose start fell before the read window still yields the turn and its final reply", () => {
    const parsed = parse([prompt(1, "早期指令"), { type: "aimspan_read_gap" }, item("CommandExecution", 40, { command: "ls", exit_code: 0 }), complete(50, { started_at: Date.parse(at(20)) / 1000, completed_at: Date.parse(at(50)) / 1000, last_agent_message: "最终回复" })]);
    assert.equal(parsed.state, "ended");
    const last = parsed.turns.at(-1)!;
    assert.equal(last.promptAt, at(20));
    assert.equal(last.endedAt, at(50));
    assert.equal(last.lastAgentMessage, "最终回复");
});

test("realdata tail: the same explicit turn ID closes the header turn across a read gap instead of duplicating it", () => {
    const parsed = parse([start(0), prompt(1, "长任务"), { type: "aimspan_read_gap" }, complete(50, { started_at: Date.parse(at(0)) / 1000, last_agent_message: "完成" })]);
    assert.equal(parsed.turns.length, 1);
    assert.equal(parsed.turns[0]!.endedAt, at(50));
    assert.equal(parsed.turns[0]!.lastAgentMessage, "完成");
    assert.equal(parsed.state, "ended");
});

test("realdata tail: a different turn ID after a read gap never closes the header turn", () => {
    const parsed = parse([start(0, "turn-a"), prompt(1, "A"), { type: "aimspan_read_gap" }, complete(50, { turn_id: "turn-b", started_at: Date.parse(at(30)) / 1000, last_agent_message: "B 的回复" })]);
    assert.equal(parsed.turns.length, 2);
    assert.equal(parsed.turns[0]!.endedAt, undefined);
    assert.equal(parsed.turns[0]!.lastAgentMessage, undefined);
    assert.equal(parsed.turns[1]!.promptAt, at(30));
    assert.equal(parsed.turns[1]!.lastAgentMessage, "B 的回复");
});

test("T6 review: repeated file changes keep last-occurrence order", () => {
    const change = (seconds: number, path: string) => item("FileChange", seconds, { changes: { [path]: { type: "update" } } });
    const parsed = parse([start(0), prompt(1), change(2, `${project}/A`), change(3, `${project}/B`), change(4, `${project}/A`), complete(5)]);
    assert.deepEqual(parsed.turns[0]!.changedFiles, [`${project}/B`, `${project}/A`]);
});

test("T6 review: a turn reconstructed from a completion after a read gap is marked as having unread facts", () => {
    const parsed = parse([start(0), prompt(1), complete(2), { type: "aimspan_read_gap" }, complete(50, { turn_id: "turn-2", started_at: Date.parse(at(30)) / 1000, last_agent_message: "done" })]);
    const rebuilt = parsed.turns.at(-1)!;
    assert.equal(rebuilt.promptAt, at(30));
    assert.equal(rebuilt.factsThrough, at(30));
    assert.ok(Date.parse(rebuilt.factsThrough!) < Date.parse(rebuilt.endedAt!));
});

test("T17: a running turn survives over 10 MiB of large records and ends on an appended completion", async t => {
    const f = fixture(t);
    const records = Array.from({ length: 520 }, (_, i) => ({ type: "response_item", payload: { type: "function_call_output", output: `${i}:` + "x".repeat(22 * 1024) } }));
    const path = f.write("long", [meta(), start(), prompt(), ...records]);
    const reads: { offset: number | undefined; bytes: number }[] = [];
    const source = new CodexSource(f.codex, { now: () => Date.parse(at(100)), read(path, limit, tail, offset) {
        const result = readSourceBytes(path, limit, tail, offset);
        reads.push({ offset, bytes: result.body.length }); return result;
    } });
    const first = (await source.scan()).sessions[0]!.observation;
    assert.equal(first.state, "working");
    assert.equal(first.turns.length, 1);
    assert.equal(first.turns[0]!.factsThrough, undefined);
    const originalSize = reads.reduce((sum, read) => sum + read.bytes, 0);
    assert.ok(originalSize > 10 * 1024 * 1024);
    assert.ok(reads.every(read => read.bytes <= 1024 * 1024));
    let cursor = 0;
    for (const read of reads) { assert.equal(read.offset, cursor); cursor += read.bytes; }
    reads.length = 0;
    await source.scan(); assert.equal(reads.length, 0);
    const ending = jsonl([complete(30, { duration_ms: 29000, last_agent_message: "完成长任务，TOKEN=synthetic-secret" })]);
    appendFileSync(path, ending);
    const ended = (await source.scan(new Set([path]))).sessions[0]!.observation;
    assert.deepEqual(reads, [{ offset: originalSize, bytes: Buffer.byteLength(ending) }]);
    assert.equal(ended.state, "ended");
    assert.equal(ended.turns[0]!.lastAgentMessage, "完成长任务，TOKEN=[redacted]");
    assert.equal(ended.turns[0]!.durationMs, 29000);
    assert.equal(first.turns[0]!.endedAt, undefined, "previous projections are immutable");
});

test("T17: lifecycle reduction across separate passes matches the full parser", async t => {
    const f = fixture(t), path = f.write("reducer", [meta()]), source = f.source();
    const records = [start(), prompt(), reply(2, "final", "final_answer"),
        item("FileChange", 3, { changes: { [`${project}/a.ts`]: {} } }),
        item("CommandExecution", 4, { command: "failed", exit_code: 1 }),
        complete(5), start(6), start(7, "next"),
        event("turn_aborted", 8, { turn_id: "next", reason: "stop" }), start(9, "next")];
    for (const [index, record] of records.entries()) {
        appendFileSync(path, jsonl([record]));
        const actual = (await source.scan()).sessions[0]!.observation;
        const expected = parse(records.slice(0, index + 1));
        for (const key of ["state", "confidence", "turns", "sources", "title", "lastPromptAt", "lastMainRecordAt"] as const) assert.deepEqual(actual[key], expected[key], key);
    }
});

test("T17: partial UTF-8 and escaped strings survive separate appended-only reads", async t => {
    const f = fixture(t), path = f.write("partial", [meta(), start()]), source = f.source();
    await source.scan();
    const ending = Buffer.from(jsonl([complete(8, { last_agent_message: '中文😀 with "quotes" and \\ escapes' })]));
    const split = ending.indexOf(Buffer.from("😀")) + 2;
    appendFileSync(path, ending.subarray(0, split));
    assert.equal((await source.scan()).sessions[0]!.observation.state, "working");
    appendFileSync(path, ending.subarray(split));
    const result = (await source.scan()).sessions[0]!.observation;
    assert.equal(result.state, "ended");
    assert.equal(result.turns[0]!.lastAgentMessage, '中文😀 with "quotes" and \\ escapes');
});

test("T17: shrink and inode replacement discard old offsets, partial lines and turn IDs", async t => {
    const f = fixture(t), path = f.write("reset", [meta("old"), start(), prompt(1, "x".repeat(1000)), complete()]);
    const offsets: number[] = [];
    const source = new CodexSource(f.codex, { read(path, limit, tail, offset) { offsets.push(offset!); return readSourceBytes(path, limit, tail, offset); } });
    await source.scan();
    appendFileSync(path, '{"type":"event_'); await source.scan();
    writeFileSync(path, jsonl([meta("shrunk"), start()]));
    offsets.length = 0;
    let result = await source.scan();
    assert.equal(offsets[0], 0);
    assert.equal(result.sessions[0]!.observation.nativeId, "shrunk");
    assert.equal(result.sessions[0]!.observation.state, "working");
    const replacement = f.write("replacement", [meta("replaced"), start(), complete(10, { last_agent_message: "replacement result" })]);
    renameSync(replacement, path);
    offsets.length = 0;
    result = await source.scan();
    assert.equal(offsets[0], 0);
    assert.equal(result.sessions[0]!.observation.nativeId, "replaced");
    assert.equal(result.sessions[0]!.observation.turns[0]!.lastAgentMessage, "replacement result");
    rmSync(path); await source.scan();
    assert.equal((Reflect.get(source, "follows") as Map<string, unknown>).size, 0);
});

test("T17: oversized lifecycle lines are sniffed without parsing the whole line", async t => {
    const f = fixture(t), padding = "x".repeat(2 * 1024 * 1024);
    const path = f.write("oversized-lifecycle", [meta(), { ...start(), padding }, { ...reply(1, "last final", "final_answer"), padding: "small" }]);
    const source = f.source();
    // Every JSON.parse input in this reader must be bounded, even for lifecycle.
    const parseJson = JSON.parse; let largest = 0;
    JSON.parse = (...args: Parameters<typeof JSON.parse>) => { largest = Math.max(largest, Buffer.byteLength(args[0])); return parseJson(...args); };
    t.after(() => { JSON.parse = parseJson; });
    assert.equal((await source.scan()).sessions[0]!.observation.state, "working");
    appendFileSync(path, jsonl([{ ...complete(8, { duration_ms: 1234, last_agent_message: '中文😀 "final" TOKEN=synthetic-secret' }), padding }]));
    let result = (await source.scan()).sessions[0]!.observation;
    assert.equal(result.state, "ended");
    assert.equal(result.turns[0]!.durationMs, 1234);
    assert.equal(result.turns[0]!.lastAgentMessage, '中文😀 "final" TOKEN=[redacted]');
    appendFileSync(path, jsonl([{ ...start(9, "abort"), padding }, { ...event("turn_aborted", 10, { turn_id: "abort", reason: "stop", completed_at: at(10), duration_ms: 1000 }), padding }]));
    result = (await source.scan()).sessions[0]!.observation;
    assert.equal(result.turns.at(-1)!.aborted, true);
    assert.equal(result.turns.at(-1)!.durationMs, 1000);
    assert.ok(largest <= 256 * 1024, `largest JSON.parse input: ${largest}`);
});

test("T17: oversized values before lifecycle keys cannot hide or spoof a turn", async t => {
    const f = fixture(t), padding = '"type":"task_complete", "turn_id":"wrong" '.repeat(20000);
    const path = f.write("late-keys", [meta(), { padding, type: "event_msg", timestamp: at(0), payload: { junk: { type: "task_complete" }, type: "task_started", turn_id: "correct", started_at: at(0) } }]);
    const source = f.source();
    assert.equal((await source.scan()).sessions[0]!.observation.state, "working");
    appendFileSync(path, jsonl([reply(1, "retained final", "final_answer"), {
        payload: { last_agent_message: padding, type: "task_complete", turn_id: "wrong", completed_at: at(2) }, type: "event_msg",
    }]));
    assert.equal((await source.scan()).sessions[0]!.observation.state, "working", "late IDs still isolate unrelated completions");
    appendFileSync(path, jsonl([{ payload: { last_agent_message: padding, type: "task_complete", turn_id: "correct", completed_at: at(3), duration_ms: 3000 }, type: "event_msg" }]));
    const result = (await source.scan()).sessions[0]!.observation;
    assert.equal(result.state, "ended");
    assert.equal(result.turns[0]!.lastAgentMessage, "retained final", "oversized replies fall back to the last bounded final");
    assert.equal(result.turns[0]!.durationMs, 3000);
});

test("T17: byte budget rotates across files and resumes unfinished history on empty dirty scans", async t => {
    const f = fixture(t), chunk = 1024 * 1024;
    const large = f.write("a-large", [meta("large"), start(), { type: "response_item", data: "x".repeat(3 * chunk) }, complete(9)]);
    const small = f.write("b-small", [meta("small"), start(), complete(3)]);
    const reads: { path: string; offset: number; bytes: number }[] = [];
    const source = new CodexSource(f.codex, { maxPassBytes: chunk, read(path, limit, tail, offset) {
        const result = readSourceBytes(path, limit, tail, offset); reads.push({ path, offset: offset!, bytes: result.body.length }); return result;
    } });
    const first = await source.scan();
    assert.equal(reads[0]!.path, large);
    assert.equal(reads.reduce((n, read) => n + read.bytes, 0), chunk);
    assert.ok(first.diagnostics.some(code => code.code === "codex-budget"));
    reads.length = 0;
    let result = await source.scan(new Set());
    assert.equal(reads[0]!.path, small);
    assert.equal(result.sessions.find(s => s.observation.nativeId === "small")!.observation.state, "ended");
    assert.ok(reads.reduce((n, read) => n + read.bytes, 0) <= chunk);
    for (let i = 0; i < 5 && result.diagnostics.length; i++) result = await source.scan(new Set());
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.sessions.find(s => s.observation.nativeId === "large")!.observation.state, "ended");
});

test("T17: per-file caps leave bytes for a second file and preserve bounded partial lines", async t => {
    const f = fixture(t), cap = 300 * 1024;
    const large = f.write("a-large", [meta("large"), start(), { type: "response_item", data: "x".repeat(cap * 3) }, complete(9)]);
    f.write("b-small", [meta("small"), start(), complete(3)]);
    const offsets: number[] = [];
    const source = new CodexSource(f.codex, { maxFileBytes: cap, maxPassBytes: cap * 2, read(path, limit, tail, offset) {
        if (path === large) { assert.ok(limit! <= cap); offsets.push(offset!); }
        return readSourceBytes(path, limit, tail, offset);
    } });
    const first = await source.scan();
    assert.equal(first.sessions.find(s => s.observation.nativeId === "small")!.observation.state, "ended");
    type Follow = { offset: number; partialLine: Buffer };
    const follow = (Reflect.get(source, "follows") as Map<string, Follow>).get(large)!;
    assert.equal(follow.offset, cap);
    assert.ok(follow.partialLine.length <= 256 * 1024);
    let result = first;
    for (let i = 0; i < 4 && result.diagnostics.length; i++) result = await source.scan(new Set());
    assert.deepEqual(offsets, [0, cap, cap * 2, cap * 3]);
    assert.equal(result.sessions.find(s => s.observation.nativeId === "large")!.observation.state, "ended");
});

test("T17: elapsed-time budget rotates service to the other file on the next pass", async t => {
    const f = fixture(t), chunk = 1024 * 1024;
    f.write("a-large", [meta("large"), start(), { type: "response_item", data: "x".repeat(chunk * 2) }]);
    const small = f.write("b-small", [meta("small"), start(), complete(3)]);
    let clock = 0;
    const paths: string[] = [];
    const source = new CodexSource(f.codex, { maxPassMs: 10, budgetNow: () => clock, read(path, ...args) {
        paths.push(path); clock += 10; return readSourceBytes(path, ...args);
    } });
    await source.scan(); assert.equal(paths.length, 1);
    paths.length = 0;
    const result = await source.scan(new Set());
    assert.deepEqual(paths, [small]);
    assert.equal(result.sessions.find(s => s.observation.nativeId === "small")!.observation.state, "ended");
});

test("T17: many incremental records retain only bounded turns, sources and deduplication history", async t => {
    const f = fixture(t);
    const records = Array.from({ length: 5100 }, (_, i) => [start(i * 2, `turn-${i}`), complete(i * 2 + 1, { turn_id: `turn-${i}`, last_agent_message: `answer-${i}` })]).flat();
    f.write("many", [meta(), ...records]);
    const source = f.source();
    const result = (await source.scan()).sessions[0]!.observation;
    assert.equal(result.state, "ended");
    assert.equal(result.turns.length, 20);
    assert.equal(result.sources.length, 12);
    assert.equal(result.turns.at(-1)!.lastAgentMessage, "answer-5099");
    assert.ok(result.turns.every(turn => !turn.factsThrough), "streaming has no artificial record-count gaps");
});

test("T17: complete EOF records without LF are accepted once, including bounded compound replies", async t => {
    const f = fixture(t), path = f.write("eof", [meta(), start()]), source = f.source();
    appendFileSync(path, JSON.stringify(complete(3, { last_agent_message: "no newline" })));
    let result = (await source.scan()).sessions[0]!.observation;
    assert.equal(result.state, "ended");
    assert.equal(result.turns[0]!.lastAgentMessage, "no newline");
    appendFileSync(path, "\n" + jsonl([start(4, "next")]));
    const ending = { ...complete(5, { turn_id: "next", last_agent_message: text("bounded compound reply"), error: { message: "TOKEN=synthetic-error failed" } }), padding: "x".repeat(300000) };
    appendFileSync(path, JSON.stringify(ending));
    result = (await source.scan()).sessions[0]!.observation;
    assert.equal(result.state, "failed");
    assert.equal(result.turns.at(-1)!.lastAgentMessage, "bounded compound reply");
    assert.deepEqual(result.turns.at(-1)!.errors, ["TOKEN=[redacted] failed"]);
    appendFileSync(path, "\n");
    const replay = (await source.scan()).sessions[0]!.observation;
    assert.deepEqual(replay.turns, result.turns);
    assert.deepEqual(replay.sources, result.sources);
});

test("T17: oversized metadata below the existing 1 MiB cap keeps identity and subagent folding", async t => {
    const f = fixture(t);
    f.write("parent", [meta(), start(), complete()]);
    f.write("child", [{ ...childMeta("child"), payload: { ...childMeta("child").payload, base_instructions: { text: "x".repeat(300000) } } }, start(4)]);
    const result = await f.source().scan();
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]!.observation.subagentRunning, true);
});

test("T17 re-probe: append races preserve the session and its last committed follow checkpoint on every pass", async t => {
    const f = fixture(t), path = f.write("append-race", [meta(), start(), prompt()]);
    const originalSize = readFileSync(path).length;
    let mode: "stable" | "during" | "between" = "stable", reads = 0;
    const source = new CodexSource(f.codex, { now: () => Date.parse(at(100)), read(file, ...args) {
        if (file === path) {
            reads++;
            if (mode === "during") {
                appendFileSync(path, jsonl([reply(3, "racing append")]));
                throw new Error("core.errorSourceChangedDuringRead");
            }
            if (mode === "between" && reads === 2) appendFileSync(path, jsonl([reply(5, "between chunks")]));
        }
        return readSourceBytes(file, ...args);
    } });
    const present = async () => {
        const result = await source.scan(new Set([path]));
        const observation = result.sessions.find(s => s.observation.nativeId === "parent")?.observation;
        assert.ok(observation, "the followed session must be emitted on every pass");
        return { ...result, observation };
    };
    const initial = await present();
    type Follow = { offset: number; parser: { snapshot(): CodexObservation } };
    const follow = () => (Reflect.get(source, "follows") as Map<string, Follow>).get(path)!;
    const checkpoint = follow().parser.snapshot();
    appendFileSync(path, jsonl([reply(2, "before the racing read")]));
    mode = "during";
    const failed = await present();
    assert.ok(failed.diagnostics.some(code => code.code === "codex-read"));
    assert.deepEqual(failed.observation.turns, initial.observation.turns);
    assert.equal(follow().offset, originalSize);
    mode = "between"; reads = 0;
    appendFileSync(path, jsonl([{ type: "response_item", padding: "x".repeat(2 * 1024 * 1024) }]));
    const raced = await present();
    assert.ok(raced.diagnostics.some(code => code.code === "codex-read"));
    assert.deepEqual(raced.observation.turns, initial.observation.turns);
    assert.equal(follow().offset, originalSize, "a later chunk failure must roll back earlier chunks in this pass");
    assert.deepEqual(follow().parser.snapshot(), checkpoint);
    mode = "stable";
    assert.equal((await present()).observation.state, "working");
    // The next checkpoint is inside a giant line: rollback must also restore
    // the tokenizer's string/escape state, not just the numeric cursor.
    const oversized = jsonl([{ type: "response_item", padding: "x".repeat(2 * 1024 * 1024) }]);
    appendFileSync(path, oversized.slice(0, 300000));
    await present();
    const partialOffset = follow().offset;
    const sniffer = structuredClone(Reflect.get(follow(), "oversized"));
    assert.ok(sniffer);
    appendFileSync(path, oversized.slice(300000));
    mode = "between"; reads = 0;
    await present();
    assert.equal(follow().offset, partialOffset);
    assert.deepEqual(structuredClone(Reflect.get(follow(), "oversized")), sniffer);
    mode = "stable";
    assert.equal((await present()).observation.state, "working");
    const completion = jsonl([complete(8, { last_agent_message: "completed after retry" })]);
    appendFileSync(path, completion.slice(0, 30));
    assert.equal((await present()).observation.state, "working");
    appendFileSync(path, completion.slice(30));
    const recovered = (await present()).observation;
    assert.equal(recovered.state, "ended");
    assert.equal(recovered.turns[0]!.lastAgentMessage, "completed after retry");
});

test("T17 re-probe: an append during incomplete discovery never drops a followed session", async t => {
    const f = fixture(t), path = f.write("discovery-race", [meta(), start(), prompt()]), source = f.source();
    const initial = await source.scan();
    assert.equal(initial.sessions[0]!.observation.nativeId, "parent");
    const original = fsPromises.readdir;
    let omit = true;
    const mocked = t.mock.method(fsPromises, "readdir", async (...args: unknown[]) => {
        const entries = await Reflect.apply(original, fsPromises, args);
        if (omit && args[0] === dirname(path)) {
            appendFileSync(path, jsonl([reply(2, "appended during discovery")]));
            return entries.filter((entry: { name: string }) => entry.name !== basename(path));
        }
        return entries;
    });
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    const missed = await source.scan();
    assert.equal(missed.sessions.length, 1, "an incomplete listing is not proof the followed file disappeared");
    assert.equal(missed.sessions[0]!.observation.nativeId, "parent");
    assert.deepEqual(missed.sessions[0]!.observation.turns, initial.sessions[0]!.observation.turns);
    assert.ok(missed.diagnostics.length > 0);
    omit = false;
    appendFileSync(path, jsonl([complete(3, { last_agent_message: "completed after discovery retry" })]));
    const recovered = await source.scan(new Set());
    assert.equal(recovered.sessions.length, 1);
    assert.equal(recovered.sessions[0]!.observation.state, "ended");
    assert.equal(recovered.sessions[0]!.observation.turns[0]!.lastAgentMessage, "completed after discovery retry");
    rmSync(path);
    assert.equal((await source.scan()).sessions.length, 0, "confirmed deletions still evict");
});

test("a subagent rollout that embeds its parent's session_meta keeps its own identity and never hides the parent", () => {
    const child = parseCodexRecords([childMeta("child", "parent"), meta("parent"), start(1, "turn-c"), prompt(2, "子任务")], fallback);
    assert.equal(child.nativeId, "child");
    assert.equal(child.parentNativeId, "parent");
});

test("discovery keeps a running parent visible while its subagent rollout (with the parent's session_meta embedded) is newer", async t => {
    const f = fixture(t);
    f.write("parent", [meta("parent"), start(0, "turn-p"), prompt(1, "父任务")], { mtime: 10 });
    f.write("child", [childMeta("child", "parent"), meta("parent"), start(2, "turn-c"), prompt(3, "子任务")], { mtime: 20 });
    const sessions = (await f.source().scan()).sessions.map(c => c.observation);
    const parent = sessions.find(o => o.nativeId === "parent");
    assert.ok(parent, "parent must be emitted");
    assert.equal(parent!.state, "working");
    assert.equal(sessions.some(o => o.nativeId === "child"), false);
});

const parentUuid = "11111111-1111-4111-8111-111111111111";
const childUuid = "22222222-2222-4222-8222-222222222222";

test("T17 R1 F1: growing rewrites reset identity and metadata before following appended bytes", async t => {
    const f = fixture(t);
    for (const named of [false, true]) {
        const id = named ? parentUuid : "before";
        const path = f.write(named ? `2026-10-16T08-00-00-${id}` : "legacy-rewrite", [meta(id), start(), complete()]);
        const source = f.source();
        await source.scan();
        const replacedId = named ? id : "after";
        const newProject = `${project}/rewritten`;
        writeFileSync(path, jsonl([meta(replacedId, { cwd: newProject, originator: "codex_exec" }), start(9, "replacement"), prompt(10, "x".repeat(2000))]));
        const result = await source.scan(new Set([path]));
        const observed = result.sessions.find(s => s.path === path)!.observation;
        assert.equal(observed.nativeId, replacedId);
        assert.equal(observed.project, newProject);
        assert.equal(observed.originator, "codex_exec");
        assert.equal(observed.state, "working");
        assert.equal(observed.turns.length, 1);
        assert.equal(observed.turns[0]!.turnId, digest("replacement"));
        rmSync(path);
    }
});

test("T17 R1 F2: filename UUID rejects foreign metadata in plain and compressed rollouts", async t => {
    const f = fixture(t);
    for (const compressed of [false, true]) {
        const path = f.write(`2026-10-16T08-00-00-${childUuid}`, [
            meta(parentUuid, { cwd: `${project}/wrong`, originator: "wrong" }),
            meta(childUuid, { originator: "codex_exec", source: { subagent: { thread_spawn: { parent_thread_id: parentUuid } } } }),
            meta(parentUuid), start(),
        ], { compressed });
        const result = await f.source().scan();
        const child = result.children.find(s => s.nativeId === childUuid)!;
        assert.equal(child.nativeId, childUuid);
        assert.equal(child.project, project);
        assert.equal(child.originator, "codex_exec");
        assert.equal(child.parentNativeId, parentUuid);
        rmSync(path);
    }
});

test("T17 R1 F2: oversized first metadata cannot make a child impersonate its parent", async t => {
    const f = fixture(t);
    f.write(`2026-10-16T08-00-00-${parentUuid}`, [meta(parentUuid), start()], { mtime: 10 });
    f.write(`2026-10-16T08-00-01-${childUuid}`, [meta(childUuid, { originator: "codex_exec", base_instructions: { text: "x".repeat(1024 * 1024) } }), meta(parentUuid), start()], { mtime: 20 });
    const result = await f.source().scan();
    const parent = result.sessions.find(s => s.observation.nativeId === parentUuid)!;
    assert.ok(parent.path.endsWith(`${parentUuid}.jsonl`));
    assert.equal(parent.observation.state, "working");
    assert.equal(parent.observation.sourceUncertain, false);
});

test("T17 R1 F3: raced reads preserve the exact observation for two minutes and reset grace after recovery", async t => {
    const f = fixture(t), path = f.write("grace", [meta(), start(), prompt()]);
    let now = Date.parse(at(100)), fail = false;
    const source = new CodexSource(f.codex, { now: () => now, read(file, ...args) {
        if (file === path && fail) { appendFileSync(path, " "); throw new Error("core.errorSourceChangedDuringRead"); }
        return readSourceBytes(file, ...args);
    } });
    const initial = (await source.scan()).sessions[0]!.observation;
    appendFileSync(path, jsonl([reply(2, "progress")])); fail = true;
    for (const elapsed of [0, 60000, 119999]) {
        now = Date.parse(at(100)) + elapsed;
        assert.deepEqual((await source.scan(elapsed === 0 ? new Set([path]) : new Set())).sessions[0]!.observation, initial);
    }
    now = Date.parse(at(100)) + 120000;
    const expired = await source.scan(new Set());
    assert.equal(expired.sessions[0]!.observation.state, "unknown");
    assert.equal(expired.sessions[0]!.observation.sourceUncertain, true);
    assert.ok(expired.diagnostics.some(d => d.code === "codex-read"));
    fail = false;
    const recovered = (await source.scan(new Set())).sessions[0]!.observation;
    assert.equal(recovered.state, "working");
    now += 300000; fail = true; appendFileSync(path, " ");
    assert.deepEqual((await source.scan(new Set([path]))).sessions[0]!.observation, recovered);
});

test("T17 R1 F4: fully read certain duplicates beat newer incomplete or unreadable files", async t => {
    const f = fixture(t);
    const healthy = f.write("a-healthy", [meta(), start(), prompt()], { mtime: 10 });
    const duplicate = f.write("b-duplicate", [meta(), complete(), { type: "response_item", output: "x".repeat(1024 * 1024) }, start(5, "next")], { mtime: 20 });
    let fail = false;
    const source = new CodexSource(f.codex, { now: () => Date.parse(at(100)), maxFileBytes: 300000, read(path, ...args) {
        if (path === duplicate && fail) throw new Error("raced");
        return readSourceBytes(path, ...args);
    } });
    let result = await source.scan();
    assert.equal(result.sessions[0]!.path, healthy);
    assert.equal(result.sessions[0]!.observation.state, "working");
    for (let i = 0; i < 4; i++) result = await source.scan(new Set());
    assert.equal(result.sessions[0]!.path, duplicate, "fully read equals prefer newer mtime");
    fail = true; appendFileSync(duplicate, " ");
    assert.equal((await source.scan(new Set([duplicate]))).sessions[0]!.path, healthy);
    fail = false; writeFileSync(duplicate, jsonl([meta()]));
    assert.equal((await source.scan(new Set([duplicate]))).sessions[0]!.path, healthy, "a fully read unknown duplicate is still uncertain evidence");
});

test("T17 R1 F5: malformed oversized lifecycle records create gaps instead of completing turns", async t => {
    const f = fixture(t), padding = "x".repeat(300000);
    const prefix = JSON.stringify(complete()).slice(0, -1);
    const malformed = [
        `${prefix},"padding":"${padding}\n`,
        `${prefix},"padding":"${padding}"} trailing\n`,
        `${prefix} "padding":"${padding}"}\n`,
        `${prefix},"padding" "${padding}"}\n`,
        `${prefix},"padding":"${padding}\\q"}\n`,
        `${prefix},"padding":"${padding}","bad":01}\n`,
        `${prefix},"padding":"${padding}","bad":[1,]}\n`,
        `${prefix},"padding":"${padding}","bad":truE}\n`,
        `${prefix},"padding":"${padding}","bad":{]}\n`,
    ];
    for (const [i, body] of malformed.entries()) {
        const path = f.write(`malformed-${i}`, [meta(), start(), prompt()]);
        appendFileSync(path, body);
        const result = await f.source().scan();
        const observed = result.sessions.find(s => s.path === path)!.observation;
        assert.equal(observed.state, "unknown", `case ${i}`);
        assert.equal(observed.turns[0]!.endedAt, undefined, `case ${i}`);
        assert.ok(result.diagnostics.some(d => d.code === "codex-partial" && d.path === path), `case ${i}`);
        rmSync(path);
    }
});

test("T17 R1 F1: identity probes detect metadata rewrites beyond an unchanged prefix", async t => {
    const f = fixture(t);
    const record = (cwd: string) => ({ type: "session_meta", payload: { base_instructions: { text: "x".repeat(300000) }, id: parentUuid, cwd, originator: "codex_cli_rs" } });
    const path = f.write(`2026-10-16T08-00-00-${parentUuid}`, [record(project), start(), complete()]);
    const offsets: number[] = [], probes: number[] = [];
    const source = new CodexSource(f.codex, { read(file, bytes, tail, offset) { offsets.push(offset!); return readSourceBytes(file, bytes, tail, offset); },
        readIdentity(file, bytes, tail, offset) { probes.push(bytes!); return readSourceBytes(file, bytes, tail, offset); } });
    await source.scan(); offsets.length = 0;
    writeFileSync(path, jsonl([record(`${project}/a-longer-project`), start(8, "new-turn"), prompt(9, "new task")]));
    const result = await source.scan();
    assert.equal(offsets[0], 0);
    assert.equal(result.sessions[0]!.observation.project, `${project}/a-longer-project`);
    assert.equal(result.sessions[0]!.observation.turns[0]!.turnId, digest("new-turn"));
    assert.ok(probes.some(bytes => bytes > 256 * 1024));
    assert.ok(probes.every(bytes => bytes <= 1024 * 1024));
});

test("T17 R1 F5: oversized validation rejects invalid UTF-8 and respects duplicate JSON keys", async t => {
    const f = fixture(t), padding = "x".repeat(300000);
    const path = f.write("invalid-utf8", [meta(), start()]);
    appendFileSync(path, Buffer.concat([Buffer.from(JSON.stringify(complete()).slice(0, -1) + `,"padding":"${padding}`), Buffer.from([0xc0, 0xaf]), Buffer.from('"}\n')]));
    const invalid = await f.source().scan();
    assert.equal(invalid.sessions[0]!.observation.turns[0]!.endedAt, undefined);
    assert.ok(invalid.diagnostics.some(d => d.code === "codex-partial"));
    rmSync(path);
    const duplicate = f.write("duplicate-keys", [meta(), start()]);
    appendFileSync(duplicate, `{"type":"event_msg","timestamp":"${at(3)}","payload":{"type":"task_complete","turn_id":"turn-1"},"padding":"${padding}","payload":{}}\n`);
    let result = await f.source().scan();
    assert.equal(result.sessions[0]!.observation.state, "working");
    appendFileSync(duplicate, `{"type":"event_msg","timestamp":"${at(3)}","payload":{"type":"task_complete","turn_id":"turn-1"},"type":"${padding}"}\n`);
    result = await f.source().scan();
    assert.equal(result.sessions[0]!.observation.turns[0]!.endedAt, undefined);
});

test("T19 review: a permanently unreadable or non-progressing file never keeps requesting fast reruns", async t => {
    const f = fixture(t);
    const path = f.write("stuck", [meta("stuck"), start()]);
    let fail = false;
    const source = new CodexSource(f.codex, { now: () => Date.parse(at(100)), read(p, ...args) { if (fail && p === path) throw new Error("EACCES"); return readSourceBytes(p, ...args); } });
    await source.scan();
    fail = true; appendFileSync(path, jsonl([prompt(5)]));
    await source.scan();
    assert.equal(source.hasBacklog, false);
    await source.scan();
    assert.equal(source.hasBacklog, false);
});

test("T20 Codex activity extracts messages, successful/failed commands, latest file edits and errors", () => {
    const observation = parse([start(), prompt(), reply(2, "首行 token=synthetic-secret\n不应展示的第二行"),
        item("CommandExecution", 3, { command: ["tool", "--token", "synthetic argv secret"], exit_code: 0 }),
        item("FileChange", 4, { changes: { [`${project}/a.ts`]: {} } }),
        item("CommandExecution", 5, { command: "pnpm test", exit_code: 1 }),
        item("FileChange", 6, { changes: { [`${project}/a.ts`]: {}, [`${project}/b.ts`]: {} } }),
        event("error", 7, { message: "api_key=synthetic-error" }),
        event("turn_aborted", 8, { turn_id: "turn-1", reason: "user interrupted" }),
    ]);
    assert.equal(observation.activityIncomplete, false);
    assert.deepEqual(observation.activity.filter(entry => entry.kind === "file").map(entry => [entry.at, entry.text]),
        [[at(6), `${project}/b.ts`], [at(6), `${project}/a.ts`]]);
    assert.deepEqual(observation.activity.filter(entry => entry.kind === "command"), [
        { at: at(5), kind: "command", text: "pnpm test", failed: true },
        { at: at(3), kind: "command", text: "tool --token [redacted]", failed: false },
    ]);
    assert.deepEqual(observation.activity.at(-1), { at: at(2), kind: "message", text: "首行 token=[redacted]" });
    assert.equal(observation.activity[0]!.text, "aborted: user interrupted");
    assert.doesNotMatch(JSON.stringify(observation.activity), /synthetic-secret|synthetic argv secret|synthetic-error|第二行/);
    assert.equal(parse([start(), complete(3, { error: { message: "task failed" } })]).activity[0]!.kind, "error");
});

test("T20 activity is bounded, replayable and retained after a gap without assigning tail facts to a turn", () => {
    const messages = Array.from({ length: 25 }, (_, i) => reply(i + 2, `${i}: ${"字".repeat(250)}\nsecond line`));
    const observation = parse([start(), prompt(), ...messages, ...messages, { type: "aimspan_read_gap" },
        reply(30, "tail message"), item("CommandExecution", 31, { command: "tail command", status: "failed" }),
        item("FileChange", 32, { changes: { [`${project}/tail.ts`]: {} } })]);
    assert.equal(observation.activity.length, 20);
    assert.equal(observation.activityIncomplete, true);
    assert.equal(observation.activity[0]!.text, `${project}/tail.ts`);
    assert.equal(observation.activity[1]!.failed, true);
    assert.ok(observation.activity.every(entry => entry.text.length <= 200));
    assert.deepEqual(observation.turns[0]!.changedFiles, []);
});

test("T20 followed Codex activity survives append, missing newline, read gaps, rescan and restart", async t => {
    const f = fixture(t);
    const path = f.write("activity", [meta(), start(), prompt(), reply(2, "reading")]);
    let store = new Store(join(f.root, "activity-state"), () => at(100)); t.after(() => store.close());
    const source = f.source();
    const scan = async (reader = source) => store.observe((await reader.scan()).sessions[0]!.observation);
    const before = await scan();
    appendFileSync(path, jsonl([item("CommandExecution", 3, { command: "pnpm test", exit_code: 0 }),
        item("FileChange", 4, { changes: { [`${project}/a.ts`]: {} } })]).trimEnd());
    const appended = await scan();
    assert.equal(appended.activity.length, 3); assert.equal(appended.activityIncomplete, false);
    assert.equal(before.activity.length, 1);
    appendFileSync(path, "\n" + jsonl([item("FileChange", 5, { changes: { [`${project}/a.ts`]: {} } })]));
    const updated = await scan();
    assert.equal(updated.activity.length, 3); assert.equal(updated.activity[0]!.at, at(5));
    assert.equal((await scan()).revision, updated.revision);
    // The streaming sniffer preserves lifecycle while explicitly reporting omitted activity.
    appendFileSync(path, jsonl([item("AgentMessage", 6, { content: text("x".repeat(300000)) }), reply(7, "after oversized"), complete(8)]));
    const gapped = await scan();
    assert.equal(gapped.activityIncomplete, true); assert.equal(gapped.state, "waiting");
    assert.equal(gapped.activity[0]!.text, "after oversized");
    assert.deepEqual((await scan(f.source())).activity, gapped.activity);
    store.close(); store = new Store(join(f.root, "activity-state"), () => at(100));
    assert.deepEqual(store.requireSession(gapped.id).activity, gapped.activity);
    assert.equal(store.catchup(gapped.id).activityIncomplete, true);
});

test("T20 compressed windows and pending incremental reads report incomplete activity", async t => {
    const f = fixture(t);
    f.write("compressed-activity", [meta(), start(), prompt(), reply(2, "before"),
        { type: "response_item", payload: { body: "x".repeat(400000) } }, reply(3, "after"), complete(4)], { compressed: true });
    const compressed = (await f.source().scan()).sessions[0]!.observation;
    assert.equal(compressed.activityIncomplete, true);
    assert.equal(compressed.activity[0]!.text, "after");
    const plain = f.write("pending-activity", [meta("pending"), start(), prompt(), ...Array.from({ length: 40 }, (_, i) => reply(i + 2, `message ${i}`))]);
    const limited = new CodexSource(f.codex, { maxFileBytes: 2048, now: () => Date.parse(at(100)) });
    let observation = (await limited.scan()).sessions.find(s => s.path === plain)!.observation;
    assert.equal(observation.activityIncomplete, true);
    for (let i = 0; i < 20 && limited.hasBacklog; i++) observation = (await limited.scan()).sessions.find(s => s.path === plain)!.observation;
    assert.equal(limited.hasBacklog, false); assert.equal(observation.activityIncomplete, false);
    assert.equal(observation.activity.length, 20); assert.equal(observation.activity[0]!.text, "message 39");
});

test("T20 real data: Codex AgentMessage blocks typed 'Text' produce message activity", () => {
    const parsed = parseCodexRecords([meta(), start(0), prompt(1), item("AgentMessage", 2, { content: [{ type: "Text", text: "正在检查设备连接\n细节" }], phase: "commentary" })], fallback);
    assert.equal(parsed.activity?.[0]?.kind, "message");
    assert.equal(parsed.activity?.[0]?.text, "正在检查设备连接");
});

test("T20 real data: shell wrappers are stripped from command activity", async () => {
    const { unwrapShell } = await import("../src/activity.js");
    assert.equal(unwrapShell("/bin/zsh -lc 'pnpm --filter @aimspan/core test'"), "pnpm --filter @aimspan/core test");
    assert.equal(unwrapShell('bash -lc "ls -la"'), "ls -la");
    assert.equal(unwrapShell("sh -c git status"), "git status");
    assert.equal(unwrapShell("pnpm test"), "pnpm test");
});

test("T20 review: a rescan without outcome evidence keeps a known command failure", async () => {
    const { mergeActivity } = await import("../src/activity.js");
    const failed = { at: at(5), kind: "command" as const, text: "pnpm test", failed: true };
    const merged = mergeActivity([failed], [{ at: at(5), kind: "command" as const, text: "pnpm test" }]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.failed, true);
});

test("T20 review: an explicitly aborted, fully read session establishes the first baseline", () => {
    const directory = mkdtempSync("/private/tmp/__aimspan_fixture__-abort-");
    const f = new Store(directory, () => at(100));
    try {
        const parsed = parseCodexRecords([meta("aborted"), start(0, "turn-a"), prompt(1), event("turn_aborted", 2, { turn_id: "turn-a", reason: "interrupted" })], fallback);
        const session = f.observe(parsed);
        assert.notEqual((session as { baselinePending?: boolean }).baselinePending, true);
        assert.ok(session.lastViewedAt && session.handledAt);
    } finally { f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("T21 real data: multi-line command activity keeps only its first line", async () => {
    const { activityEntry } = await import("../src/activity.js");
    assert.equal(activityEntry(at(1), "command", "/bin/zsh -lc 'python3 - <<\\'PY\\'\nfrom pathlib import Path\nPY'").text.includes("\n"), false);
    assert.equal(activityEntry(at(1), "command", "python3 - <<'PY'\nimport json\nPY").text, "python3 - <<'PY'");
});

const guardian = { thread_source: "guardian_review", source: { subagent: { other: "guardian" } }, parent_thread_id: "parent" };
test("T22 child classification covers guardian, string/object subagents and parent precedence", () => {
    const cases: [Record<string, unknown>, boolean, string | undefined][] = [
        [guardian, true, "parent"],
        [{ source: { subagent: "review" }, parent_thread_id: "parent" }, true, "parent"],
        [{ source: { subagent: {} } }, true, undefined],
        [{ source: { subagent: null } }, true, undefined],
        [{ thread_source: "subagent" }, true, undefined],
        [{ thread_source: "future_internal_kind" }, true, undefined],
        [{ thread_source: "user", source: "cli" }, false, undefined],
        // A user thread that merely names a parent stays a listed, counted session.
        [{ thread_source: "user", parent_thread_id: "parent" }, false, undefined],
        [{ source: "cli" }, false, undefined],
        [{ ...guardian, source: { subagent: { thread_spawn: { parent_thread_id: "spawn-parent" } } } }, true, "spawn-parent"],
        [{ ...guardian, source: { subagent: { thread_spawn: { parent_thread_id: null } } } }, true, "parent"],
    ];
    for (const [fields, child, parent] of cases) {
        const parsed = parseCodexRecords([meta("child", fields), start()], fallback);
        assert.equal(parsed.isChild, child, JSON.stringify(fields));
        assert.equal(parsed.parentNativeId, parent);
    }
});

test("T22 guardian and orphan shapes stay hidden in plain, compressed and oversized reads; appends update the parent", async t => {
    for (const compressed of [false, true]) {
        const f = fixture(t);
        f.write("parent", [meta(), start(), complete()], { compressed });
        const path = f.write("guardian", [meta("guardian", { ...guardian, padding: "x".repeat(300000) }), start(10, "guardian-turn")], { compressed });
        for (const [id, fields] of [
            ["string-child", { source: { subagent: "review" } }],
            ["object-child", { source: { subagent: { other: "guardian" } } }],
            ["thread-only", { thread_source: "guardian_review" }],
            ["missing-parent", { ...guardian, parent_thread_id: "missing" }],
        ] as const) f.write(id, [meta(id, { ...fields, padding: "x".repeat(300000) }), start()], { compressed });
        const source = f.source();
        const first = await source.scan();
        assert.deepEqual(first.sessions.map(s => s.observation.nativeId), ["parent"]);
        assert.equal(first.children.length, 5);
        assert.equal(first.sessions[0]!.observation.subagentRunning, true);
        assert.equal(first.sessions[0]!.observation.state, "working");
        if (!compressed) {
            appendFileSync(path, jsonl([event("task_complete", 20, { turn_id: "guardian-turn" })]));
            const next = await source.scan(new Set([path]));
            assert.deepEqual(next.sessions.map(s => s.observation.nativeId), ["parent"]);
            assert.equal(next.sessions[0]!.observation.subagentRunning, false);
            assert.equal(next.sessions[0]!.observation.subagentWaitingAt, at(20));
        }
    }
});

test("T22 a metadata rewrite reclassifies a cached root as a child even beyond an unchanged prefix", async t => {
    const f = fixture(t);
    const record = (fields: Record<string, unknown>) => meta("rewrite", { padding: "x".repeat(300000), ...fields });
    const path = f.write("rewrite", [record({ thread_source: "user" }), start()]);
    const source = f.source();
    assert.equal((await source.scan()).sessions.length, 1);
    writeFileSync(path, jsonl([record(guardian), start(), prompt(2, "longer replacement")]));
    const next = await source.scan(new Set([path]));
    assert.equal(next.sessions.length, 0);
    assert.equal(next.children[0]!.parentNativeId, "parent");
});

test("T22 discovery hides previously persisted internal roots without deleting ideas, including after restart", async t => {
    const f = fixture(t), directory = join(f.root, "state");
    let store = new Store(directory, () => at(100)); t.after(() => store.close());
    const old = store.observe(parseCodexRecords([meta("guardian"), start()], fallback));
    store.call({ method: "idea.save", sessionId: old.id, body: "已有原文保留", expectedRevision: 0, operationId: "keep-child-idea" });
    f.write("guardian", [meta("guardian", guardian), start()]);
    const discovery = new Discovery(store, f, {}, { now: () => Date.parse(at(100)) });
    await discovery.scan();
    assert.equal(store.workspace().sessions.length, 0);
    assert.equal(store.requireSession(old.id).active, false);
    assert.equal(store.workspace().ideas[0]!.body, "已有原文保留");
    store.close(); store = new Store(directory, () => at(100));
    assert.equal(store.workspace().sessions.length, 0);
    assert.equal(store.requireSession(old.id).isChild, true);
    assert.equal(store.workspace().ideas[0]!.sessionId, old.id);
});

test("T22 oversized scalar child markers keep presence without retaining the full value", async t => {
    const f = fixture(t);
    f.write("string-marker", [meta("string-marker", { source: { subagent: "x".repeat(300000) } }), start()]);
    f.write("thread-marker", [meta("thread-marker", { thread_source: "x".repeat(300000) }), start()]);
    const result = await f.source().scan();
    assert.equal(result.sessions.length, 0);
    assert.equal(result.children.length, 2);
    assert.ok(JSON.stringify(result.children).length < 10000);
});
