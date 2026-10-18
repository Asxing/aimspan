import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeRecords, foldClaudeSubagents, parseClaudeRecords, readClaudeRegistry, withClaudeRegistry } from "../src/claude.js";
import type { ClaudeObservation } from "../src/claude.js";
import { Discovery, parseRecords } from "../src/adapters.js";
import { readSource, redact } from "../src/security.js";
import { Store } from "../src/store.js";

const project = "/Users/__aimspan_fixture__/project";
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 15, 8, 0, seconds)).toISOString();
const fallback = { nativeId: "parent", mtime: at(0) };
const record = (type: string, seconds: number, fields: Record<string, unknown> = {}) => ({ type, timestamp: at(seconds), sessionId: "parent", cwd: project, ...fields });
const prompt = (seconds: number, content: unknown = "检查键盘操作", fields: Record<string, unknown> = {}) => record("user", seconds, { message: { role: "user", content }, ...fields });
const assistant = (seconds: number, content: unknown, stop_reason: string | null = null, fields: Record<string, unknown> = {}) => record("assistant", seconds, { message: { role: "assistant", content, stop_reason }, ...fields });
const text = (value: string) => [{ type: "text", text: value }];
const tool = (name: string, id: string, input: Record<string, unknown>) => ({ type: "tool_use", name, id, input });
const result = (seconds: number, id: string, fields: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => prompt(seconds, [{ type: "tool_result", tool_use_id: id, content: "synthetic output", ...fields }], extra);
const parse = (records: unknown[]) => parseClaudeRecords(records, fallback);
const jsonl = (records: unknown[]) => records.map(value => JSON.stringify(value)).join("\n") + "\n";

function fixture(t: { after(fn: () => void): void }) {
    const root = mkdtempSync("/private/tmp/__aimspan_fixture__-claude-");
    const claude = join(root, "claude"), codex = join(root, "codex"), sessions = join(claude, "sessions"), transcripts = join(claude, "projects", "synthetic-project");
    for (const path of [sessions, transcripts, codex]) mkdirSync(path, { recursive: true });
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return { root, claude, codex, sessions, transcripts };
}

test("a real prompt opens a turn; final text closes it with native or computed duration", () => {
    const open = parse([prompt(0), assistant(1, text("仍在处理"))]);
    assert.equal(open.agent, "claude-code");
    assert.equal(open.nativeId, "parent");
    assert.equal(open.project, project);
    assert.equal(open.state, "working");
    assert.equal(open.lastPromptAt, at(0));
    assert.deepEqual(open.turns, [{ promptAt: at(0), errors: [], changedFiles: [], failedCommands: [] }]);
    const ended = parse([prompt(0), assistant(5, [...text("第一段"), { type: "thinking", thinking: "private reasoning" }, ...text("第二段")], "end_turn"), record("system", 6, { subtype: "turn_duration", durationMs: 4321 })]);
    assert.equal(ended.state, "ended");
    assert.equal(ended.turns[0]!.endedAt, at(5));
    assert.equal(ended.turns[0]!.durationMs, 4321);
    assert.equal(ended.turns[0]!.lastAgentMessage, "第一段\n第二段");
    assert.equal(parse([prompt(0), assistant(5, text("完成"), "end_turn")]).turns[0]!.durationMs, 5000);
    assert.equal(parseRecords("claude-code", [prompt(0)], fallback).turns.length, 1);
});

test("meta, injected, command tags and tool output never start turns or become titles", () => {
    const ignored = [
        prompt(0, "meta", { isMeta: true }), prompt(1, "injected", { isInjected: true }), prompt(2, "injected", { injected: true }),
        ...["<command-name>test", "<command-message>test", "<local-command-stdout>test", "<system-reminder>test", "<environment>test"].map((body, i) => prompt(i + 3, `  ${body}`)),
        result(9, "t"), prompt(10, "tool output", { toolUseResult: { interrupted: true } }),
    ];
    assert.equal(parse(ignored).turns.length, 0);
    const parsed = parse([...ignored, prompt(11, [{ type: "tool_result", tool_use_id: "t" }, ...text("真正的指令")])]);
    assert.equal(parsed.turns.length, 1);
    assert.equal(parsed.title, "真正的指令");
    assert.equal(parsed.lastPromptAt, at(11));
});

test("keeps the last 20 turns and deduplicates header/tail overlap without merging prompts", () => {
    const records = Array.from({ length: 25 }, (_, i) => [prompt(i * 3, `prompt ${i}`), assistant(i * 3 + 1, text(`answer ${i}`), "end_turn")]).flat();
    const parsed = parse([...records.slice(0, 10), ...records]);
    assert.equal(parsed.turns.length, 20);
    assert.equal(parsed.turns[0]!.promptAt, at(15));
    assert.equal(parsed.turns[19]!.lastAgentMessage, "answer 24");
    assert.equal(parsed.title, "prompt 0");
    assert.equal(parsed.lastPromptAt, at(72));
    assert.equal(parsed.sources.length, 12);
    const interrupted = parse([prompt(0), prompt(1), assistant(2, text("only second turn"), "end_turn")]);
    assert.equal(interrupted.turns[0]!.endedAt, undefined);
    assert.equal(interrupted.turns[1]!.endedAt, at(2));
});

test("custom titles outrank AI titles and first prompts regardless of record order", () => {
    const user = prompt(0, "first prompt");
    const ai = record("ai-title", 1, { aiTitle: "AI title" });
    const custom = record("custom-title", 2, { customTitle: "Custom title" });
    assert.equal(parse([user]).title, "first prompt");
    assert.equal(parse([user, ai]).title, "AI title");
    assert.equal(parse([custom, user, ai]).title, "Custom title");
    assert.equal(parse([user, ai, record("custom-title", 3, { customTitle: "字".repeat(200) })]).title.length, 120);
});

test("errors, summaries and final replies are redacted and bounded before observation", () => {
    const parsed = parse([
        prompt(0), record("system", 1, { subtype: "api_error", error: { message: 'authorization: "synthetic-error" ' + "e".repeat(900) } }),
        assistant(2, text("api_key=synthetic-key\n" + "a".repeat(21000)), "end_turn"),
        record("system", 3, { subtype: "away_summary", content: text("password=synthetic-password\n" + "s".repeat(5000)) }),
    ]);
    const turn = parsed.turns[0]!;
    assert.equal(turn.lastAgentMessage!.length, 20000);
    assert.equal(turn.errors[0]!.length, 500);
    assert.equal(turn.awaySummary!.length, 4000);
    assert.match(turn.lastAgentMessage!, /api_key=\[redacted\]/);
    assert.match(turn.errors[0]!, /authorization: \[redacted\]/);
    assert.match(turn.awaySummary!, /password=\[redacted\]/);
    assert.doesNotMatch(JSON.stringify(parsed), /synthetic-(key|password|error)/);
    const privateKey = parse([prompt(0), assistant(2, text("ok\n-----BEGIN PRIVATE KEY-----\nsynthetic-material\n-----END PRIVATE KEY-----"), "end_turn")]);
    assert.equal(privateKey.turns[0]!.lastAgentMessage, "ok\n[redacted]");
});

test("changed paths include all four editing tools, dedupe and cap at 200", () => {
    const paths = ["Edit", "Write", "MultiEdit", "NotebookEdit"].map((name, i) => tool(name, `edit-${i}`, { file_path: `${project}/file-${i}` }));
    const parsed = parse([prompt(0), assistant(1, [...paths, paths[0], tool("Read", "read", { file_path: `${project}/read` })])]);
    // A repeated edit moves the file to its last-occurrence position.
    assert.deepEqual(parsed.turns[0]!.changedFiles, [1, 2, 3, 0].map(i => `${project}/file-${i}`));
    assert.equal(parse([prompt(0), assistant(1, Array.from({ length: 250 }, (_, i) => tool("Write", `w-${i}`, { file_path: `${project}/${i}` })))]).turns[0]!.changedFiles.length, 200);
});

test("only matching failed/interrupted Bash results are recorded, in either result format", () => {
    const parsed = parse([
        prompt(0), assistant(1, [tool("Bash", "ok", { command: "successful" }), tool("Bash", "bad", { command: "api_key=synthetic-command test" }), tool("Bash", "stop", { command: "interrupted" }), tool("Bash", "direct", { command: "direct result" }), tool("Bash", "unmatched", { command: "still pending" }), tool("Write", "write", { file_path: `${project}/a` })]),
        result(2, "ok"), result(3, "bad", { is_error: true }), result(4, "stop", {}, { toolUseResult: { interrupted: true } }),
        prompt(5, "failed output", { toolUseID: "direct", toolUseResult: { is_error: true } }),
        result(6, "missing", { is_error: true }), result(7, "write", { is_error: true }),
    ]);
    assert.equal(parsed.turns.length, 1);
    assert.deepEqual(parsed.turns[0]!.failedCommands, ["api_key=[redacted] test", "interrupted", "direct result"]);
    const many = Array.from({ length: 60 }, (_, i) => [assistant(i * 2 + 1, [tool("Bash", `b${i}`, { command: `${i} ${"x".repeat(400)}` })]), result(i * 2 + 2, `b${i}`, { is_error: true })]).flat();
    const failures = parse([prompt(0), ...many]).turns[0]!.failedCommands;
    assert.equal(failures.length, 50);
    assert.ok(failures.every(command => command.length === 300));
    const repeated = parse([prompt(0), assistant(1, [tool("Bash", "first", { command: "same command" }), tool("Bash", "second", { command: "same command" })]), result(2, "first", { is_error: true }, { toolUseResult: { interrupted: true } }), result(3, "second", { is_error: true })]);
    assert.deepEqual(repeated.turns[0]!.failedCommands, ["same command", "same command"]);
});

test("sidechain work folds into the parent without opening or ending its turns", () => {
    const side = { isSidechain: true, agentId: "child" };
    const records = [prompt(0), assistant(2, text("main done"), "end_turn"), prompt(3, "child prompt", side), assistant(4, [tool("Edit", "e", { file_path: `${project}/child` }), tool("Bash", "b", { command: "child failure" })], null, side), result(5, "b", { is_error: true }, side)];
    const active = parse(records);
    assert.equal(active.nativeId, "parent");
    assert.equal(parse([...records, prompt(6, "different child ID", { ...side, sessionId: "child-native" })]).nativeId, "parent");
    assert.equal(active.parentNativeId, undefined);
    assert.equal(active.subagentRunning, true);
    assert.equal(active.state, "working");
    assert.equal(active.turns.length, 1);
    assert.equal(active.turns[0]!.endedAt, at(2));
    assert.equal(active.turns[0]!.lastAgentMessage, "main done");
    assert.deepEqual(active.turns[0]!.changedFiles, [`${project}/child`]);
    assert.deepEqual(active.turns[0]!.failedCommands, ["child failure"]);
    assert.equal(parse([...records, assistant(6, text("child done"), "end_turn", side)]).subagentRunning, false);
    assert.equal(parse([...records, assistant(6, text("child done"), "end_turn", side)]).at, at(6));
    assert.equal(parse([...records, record("result", 6, side)]).subagentRunning, false);
    assert.equal(parse([...records, assistant(6, text("main later"), "end_turn")]).subagentRunning, false);
    assert.equal(parse([...records, assistant(6, text("other done"), "end_turn", { ...side, agentId: "other" })]).subagentRunning, true);
});

test("a terminal Claude child preserves its later waiting timestamp without changing the parent turn", () => {
    const parent = parse([prompt(0), assistant(2, text("parent done"), "end_turn")]);
    const folded = foldClaudeSubagents(parent, [{ records: [prompt(3, "child work"), assistant(4, text("child done"), "end_turn")], mtime: at(4) }]);
    assert.equal(folded.subagentRunning, false);
    assert.equal(folded.subagentWaitingAt, at(4));
    assert.equal(folded.turns[0]!.endedAt, at(2));
    assert.equal(folded.turns[0]!.lastAgentMessage, "parent done");
});

test("registry liveness is injected, dead PIDs ignored, key files never reach the reader", async t => {
    const f = fixture(t);
    const entry = (pid: number, sessionId: string, status: string) => ({ pid, sessionId, cwd: project, entrypoint: "claude-desktop", kind: "session", status, statusUpdatedAt: Date.parse(at(9)), name: "ignored name", version: "synthetic", procStart: 1, messagingSocketPath: "/__aimspan_fixture__/socket" });
    for (const [pid, id, status] of [[101, "live", "busy"], [102, "dead", "running"], [103, "unknown", "future-native-status"]] as const) writeFileSync(join(f.sessions, `${pid}.json`), JSON.stringify(entry(pid, id, status)));
    const key = join(f.sessions, "101.key");
    writeFileSync(key, "must never be opened");
    const before = statSync(key), reads: string[] = [], checks: number[] = [];
    const registry = await readClaudeRegistry(f.claude, { read(path, ...args) { reads.push(path); assert.ok(path.endsWith(".json")); return readSource(path, ...args); }, isPidAlive(pid) { checks.push(pid); return pid !== 102; } });
    assert.deepEqual(checks.sort(), [101, 102, 103]);
    assert.equal(reads.length, 3);
    assert.equal(statSync(key).atimeMs, before.atimeMs);
    assert.equal(registry.sessions.has("dead"), false);
    assert.equal(registry.sessions.size, 2);
    assert.deepEqual(registry.diagnostics, []);
    const live = withClaudeRegistry(parse([prompt(0)]), registry.sessions.get("live"));
    assert.equal(live.registry.live, true);
    assert.equal(live.registry.statusUpdatedAt, at(9));
    assert.equal(live.entrypoint, "claude-desktop");
    assert.equal(live.state, "working");
    const unknown = withClaudeRegistry(parse([prompt(0)]), registry.sessions.get("unknown"));
    assert.equal(unknown.state, "working");
    assert.equal(unknown.registry.status, "future-native-status");
});

test("registry reader rejects symlinks, invalid PIDs and partial entries", async t => {
    const f = fixture(t);
    const value = { pid: 200, sessionId: "a", cwd: project, status: "busy" };
    writeFileSync(join(f.sessions, "200.json"), JSON.stringify(value));
    symlinkSync(join(f.sessions, "200.json"), join(f.sessions, "201.json"));
    writeFileSync(join(f.sessions, "202.json"), JSON.stringify({ ...value, pid: -1 }));
    writeFileSync(join(f.sessions, "203.json"), '{"pid":203');
    writeFileSync(join(f.sessions, "204.json"), JSON.stringify({ ...value, pid: 204, kind: "subagent" }));
    const reads: string[] = [];
    const registry = await readClaudeRegistry(f.claude, { read(path, ...args) { reads.push(path); return readSource(path, ...args); }, isPidAlive: () => true });
    assert.equal(registry.sessions.size, 1);
    assert.equal(reads.some(path => path.endsWith("201.json")), false);
    assert.ok(registry.diagnostics.length > 0);
});

test("oversized and truncated lines do not hide subsequent valid records", () => {
    const body = jsonl([prompt(0)]) + '{"broken":\n' + JSON.stringify(assistant(1, text("x".repeat(300000)))) + "\n" + jsonl([assistant(2, text("done"), "end_turn")]) + '{"unfinished":';
    const parsed = parse(claudeRecords(body));
    assert.equal(parsed.turns.length, 1);
    assert.equal(parsed.turns[0]!.lastAgentMessage, "done");
    assert.equal(parsed.turns[0]!.endedAt, at(2));
});

test("discovery emits normalized facts, preserves Codex and rechecks registry on cached transcripts", async t => {
    const f = fixture(t), transcript = join(f.transcripts, "parent.jsonl"), registryPath = join(f.sessions, "301.json");
    const source = jsonl([prompt(0), assistant(2, text("api_key=synthetic-discovery completed"), "end_turn")]);
    writeFileSync(transcript, source);
    writeFileSync(registryPath, JSON.stringify({ pid: 301, sessionId: "parent", cwd: project, status: "busy", statusUpdatedAt: at(3), entrypoint: "cli" }));
    writeFileSync(join(f.sessions, "301.key"), "must never be read");
    writeFileSync(join(f.codex, "codex.jsonl"), jsonl([{ type: "session_meta", payload: { id: "codex-session", cwd: project } }, { type: "event_msg", timestamp: at(2), payload: { type: "task_complete" } }]));
    const child = join(f.transcripts, "subagents"); mkdirSync(child);
    writeFileSync(join(child, "agent-child.jsonl"), jsonl([prompt(1, "child", { isSidechain: true, agentId: "child" })]));
    writeFileSync(join(f.transcripts, "sidechain-only.jsonl"), jsonl([prompt(1, "child", { isSidechain: true, agentId: "child" })]));
    const store = new Store(join(f.root, "state"), () => at(10)); t.after(() => store.close());
    const observations: ClaudeObservation[] = [], reads: string[] = [];
    const original = store.observe.bind(store);
    store.observe = value => { if (value.agent === "claude-code") observations.push(value as ClaudeObservation); return original(value); };
    let alive = true;
    const discovery = new Discovery(store, f, { isPidAlive: () => alive, read(path, ...args) { reads.push(path); assert.ok(!path.endsWith(".key")); return readSource(path, ...args); } });
    await discovery.scan();
    assert.equal(store.workspace().sessions.length, 2);
    assert.equal(store.workspace().sessions.find(session => session.agent === "codex")!.state, "idle");
    assert.equal(observations.at(-1)!.state, "working");
    assert.equal(observations.at(-1)!.turns[0]!.lastAgentMessage, "api_key=[redacted] completed");
    const initialReads = reads.filter(path => path === transcript).length;
    assert.equal(initialReads, 2);
    alive = false;
    await discovery.scan();
    assert.equal(reads.filter(path => path === transcript).length, initialReads);
    assert.equal(observations.at(-1)!.registry.live, false);
    assert.equal(observations.at(-1)!.state, "ended");
    // The later busy timestamp is evidence of another run, whose end is still unknown.
    assert.equal(store.workspace().sessions.find(session => session.agent === "claude-code")!.state, "unknown");
    alive = true;
    await discovery.scan();
    assert.equal(store.workspace().sessions.find(session => session.agent === "claude-code")!.state, "running");
    alive = false;
    await new Discovery(store, f, { isPidAlive: () => alive }).scan();
    assert.equal(store.workspace().sessions.find(session => session.agent === "claude-code")!.state, "unknown");
    assert.equal(readFileSync(transcript, "utf8"), source);
    assert.deepEqual(store.diagnostics, []);
});

test("registry-only sessions survive PID exit as unknown; unreadable input keeps existing data", async t => {
    const f = fixture(t), path = join(f.sessions, "401.json");
    writeFileSync(path, JSON.stringify({ pid: 401, sessionId: "live-only", cwd: project, status: "busy", statusUpdatedAt: at(1) }));
    const store = new Store(join(f.root, "state"), () => at(10)); t.after(() => store.close());
    let alive = true;
    const discovery = new Discovery(store, f, { isPidAlive: () => alive });
    await discovery.scan();
    const session = store.workspace().sessions[0]!;
    assert.equal(store.requireSession(session.id).state, "running");
    store.call({ method: "idea.save", sessionId: session.id, body: "保留我的想法", expectedRevision: 0, operationId: "save" });
    writeFileSync(path, '{"pid":');
    await discovery.scan();
    assert.equal(store.requireSession(session.id).state, "unknown");
    assert.ok(store.diagnostics.length > 0);
    rmSync(path); alive = false;
    await discovery.scan();
    assert.equal(store.requireSession(session.id).state, "unknown");
    assert.equal(store.workspace().ideas[0]!.body, "保留我的想法");
});

test("bounded discovery tolerates huge lines and does not stitch turns across an omitted middle", async t => {
    const f = fixture(t), path = join(f.transcripts, "parent.jsonl");
    writeFileSync(path, jsonl([prompt(0), assistant(1, text("x".repeat(400000))), assistant(2, text("unanchored final"), "end_turn"), prompt(3), assistant(4, text("tail answer"), "end_turn")]) + '{"unfinished":');
    const store = new Store(join(f.root, "state"), () => at(10)); t.after(() => store.close());
    let observed: ClaudeObservation | undefined;
    const original = store.observe.bind(store);
    store.observe = value => { observed = value as ClaudeObservation; return original(value); };
    await new Discovery(store, f).scan();
    assert.equal(observed!.turns.length, 2);
    assert.equal(observed!.turns[0]!.endedAt, undefined);
    assert.equal(observed!.turns[1]!.lastAgentMessage, "tail answer");
    assert.equal(observed!.title, "检查键盘操作");
});

test("discovery refuses a replaced transcript and a symlink source without creating sessions", async t => {
    const f = fixture(t), path = join(f.transcripts, "parent.jsonl");
    writeFileSync(path, jsonl([prompt(0)]));
    symlinkSync(path, join(f.transcripts, "link.jsonl"));
    const store = new Store(join(f.root, "state"), () => at(10)); t.after(() => store.close());
    await new Discovery(store, f, { read(file, maxBytes, tail) { const source = readSource(file, maxBytes, tail); return tail ? { ...source, identity: "replaced" } : source; } }).scan();
    assert.equal(store.workspace().sessions.length, 0);
    assert.ok(store.diagnostics.length > 0);
});

test("R1 secrets in failed commands are redacted by the shared redactor", () => {
    const commands = [
        'curl -H "Authorization: Bearer synthetic-header" https://example.invalid',
        "curl -H 'Authorization: Bearer synthetic-single' https://example.invalid",
        'curl -H "Authorization: Basic synthetic-basic" https://example.invalid',
        'tool --token=synthetic-token --password="synthetic password" --api_key=synthetic-key',
        'API_KEY=synthetic-env ACCESS_TOKEN=synthetic-access OPENAI_API_KEY=synthetic-provider tool',
        'TOKEN="synthetic token" PASSWORD=synthetic-password tool',
        'tool --password="synthetic \\"quoted\\" value" --token=synthetic\\ escaped',
        '{"authorization":"Bearer synthetic-json","token":"synthetic-json-token"}',
        'Authorization:\nBearer synthetic-multiline',
        'password:\n"synthetic-multiline-password"',
    ];
    for (const command of commands) {
        assert.doesNotMatch(redact(command), /synthetic/, command);
        const captured = parse([prompt(0), assistant(1, [tool("Bash", "failed", { command })]), result(2, "failed", { is_error: true })]);
        assert.doesNotMatch(JSON.stringify(captured), /synthetic/, command);
        assert.equal(captured.turns[0]!.failedCommands.length, 1);
    }
    assert.equal(redact("ordinary command and tokenization"), "ordinary command and tokenization");
    assert.equal(redact('token="synthetic value" trailing', 18), 'token=[redacted] t');
});

test("R2 a read gap drops old completion and derives state from tail evidence", async t => {
    const f = fixture(t), path = join(f.transcripts, "parent.jsonl");
    const header = [prompt(0), assistant(1, text("old completed turn"), "end_turn")];
    const omitted = assistant(2, text("x".repeat(400000)));
    const store = new Store(join(f.root, "state"), () => at(10)); t.after(() => store.close());
    const observations: ClaudeObservation[] = [];
    const original = store.observe.bind(store);
    store.observe = value => { observations.push(value as ClaudeObservation); return original(value); };
    const discovery = new Discovery(store, f);
    writeFileSync(path, jsonl([...header, omitted, assistant(4, [tool("Bash", "active", { command: "still working" })], "tool_use")]));
    await discovery.scan();
    assert.equal(observations.at(-1)!.state, "working");
    assert.equal(observations.at(-1)!.confidence, "inferred");
    assert.equal(observations.at(-1)!.turns.length, 1);
    writeFileSync(path, jsonl([...header, omitted, record("system", 5, { subtype: "unrecognized" })]));
    await discovery.scan();
    assert.equal(observations.at(-1)!.state, "unknown");
    assert.equal(observations.at(-1)!.confidence, "unknown");
    const thinking = parse([...header, { type: "aimspan_read_gap" }, assistant(6, [{ type: "thinking", thinking: "private reasoning" }])]);
    assert.equal(thinking.state, "working");
    assert.equal(thinking.confidence, "inferred");
    assert.doesNotMatch(JSON.stringify(thinking), /private reasoning/);
});

test("a Claude completion after a read gap closes the latest stored open turn idempotently", t => {
    const f = fixture(t), store = new Store(join(f.root, "state"), () => at(30)); t.after(() => store.close());
    const header = [prompt(0), assistant(1, text("historical answer"), "end_turn")];
    const session = store.observe(parse([...header, prompt(5, "long task", { uuid: "long-task" })]));
    const completion = parse([...header, { type: "aimspan_read_gap" }, assistant(20, text("api_key=synthetic-long-secret final answer"), "end_turn")]);
    assert.deepEqual(completion.trailingCompletion, { endedAt: at(20), lastAgentMessage: "api_key=[redacted] final answer", lastAgentMessageTruncated: false });
    assert.equal(completion.turns.length, 1);
    const result = store.observe(completion);
    assert.equal(result.state, "waiting"); assert.equal(result.hasNewResult, true);
    assert.equal(result.lastPromptAt, at(5)); assert.equal(result.lastTurnEndAt, at(20));
    const turns = store.turns(session.id);
    assert.equal(turns.length, 2); assert.equal(turns[0]!.lastAgentMessage, "historical answer");
    assert.equal(turns[1]!.endedAt, at(20)); assert.equal(turns[1]!.lastAgentMessage, "api_key=[redacted] final answer");
    assert.deepEqual(store.observe(completion), result);
    assert.deepEqual(store.turns(session.id), turns);
});

test("an uncorrelatable Claude trailing completion makes the session unknown instead of stale running", t => {
    const f = fixture(t); let store = new Store(join(f.root, "state"), () => at(40)); t.after(() => store.close());
    const session = store.observe(parse([prompt(25, "newer task")]));
    const completion = parse([{ type: "aimspan_read_gap" }, assistant(20, text("older completion"), "end_turn"), record("system", 26, { subtype: "turn_duration", durationMs: 5000 })]);
    const result = store.observe(completion);
    assert.equal(result.state, "unknown");
    assert.equal(store.turns(session.id)[0]!.endedAt, undefined);
    assert.equal(store.turns(session.id)[0]!.lastAgentMessage, undefined);
    assert.deepEqual(result.unmatchedCompletion, { endedAt: at(20), lastAgentMessage: "older completion", lastAgentMessageTruncated: false });
    store.close(); store = new Store(join(f.root, "state"), () => at(40));
    assert.equal(store.requireSession(session.id).state, "unknown");
    assert.deepEqual(store.requireSession(session.id).unmatchedCompletion, result.unmatchedCompletion);
    assert.equal(store.observe(parse([prompt(30, "confirmed newer prompt")])).state, "running");
    assert.equal(store.requireSession(session.id).unmatchedCompletion, undefined);
    assert.equal(store.observe(completion).state, "running", "an older replay must not erase a newer prompt");
});

test("Claude trailing completions are bounded and never attached to an unobserved header prompt", t => {
    const f = fixture(t), store = new Store(join(f.root, "state"), () => at(30)); t.after(() => store.close());
    const completion = assistant(20, text("api_key=synthetic-orphan-secret\n" + "x".repeat(21000)), "end_turn");
    const observed = parse([prompt(0), { type: "aimspan_read_gap" }, completion]);
    assert.equal(observed.turns[0]!.endedAt, undefined);
    assert.equal(observed.trailingCompletion!.endedAt, at(20));
    assert.equal(observed.trailingCompletion!.lastAgentMessage!.length, 20000);
    assert.doesNotMatch(JSON.stringify(observed.trailingCompletion), /synthetic-orphan-secret/);
    const result = store.observe(observed);
    assert.equal(result.state, "unknown"); assert.equal(result.hasNewResult, false);
    assert.equal(store.turns(result.id)[0]!.endedAt, undefined);
    assert.deepEqual(result.unmatchedCompletion, observed.trailingCompletion);
    assert.equal(store.observe(observed).state, "unknown", "replay cannot establish previously missing correlation");
    assert.equal(store.turns(result.id)[0]!.endedAt, undefined);
    assert.equal(parse([{ type: "aimspan_read_gap" }, completion, prompt(25)]).trailingCompletion, undefined);
    assert.equal(parse([{ type: "aimspan_read_gap" }, { ...completion, isSidechain: true }]).trailingCompletion, undefined);
});

test("ambiguous same-time Claude prompts cannot be closed by a trailing completion", t => {
    const f = fixture(t), store = new Store(join(f.root, "state"), () => at(30)); t.after(() => store.close());
    const session = store.observe(parse([prompt(5, "first", { uuid: "first" }), prompt(5, "second", { uuid: "second" })]));
    const result = store.observe(parse([{ type: "aimspan_read_gap" }, assistant(20, text("uncorrelated"), "end_turn")]));
    assert.equal(result.state, "unknown");
    assert.ok(store.turns(session.id).every(turn => !turn.endedAt));
});

test("a newly discovered same-time prompt cannot redirect a trailing completion to another stored turn", t => {
    const f = fixture(t), store = new Store(join(f.root, "state"), () => at(30)); t.after(() => store.close());
    const session = store.observe(parse([prompt(5, "stored", { uuid: "stored" })]));
    const result = store.observe(parse([prompt(5, "newly discovered", { uuid: "new" }), { type: "aimspan_read_gap" }, assistant(20, text("uncorrelated"), "end_turn")]));
    assert.equal(result.state, "unknown");
    const turns = store.turns(session.id);
    assert.equal(turns.length, 2); assert.ok(turns.every(turn => !turn.endedAt && !turn.lastAgentMessage));
    assert.equal(new Set(turns.map(turn => turn.turnId)).size, 2);
});

test("discovery closes a long Claude turn when its prompt leaves both bounded read windows", async t => {
    const f = fixture(t), path = join(f.transcripts, "parent.jsonl");
    const header = [prompt(0, "historical", { uuid: "header-prompt" }), assistant(1, text("historical reply"), "end_turn", { uuid: "header-end" })];
    writeFileSync(path, jsonl([...header, record("progress", 2, { content: "x".repeat(60000) }), prompt(5, "long task", { uuid: "long" })]));
    const store = new Store(join(f.root, "state"), () => at(30)); t.after(() => store.close());
    const discovery = new Discovery(store, f);
    await discovery.scan();
    const session = store.workspace().sessions[0]!;
    assert.equal(session.state, "running"); assert.equal(session.lastPromptAt, at(5));
    appendFileSync(path, jsonl([assistant(10, text("x".repeat(400000))), assistant(20, text("completed long task"), "end_turn", { uuid: "long-end" })]));
    await discovery.scan(new Set([path]));
    const completed = store.workspace().sessions[0]!;
    assert.equal(completed.state, "waiting"); assert.equal(completed.hasNewResult, true);
    const turns = store.turns(session.id);
    assert.equal(turns.length, 2); assert.equal(turns[0]!.lastAgentMessage, "historical reply");
    assert.equal(turns[1]!.promptAt, at(5)); assert.equal(turns[1]!.endedAt, at(20)); assert.equal(turns[1]!.lastAgentMessage, "completed long task");
    await discovery.scan(); assert.equal(store.requireSession(session.id).revision, completed.revision);
});

test("R3 nested subagent tails fold into a cached parent without creating sessions", async t => {
    const f = fixture(t), parent = join(f.transcripts, "parent.jsonl"), children = join(f.transcripts, "parent", "subagents");
    mkdirSync(children, { recursive: true });
    writeFileSync(parent, jsonl([prompt(0), assistant(2, text("parent done"), "end_turn")]));
    const child = join(children, "agent-worker.jsonl");
    const work = [assistant(3, [tool("Write", "w", { file_path: `${project}/child.ts` }), tool("Bash", "b", { command: "failed child command" })], "tool_use"), result(4, "b", { is_error: true })];
    // No child prompt is visible in the bounded tail.
    writeFileSync(child, jsonl([assistant(1, text("x".repeat(300000))), ...work]));
    const store = new Store(join(f.root, "state"), () => at(10)); t.after(() => store.close());
    const observations: ClaudeObservation[] = [], reads: { path: string; tail: boolean | undefined; bytes: number | undefined }[] = [];
    const original = store.observe.bind(store);
    store.observe = value => { observations.push(value as ClaudeObservation); return original(value); };
    const discovery = new Discovery(store, f, { isPidAlive: () => true, read(path, bytes, tail) { reads.push({ path, tail, bytes }); return readSource(path, bytes, tail); } });
    await discovery.scan();
    const active = observations.at(-1)!;
    assert.equal(active.state, "working");
    assert.equal(active.subagentRunning, true);
    assert.equal(active.turns.length, 1);
    assert.equal(active.turns[0]!.lastAgentMessage, "parent done");
    assert.deepEqual(active.turns[0]!.changedFiles, [`${project}/child.ts`]);
    assert.deepEqual(active.turns[0]!.failedCommands, ["failed child command"]);
    assert.equal(store.workspace().sessions.length, 1);
    assert.equal(reads.filter(read => read.path === parent).length, 2);
    assert.ok(reads.filter(read => read.path === child).every(read => read.tail === true && read.bytes! <= 256 * 1024));
    writeFileSync(join(f.sessions, "701.json"), JSON.stringify({ pid: 701, sessionId: "parent", cwd: project, status: "idle", statusUpdatedAt: at(2) }));
    await discovery.scan();
    assert.equal(observations.at(-1)!.state, "working");
    writeFileSync(child, jsonl([...work, assistant(5, text("child done"), "end_turn")]));
    await discovery.scan();
    assert.equal(observations.at(-1)!.subagentRunning, false);
    assert.equal(observations.at(-1)!.state, "ended");
    assert.equal(reads.filter(read => read.path === parent).length, 2);
    assert.deepEqual(observations.at(-1)!.turns[0]!.failedCommands, ["failed child command"]);
    writeFileSync(parent, jsonl([prompt(0), assistant(2, text("parent done"), "end_turn"), record("custom-title", 6, { customTitle: "latest main record" })]));
    writeFileSync(child, jsonl(work));
    await discovery.scan();
    assert.equal(observations.at(-1)!.subagentRunning, false);
});

test("R3 nested subagent discovery caps reads at 20 and refuses symlinks", async t => {
    const f = fixture(t), children = join(f.transcripts, "parent", "subagents");
    mkdirSync(children, { recursive: true });
    writeFileSync(join(f.transcripts, "parent.jsonl"), jsonl([prompt(0)]));
    for (let i = 0; i < 22; i++) writeFileSync(join(children, `agent-${i}.jsonl`), jsonl([assistant(1, text("done"), "end_turn")]));
    writeFileSync(join(children, "credentials.key"), "never open");
    symlinkSync(join(children, "agent-0.jsonl"), join(children, "agent-link.jsonl"));
    const store = new Store(join(f.root, "state"), () => at(10)); t.after(() => store.close());
    const reads: string[] = [];
    await new Discovery(store, f, { read(path, ...args) { reads.push(path); return readSource(path, ...args); } }).scan();
    assert.equal(reads.filter(path => path.startsWith(children)).length, 20);
    assert.ok(!reads.some(path => path.endsWith(".key") || path.endsWith("agent-link.jsonl")));
    assert.ok(store.diagnostics.some(message => message.code.endsWith(".limit")));
    assert.equal(store.workspace().sessions.length, 1);
});

test("R4 interruption markers abort the current turn without advancing the prompt anchor", () => {
    for (const marker of ["[Request interrupted by user]", "[Request interrupted by user for tool use]"]) {
        const observation = parse([prompt(0, "real instruction"), assistant(1, text("working")), prompt(2, marker)]);
        assert.equal(observation.turns.length, 1);
        assert.equal(observation.lastPromptAt, at(0));
        assert.equal(observation.title, "real instruction");
        assert.notEqual(observation.state, "working");
        assert.equal(observation.turns[0]!.endedAt, at(2));
        assert.equal(observation.turns[0]!.aborted, true);
        assert.deepEqual(observation.turns[0]!.errors, ["interrupted"]);
        assert.equal(observation.turns[0]!.lastAgentMessage, undefined);
        const continued = parse([prompt(0), prompt(2, marker), prompt(3, "new instruction")]);
        assert.equal(continued.turns.length, 2);
        assert.equal(continued.lastPromptAt, at(3));
        assert.equal(parse([prompt(2, marker)]).turns.length, 0);
    }
});

test("R5 a broken registry entry does not suppress unrelated transcript updates", async t => {
    const f = fixture(t), path = join(f.transcripts, "parent.jsonl");
    writeFileSync(join(f.sessions, "999.json"), '{"pid":999');
    writeFileSync(path, jsonl([prompt(0)]));
    const store = new Store(join(f.root, "state"), () => at(10)); t.after(() => store.close());
    const discovery = new Discovery(store, f);
    await discovery.scan();
    assert.equal(store.workspace().sessions.length, 1);
    assert.ok(store.diagnostics.length > 0);
    writeFileSync(path, jsonl([prompt(0), assistant(2, text("new result"), "end_turn")]));
    await discovery.scan();
    assert.equal(store.workspace().sessions[0]!.state, "waiting");
    assert.ok(store.workspace().sessions[0]!.references.some(ref => ref.excerpt === "new result"));
    const unreadable = new Discovery(store, f, { read(path, ...args) { if (path.endsWith("999.json")) throw new Error("synthetic unreadable registry"); return readSource(path, ...args); } });
    writeFileSync(path, jsonl([prompt(3, "next prompt")]));
    await unreadable.scan();
    assert.equal(store.workspace().sessions[0]!.state, "running");
});

test("R6 disappearing sessions are evicted from fallback retention and stop replaying", async t => {
    const f = fixture(t), path = join(f.transcripts, "parent.jsonl");
    writeFileSync(path, jsonl([prompt(0)]));
    const store = new Store(join(f.root, "state"), () => at(10)); t.after(() => store.close());
    let observations = 0;
    const original = store.observe.bind(store);
    store.observe = value => { observations++; return original(value); };
    const discovery = new Discovery(store, f);
    await discovery.scan();
    rmSync(path);
    await discovery.scan();
    assert.equal((Reflect.get(discovery, "claudeRegistryFallbacks") as Map<string, unknown>).size, 0);
    observations = 0;
    await discovery.scan();
    assert.equal(observations, 0);
    assert.equal(store.workspace().sessions.length, 1);
});

test("R6 live registry entries and fallback eviction share the 5000 observation budget", async t => {
    const f = fixture(t), old = join(f.transcripts, "old.jsonl");
    writeFileSync(old, jsonl([prompt(0, "previous batch", { sessionId: "old" })]));
    const store = new Store(join(f.root, "state"), () => at(10)); t.after(() => store.close());
    let count = 0, reads = 0;
    const original = store.observe.bind(store);
    // Count emission without creating 5000 irrelevant SQLite rows in this budget test.
    store.observe = value => { count++; return original({ ...value, nativeId: "budget-probe", version: "fixed" }); };
    const discovery = new Discovery(store, f, { isPidAlive: () => true, read(path, ...args) { reads++; return readSource(path, ...args); } });
    await discovery.scan();
    rmSync(old);
    for (let i = 0; i < 5001; i++) writeFileSync(join(f.transcripts, `${i}.jsonl`), jsonl([prompt(0, "current batch", { sessionId: `current-${i}` })]));
    writeFileSync(join(f.sessions, "801.json"), JSON.stringify({ pid: 801, sessionId: "registry-only", cwd: project, status: "busy", statusUpdatedAt: at(1) }));
    count = 0; reads = 0;
    await discovery.scan();
    assert.equal(count, 5000);
    assert.equal(reads, 10001); // 5000 bounded header/tail pairs plus one registry read.
    assert.ok(store.diagnostics.some(message => message.code.endsWith(".limit")));
    const retained = Reflect.get(discovery, "claudeRegistryFallbacks") as Map<string, unknown>;
    assert.equal(retained.size, 5000);
    assert.equal(retained.has("old"), false);
});

test("R2.1 shell continuations cannot expose any part of a credential", () => {
    const continuation = "\\\n";
    for (const command of [
        `API_KEY=${continuation}synthetic-secret command`,
        `TOKEN=synthetic-${continuation}continued-secret command`,
        `curl -H "Authorization: Bearer ${continuation}synthetic-header-secret"`,
        `curl -H "Authorization: Bea${continuation}rer synthetic-${continuation}header-secret"`,
        "password=\\\r\nsynthetic-crlf-secret command",
    ]) {
        const observation = parse([prompt(0), assistant(1, [tool("Bash", "b", { command })]), result(2, "b", { is_error: true })]);
        assert.doesNotMatch(redact(command), /synthetic|continued-secret|header-secret|crlf-secret/);
        assert.doesNotMatch(JSON.stringify(observation), /synthetic|continued-secret|header-secret|crlf-secret/);
    }
});

test("R2.2 terminal child records stay terminal through closing metadata", () => {
    const base = parse([prompt(0), assistant(1, text("parent done"), "end_turn")]);
    const activity = assistant(2, [tool("Bash", "b", { command: "work" })], "tool_use");
    for (const terminal of [assistant(3, text("child done"), "end_turn"), record("result", 3, { subtype: "success" })]) {
        const records = [activity, terminal, record("system", 4, { subtype: "turn_duration", durationMs: 1000 })];
        const folded = foldClaudeSubagents(base, [{ records, mtime: at(4) }]);
        assert.equal(folded.subagentRunning, false);
        assert.equal(withClaudeRegistry(folded, { nativeId: "parent", project, registry: { live: true, status: "idle", statusUpdatedAt: at(1) } }).state, "ended");
        assert.equal(parse([prompt(0), assistant(1, text("parent done"), "end_turn"), ...records.map(raw => ({ ...raw, isSidechain: true, agentId: "child" }))]).subagentRunning, false);
        assert.equal(foldClaudeSubagents(base, [{ records: [...records, assistant(5, text("new activity"))], mtime: at(5) }]).subagentRunning, true);
    }
});

test("R2.3 backward chunks recover a split prompt without stitching its reply to the header prompt", async t => {
    const f = fixture(t), path = join(f.transcripts, "parent.jsonl");
    const start = jsonl([prompt(0, "old prompt", { uuid: "old" }), prompt(1, "x".repeat(60000), { uuid: "missing" }), assistant(2, text("answer to missing prompt"), "end_turn", { uuid: "answer" })]);
    const filler = record("progress", 3, { content: "", uuid: "filler" });
    const body = start + jsonl([{ ...filler, content: "x".repeat(285657 - Buffer.byteLength(start + jsonl([filler]))) }]);
    assert.equal(Buffer.byteLength(body), 285657);
    writeFileSync(path, body);
    const store = new Store(join(f.root, "state"), () => at(10)); t.after(() => store.close());
    let observed: ClaudeObservation | undefined;
    const original = store.observe.bind(store);
    store.observe = value => { observed = value as ClaudeObservation; return original(value); };
    await new Discovery(store, f).scan();
    assert.equal(observed!.turns.length, 2);
    assert.equal(observed!.turns[0]!.endedAt, undefined);
    assert.equal(observed!.turns[0]!.lastAgentMessage, undefined);
    assert.equal(observed!.turns[1]!.promptAt, at(1));
    assert.equal(observed!.turns[1]!.lastAgentMessage, "answer to missing prompt");
});

test("R2.4 interrupted tool results preserve abort state and command correlation", () => {
    for (const fields of [{ is_error: true }, { interrupted: true }]) {
        const observation = parse([prompt(0), assistant(1, [tool("Bash", "b", { command: "interrupted command" })], "tool_use"), prompt(2, "[Request interrupted by user for tool use]"), result(3, "b", {}, { toolUseResult: fields })]);
        assert.equal(observation.state, "unknown");
        assert.equal(observation.turns.length, 1);
        assert.equal(observation.lastPromptAt, at(0));
        assert.equal(observation.turns[0]!.aborted, true);
        assert.equal(observation.turns[0]!.endedAt, at(2));
        assert.deepEqual(observation.turns[0]!.failedCommands, ["interrupted command"]);
    }
});

test("R2.5 child facts follow parent time windows and never cross a read gap", () => {
    const child = [assistant(2, [tool("Edit", "old-edit", { file_path: `${project}/first` }), tool("Bash", "old-bash", { command: "first failure" })]), result(3, "old-bash", { is_error: true }), assistant(6, [tool("Write", "new-edit", { file_path: `${project}/second` })])];
    const base = parse([prompt(0), assistant(1, text("first done"), "end_turn"), prompt(5), assistant(7, text("second done"), "end_turn")]);
    const folded = foldClaudeSubagents(base, [{ records: child, mtime: at(7) }]);
    assert.deepEqual(folded.turns[0]!.changedFiles, [`${project}/first`]);
    assert.deepEqual(folded.turns[0]!.failedCommands, ["first failure"]);
    assert.deepEqual(folded.turns[1]!.changedFiles, [`${project}/second`]);
    const gapped = parse([prompt(0), assistant(1, text("old done"), "end_turn"), { type: "aimspan_read_gap" }, assistant(4, text("unanchored activity"))]);
    const dropped = foldClaudeSubagents(gapped, [{ records: child, mtime: at(7) }]);
    assert.deepEqual(dropped.turns[0]!.changedFiles, []);
    assert.deepEqual(dropped.turns[0]!.failedCommands, []);
    const resumed = parse([prompt(0), assistant(1, text("old done"), "end_turn"), { type: "aimspan_read_gap" }, prompt(5), assistant(7, text("new done"), "end_turn")]);
    const split = foldClaudeSubagents(resumed, [{ records: child, mtime: at(7) }]);
    assert.deepEqual(split.turns[0]!.changedFiles, []);
    assert.deepEqual(split.turns[1]!.changedFiles, [`${project}/second`]);
});

test("R2.6 nested child API errors reach the matching parent turn redacted", async t => {
    const f = fixture(t), children = join(f.transcripts, "parent", "subagents");
    mkdirSync(children, { recursive: true });
    writeFileSync(join(f.transcripts, "parent.jsonl"), jsonl([prompt(0), assistant(1, text("first done"), "end_turn"), prompt(5)]));
    writeFileSync(join(children, "agent-child.jsonl"), jsonl([record("system", 2, { subtype: "api_error", error: { message: "api_key=synthetic-child-secret failure" } })]));
    const store = new Store(join(f.root, "state"), () => at(10)); t.after(() => store.close());
    let observed: ClaudeObservation | undefined;
    const original = store.observe.bind(store);
    store.observe = value => { observed = value as ClaudeObservation; return original(value); };
    await new Discovery(store, f).scan();
    assert.deepEqual(observed!.turns[0]!.errors, ["api_key=[redacted] failure"]);
    assert.deepEqual(observed!.turns[1]!.errors, []);
    assert.doesNotMatch(JSON.stringify(observed), /synthetic-child-secret/);
});

test("R2.7 ordinary Bearer and token prose survives credential redaction", () => {
    for (const prose of ["Bearer bonds are negotiable", "Bearer bonds are negotiable instruments.", "token: Identifier", "The lexer emits token: Identifier.", "Bearer responsibilities.", "Bearer abcdefghijklmnop", "ordinary\\\ncontinued prose"]) assert.equal(redact(prose), prose);
    for (const secret of ["Authorization: Bearer short", "token=short", "token: synthetic-secret", "Bearer abcdefghijklmn01", "Bearer synthetic-token-value"]) assert.ok(redact(secret).includes("[redacted]"), secret);
    const prose = "Bearer bonds are negotiable; token: Identifier";
    const observed = parse([prompt(0, prose), assistant(1, text(prose), "end_turn"), record("system", 2, { subtype: "away_summary", content: prose })]);
    assert.equal(observed.title, prose);
    assert.equal(observed.turns[0]!.lastAgentMessage, prose);
    assert.equal(observed.turns[0]!.awaySummary, prose);
});

test("R2.8 successful command results release the in-flight tracking budget", async t => {
    const f = fixture(t), records: unknown[] = [prompt(0)];
    for (let i = 0; i <= 1000; i++) {
        records.push({ type: "assistant", message: { content: [tool("Bash", `b${i}`, { command: i === 1000 ? "late failure" : "ok" })] } });
        records.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `b${i}`, is_error: i === 1000 }] } });
    }
    const body = jsonl(records);
    assert.ok(Buffer.byteLength(body) < 256 * 1024);
    writeFileSync(join(f.transcripts, "parent.jsonl"), body);
    const store = new Store(join(f.root, "state"), () => at(10)); t.after(() => store.close());
    let observed: ClaudeObservation | undefined;
    const original = store.observe.bind(store);
    store.observe = value => { observed = value as ClaudeObservation; return original(value); };
    await new Discovery(store, f).scan();
    assert.deepEqual(observed!.turns[0]!.failedCommands, ["late failure"]);
});

test("T20 Claude activity extracts first-line text, Bash results, latest edits and API errors", () => {
    const parsed = parse([prompt(0), assistant(1, [...text("首行 token=synthetic-secret\n第二行"), { type: "thinking", thinking: "private" }]),
        assistant(2, [tool("Bash", "good", { command: "pnpm test" }), tool("Edit", "edit", { file_path: `${project}/a.ts` })]),
        result(3, "good"), assistant(4, [tool("Bash", "bad", { command: "tool --token synthetic-secret" })]),
        result(5, "bad", {}, { toolUseResult: { interrupted: true } }),
        assistant(6, [tool("Write", "write", { file_path: `${project}/a.ts` })]), result(7, "write"),
        record("system", 8, { subtype: "api_error", error: { message: "password=synthetic-error" } }),
        prompt(9, "[Request interrupted by user]"),
    ]);
    assert.equal(parsed.activityIncomplete, false);
    assert.deepEqual(parsed.activity, [
        { at: at(9), kind: "error", text: "interrupted" },
        { at: at(8), kind: "error", text: "password=[redacted]" },
        { at: at(6), kind: "file", text: `${project}/a.ts`, failed: false },
        { at: at(4), kind: "command", text: "tool --token [redacted]", failed: true },
        { at: at(2), kind: "command", text: "pnpm test", failed: false },
        { at: at(1), kind: "message", text: "首行 token=[redacted]" },
    ]);
    const capped = parse([prompt(0), ...Array.from({ length: 25 }, (_, i) => assistant(i + 1, text(`${i}: ${"字".repeat(250)}`)))]);
    assert.equal(capped.activity.length, 20); assert.equal(capped.activity[0]!.at, at(25));
    assert.ok(capped.activity.every(entry => entry.text.length <= 200));
    const blocks = parse([prompt(0), assistant(1, [...text("first block\nsecond line"), { type: "thinking", thinking: "private" }, ...text("last block")])]);
    assert.deepEqual(blocks.activity.map(entry => entry.text), ["last block", "first block"]);
});

test("T20 Claude read gaps retain tail activity and prevent cross-gap command result correlation", () => {
    const parsed = parse([prompt(0), assistant(1, [tool("Bash", "before", { command: "before command" })]),
        { type: "aimspan_read_gap" }, result(3, "before", { is_error: true }), assistant(4, text("tail without prompt")),
        record("system", 5, { subtype: "api_error", error: "tail failure" }),
        assistant(6, [tool("Bash", "tail", { command: "tail command" })]), result(7, "tail", { is_error: true })]);
    assert.equal(parsed.activityIncomplete, true);
    assert.deepEqual(parsed.activity.find(entry => entry.text === "tail command"), { at: at(6), kind: "command", text: "tail command", failed: true });
    assert.equal(parsed.activity.find(entry => entry.text === "before command")!.failed, undefined);
    assert.equal(parsed.activity.some(entry => entry.text === "tail without prompt"), true);
    assert.equal(parsed.activity.some(entry => entry.text === "tail failure"), true);
    assert.deepEqual(parsed.turns[0]!.failedCommands, []);
    const skipped = parse(claudeRecords(jsonl([prompt(0)]) + "invalid\n" + jsonl([assistant(2, text("valid"), "end_turn")])));
    assert.equal(skipped.activityIncomplete, true);
    assert.equal(skipped.activity[0]!.text, "valid");
});

test("T20 Claude appended tool results update activity once through discovery, rescan and restart", async t => {
    const f = fixture(t), path = join(f.transcripts, "parent.jsonl");
    writeFileSync(path, jsonl([prompt(0), assistant(1, [tool("Bash", "command", { command: "pnpm test" })])]));
    let store = new Store(join(f.root, "activity-state"), () => at(100)); t.after(() => store.close());
    const discovery = new Discovery(store, f);
    await discovery.scan();
    const s = store.workspace().sessions[0]!;
    assert.deepEqual(s.activity, [{ at: at(1), kind: "command", text: "pnpm test" }]);
    appendFileSync(path, jsonl([result(2, "command", { is_error: true }), assistant(3, text("Finished"), "end_turn")]));
    await discovery.scan();
    const updated = store.requireSession(s.id);
    assert.equal(updated.activity.length, 2); assert.equal(updated.activity[1]!.failed, true);
    await discovery.scan();
    assert.equal(store.requireSession(s.id).revision, updated.revision);
    store.close(); store = new Store(join(f.root, "activity-state"), () => at(100));
    await new Discovery(store, f).scan();
    assert.deepEqual(store.requireSession(s.id).activity, updated.activity);
});

test("T23 Core diagnostics and source kinds contain stable codes while source text stays verbatim", async t => {
    const f = fixture(t);
    writeFileSync(join(f.sessions, "42.json"), "not valid JSON");
    const registry = await readClaudeRegistry(f.claude);
    assert.deepEqual(registry.diagnostics, [{ code: "claude.registry.uncertain" }]);
    for (const diagnostic of registry.diagnostics) assert.match(diagnostic.code, /^[a-z.]+$/);
    const observed = parse([prompt(0, "用户内容"), assistant(1, text("原生回复"), "end_turn")]);
    assert.deepEqual(observed.sources.map(source => source.kind), ["user", "agent"]);
    assert.deepEqual(observed.sources.map(source => source.excerpt), ["用户内容", "原生回复"]);
    assert.equal(observed.sources.some(source => "label" in source), false);
});
