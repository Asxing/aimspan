import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { Discovery } from "../src/adapters.js";
import { parseClaudeRecords, readClaudeRegistry, withClaudeRegistry } from "../src/claude.js";
import { CLAUDE_CHUNK_BYTES, CLAUDE_READ_BUDGET, readClaudeTranscript } from "../src/claude-transcript.js";
import { readSource, readSourceBytes } from "../src/security.js";
import { CodexSource } from "../src/codex.js";
import { Store } from "../src/store.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 15, 8, 0, seconds)).toISOString();
const cwd = "/Users/__aimspan_fixture__/project";
const prompt = (seconds: number, body: string, extra = {}) => ({ type: "user", sessionId: "parent", cwd, timestamp: at(seconds), uuid: `prompt-${seconds}`, message: { content: body }, ...extra });
const end = (seconds: number, body: string) => ({ type: "assistant", sessionId: "parent", cwd, timestamp: at(seconds), uuid: `end-${seconds}`, message: { content: [{ type: "text", text: body }], stop_reason: "end_turn" } });
const jsonl = (records: unknown[]) => records.map(record => JSON.stringify(record)).join("\n") + "\n";
function fixture(t: TestContext, now = 86460) {
    const root = mkdtempSync("/private/tmp/__aimspan_fixture__-t7-");
    const claude = join(root, "claude"), codex = join(root, "codex"), transcripts = join(claude, "projects", "synthetic"), registry = join(claude, "sessions");
    for (const path of [transcripts, registry, join(codex, "sessions"), join(codex, "archived_sessions")]) mkdirSync(path, { recursive: true });
    let store = new Store(join(root, "state"), () => at(now));
    t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
    return { root, claude, codex, transcripts, registry, get store() { return store; }, reopen() { store.close(); store = new Store(join(root, "state"), () => at(now)); } };
}
function toolRecords(count: number, seconds: number) {
    return Array.from({ length: count }, (_, i) => ({ type: "user", timestamp: at(seconds), sessionId: "parent", uuid: `tool-${seconds}-${i}`,
        message: { content: [{ type: "tool_result", tool_use_id: `t-${i}`, content: "中".repeat(6500) }] }, toolUseResult: { stdout: "synthetic" } }));
}

test("T7 F2 backward chunks recover a current Claude prompt and previous reply beyond both windows", async t => {
    const f = fixture(t);
    const records = [prompt(0, "昨天的任务"), ...toolRecords(120, 1), prompt(86400, "上一轮"), end(86420, "上一轮的完整回复😀"), prompt(86430, "当前任务"), ...toolRecords(120, 86440),
        { type: "last-prompt", lastPrompt: "当前任务的标题", leafUuid: "leaf", sessionId: "parent" }];
    const body = jsonl(records);
    assert.ok(Buffer.byteLength(body) > 4.5 * 1024 * 1024);
    const path = join(f.transcripts, "parent.jsonl");
    writeFileSync(path, body); utimesSync(path, new Date(at(86440)), new Date(at(86440)));
    const reads: number[] = [];
    const discovery = new Discovery(f.store, f, {
        read(path, limit, tail) { const result = readSource(path, limit, tail); reads.push(Math.min(result.size, limit!)); return result; },
        readBytes(path, limit, tail, offset) { const result = readSourceBytes(path, limit, tail, offset); reads.push(result.body.length); return result; },
    });
    await discovery.scan();
    const session = f.store.workspace().sessions[0]!;
    assert.equal(session.lastPromptAt, at(86430));
    assert.equal(session.title, "当前任务的标题");
    assert.equal(session.state, "running");
    const card = f.store.catchup(session.id);
    assert.equal(card.durationMsOfCurrentOrLastTurn, 30000);
    assert.equal(card.lastAgentMessage?.body, "上一轮的完整回复😀");
    assert.equal(card.lastAgentMessage.fromBeforeAnchor, true);
    assert.ok(reads.length > 3);
    assert.ok(reads.every(length => length <= CLAUDE_CHUNK_BYTES));
    assert.ok(reads.reduce((sum, length) => sum + length, 0) <= CLAUDE_READ_BUDGET);
    const count = reads.length;
    await discovery.scan();
    assert.equal(reads.length, count);
    assert.equal(f.store.workspace().sessions[0]!.revision, session.revision);
    f.reopen();
    assert.equal(f.store.catchup(session.id).lastAgentMessage?.body, "上一轮的完整回复😀");
});

test("T7 F3 busy registry epoch milliseconds advance running-since and catch-up duration", async t => {
    const f = fixture(t);
    writeFileSync(join(f.transcripts, "parent.jsonl"), jsonl([prompt(0, "旧任务"), end(10, "旧回复")]));
    writeFileSync(join(f.registry, "101.json"), JSON.stringify({ pid: 101, sessionId: "parent", cwd, status: "busy", statusUpdatedAt: Date.parse(at(86440)) }));
    await new Discovery(f.store, f, { isPidAlive: () => true }).scan();
    const session = f.store.workspace().sessions[0]!;
    assert.equal(session.registry?.statusUpdatedAt, at(86440));
    assert.equal(session.lastPromptAt, at(86440));
    assert.equal(session.state, "running");
    assert.equal(f.store.catchup(session.id).durationMsOfCurrentOrLastTurn, 20000);
    assert.equal(f.store.catchup(session.id).lastAgentMessage?.body, "旧回复");
});

test("T7 F4 timestamp-free last-prompt supplies only a fallback title", () => {
    const last = { type: "last-prompt", sessionId: "parent", lastPrompt: "最近指令 token=synthetic-secret", leafUuid: "leaf" };
    const records = [prompt(0, "最初的标题"), end(10, "完成"), last];
    const parse = (values: unknown[]) => parseClaudeRecords(values, { nativeId: "parent", mtime: at(1000) });
    const value = parse(records);
    assert.equal(value.title, "最近指令 token=[redacted]");
    assert.equal(value.lastPromptAt, at(0)); assert.equal(value.at, at(10)); assert.equal(value.state, "ended");
    assert.equal(value.turns.length, 1);
    assert.equal(parse([...records, { type: "ai-title", aiTitle: "AI 标题" }, last]).title, "AI 标题");
    assert.equal(parse([{ type: "custom-title", customTitle: "自定义标题" }, ...records, { type: "ai-title", aiTitle: "AI 标题" }]).title, "自定义标题");
    assert.equal(parse([last]).lastPromptAt, undefined);
});

test("T7 F6 archived Codex plain and zstd files never emit stale diagnostics, including cached scans", async t => {
    const f = fixture(t);
    const paths = [join(f.codex, "archived_sessions", "archived.jsonl"), join(f.codex, "archived_sessions", "archived.jsonl.zst"), join(f.codex, "sessions", "active.jsonl")];
    for (const [index, path] of paths.entries()) {
        const body = jsonl([{ type: "session_meta", payload: { id: `session-${index}`, cwd, originator: "codex_cli_rs" } }, { type: "event_msg", timestamp: at(0), payload: { type: "task_started", turn_id: "open" } }]);
        writeFileSync(path, path.endsWith(".zst") ? zstdCompressSync(Buffer.from(body)) : body);
        utimesSync(path, new Date(at(0)), new Date(at(0)));
    }
    const source = new CodexSource(f.codex, { now: () => Date.parse(at(86400)) });
    for (let pass = 0; pass < 2; pass++) {
        const result = await source.scan();
        assert.deepEqual(result.diagnostics.filter(d => d.code === "codex-stale"), [{ code: "codex-stale", path: paths[2] }]);
        assert.equal(result.sessions.filter(s => s.observation.archived).length, 2);
    }
});

function exactToolBytes(length: number): string {
    const empty = jsonl([{ type: "user", message: { content: [{ type: "tool_result", content: "" }] } }]);
    let body = "";
    while (length >= empty.length) {
        const size = Math.min(100000, length);
        body += empty.replace('"content":""', `"content":"${"x".repeat(size - empty.length)}"`);
        length -= size;
    }
    return body + "\n".repeat(length);
}

test("T7 F2 chunk boundaries join a prompt split inside a UTF-8 character without losing its previous completion", t => {
    const f = fixture(t), path = join(f.transcripts, "parent.jsonl");
    const current = jsonl([prompt(86430, "当前😀任务")]);
    const split = Buffer.from(current).indexOf(Buffer.from("😀")) + 2;
    const suffix = exactToolBytes(2 * CLAUDE_CHUNK_BYTES - (Buffer.byteLength(current) - split));
    const previous = jsonl([end(86420, "上一轮 token=synthetic-secret")]);
    const prefix = jsonl([prompt(0, "旧标题"), ...toolRecords(30, 1)]);
    const body = prefix + previous + current + suffix;
    const boundary = Buffer.byteLength(body) - 2 * CLAUDE_CHUNK_BYTES;
    assert.equal(boundary, Buffer.byteLength(prefix + previous) + split);
    writeFileSync(path, body);
    const source = readClaudeTranscript(path);
    const parsed = parseClaudeRecords(source.records, { nativeId: "parent", mtime: at(86460) });
    assert.equal(parsed.lastPromptAt, at(86430));
    assert.ok(parsed.sources.some(record => record.excerpt === "当前😀任务"));
    assert.equal(parsed.previousCompletion?.lastAgentMessage, "上一轮 token=[redacted]");
    const session = f.store.observe(parsed);
    assert.equal(f.store.catchup(session.id).lastAgentMessage?.body, "上一轮 token=[redacted]");
    // A reply without its own prompt never completes the unrelated header turn.
    assert.equal(f.store.turns(session.id)[0]!.endedAt, undefined);
    assert.equal(f.store.catchup(session.id).turnsSinceAnchor, 0);
});

test("T7 F2 backwards reads stop at the 8 MiB budget and preserve a read gap for an oversized line", async t => {
    const f = fixture(t), path = join(f.transcripts, "parent.jsonl");
    writeFileSync(path, jsonl([prompt(0, "已知旧指令"), { type: "assistant", message: { content: "x".repeat(CLAUDE_READ_BUDGET + 1000000) } }]));
    let consumed = 0, chunks = 0;
    const source = readClaudeTranscript(path, {
        read(path, limit, tail) { const result = readSource(path, limit, tail); consumed += Math.min(result.size, limit!); return result; },
        readBytes(path, limit, tail, offset) { assert.ok(limit! <= CLAUDE_CHUNK_BYTES); chunks++; const result = readSourceBytes(path, limit, tail, offset); consumed += result.body.length; return result; },
    });
    assert.equal(consumed, CLAUDE_READ_BUDGET); assert.ok(chunks > 1);
    const parsed = parseClaudeRecords(source.records, { nativeId: "parent", mtime: at(86460) });
    assert.equal(parsed.state, "unknown");
    assert.equal(parsed.turns[0]!.endedAt, undefined);
    assert.ok(parsed.turns[0]!.factsThrough);
    assert.ok(JSON.stringify(source.records).length < 50000);
});

for (const field of ["identity", "size", "mtime"] as const) {
    test(`T7 F2 changed ${field} between backward chunks keeps saved ideas and reports uncertainty`, async t => {
        const f = fixture(t), path = join(f.transcripts, "parent.jsonl");
        writeFileSync(path, jsonl([prompt(0, "保存过的指令")]));
        await new Discovery(f.store, f).scan();
        const original = f.store.workspace().sessions[0]!;
        f.store.call({ method: "idea.save", sessionId: original.id, body: "保留原文", expectedRevision: 0, operationId: "idea" });
        writeFileSync(path, jsonl([prompt(0, "保存过的指令"), end(1, "完成"), prompt(86430, "当前任务"), ...toolRecords(120, 86440)]));
        let chunks = 0;
        await new Discovery(f.store, f, { readBytes(path, limit, tail, offset) {
            const source = readSourceBytes(path, limit, tail, offset);
            if (++chunks !== 2) return source;
            return field === "identity" ? { ...source, identity: "replaced" } : { ...source, [field]: source[field] + 1 };
        } }).scan();
        assert.equal(chunks, 2);
        assert.equal(f.store.workspace().ideas[0]!.body, "保留原文");
        assert.equal(f.store.requireSession(original.id).state, "unknown");
        assert.ok(f.store.diagnostics.length);
    });
}

test("T7 F3 registry timestamps normalize ms, seconds and ISO while preserving newer prompts and idle timestamps", async t => {
    const f = fixture(t);
    for (const [index, value] of [Date.parse(at(86440)), Date.parse(at(86440)) / 1000, String(Date.parse(at(86440))), at(86440)].entries()) {
        const pid = index + 100;
        writeFileSync(join(f.registry, `${pid}.json`), JSON.stringify({ pid, sessionId: `session-${pid}`, cwd, status: "busy", statusUpdatedAt: value }));
    }
    const registry = await readClaudeRegistry(f.claude, { isPidAlive: () => true });
    assert.equal(registry.sessions.size, 4);
    for (const live of registry.sessions.values()) {
        assert.equal(live.registry.statusUpdatedAt, at(86440));
        const recent = parseClaudeRecords([prompt(86450, "更新的真实指令")], { nativeId: live.nativeId, mtime: at(86450) });
        assert.equal(withClaudeRegistry(recent, live).lastPromptAt, at(86450));
        const old = parseClaudeRecords([prompt(0, "旧指令")], { nativeId: live.nativeId, mtime: at(0) });
        assert.equal(withClaudeRegistry(old, { ...live, registry: { ...live.registry, status: "idle" } }).lastPromptAt, at(0));
    }
});

test("T7 F2 range reads retain symlink, hardlink and offset guards", t => {
    const f = fixture(t), path = join(f.transcripts, "source.jsonl");
    writeFileSync(path, "0123456789");
    assert.equal(readSourceBytes(path, 3, false, 4).body.toString(), "456");
    assert.throws(() => readSourceBytes(path, 3, false, -1), /core\.errorInvalidSourceOffset/);
    assert.throws(() => readSourceBytes(path, 3, true, 1), /core\.errorInvalidSourceOffset/);
    const symlink = join(f.transcripts, "symlink.jsonl"), hardlink = join(f.transcripts, "hardlink.jsonl");
    symlinkSync(path, symlink);
    assert.throws(() => readSourceBytes(symlink, 3, false, 4), /Symlink/);
    linkSync(path, hardlink);
    assert.throws(() => readSourceBytes(hardlink, 3, false, 4), /core\.errorUnsupportedSource/);
});

for (const type of ["custom-title", "ai-title"] as const) {
    test(`T7 R1 retains the latest ${type} before a completed prompt in an already-read chunk`, async t => {
        const f = fixture(t), path = join(f.transcripts, "parent.jsonl");
        const title = (value: string) => ({ type, sessionId: "parent", ...(type === "custom-title" ? { customTitle: value } : { aiTitle: value }) });
        writeFileSync(path, jsonl([prompt(0, "初始指令"), title("旧标题"), ...toolRecords(30, 1),
            title("较早的重命名"), title("最新标题😀"), prompt(86430, "当前任务"), end(86440, "当前回复")]));
        let chunks = 0;
        await new Discovery(f.store, f, { readBytes(...args) { chunks++; return readSourceBytes(...args); } }).scan();
        const session = f.store.workspace().sessions[0]!;
        assert.equal(session.title, "最新标题😀");
        assert.equal(session.lastPromptAt, at(86430));
        assert.equal(f.store.catchup(session.id).lastAgentMessage?.body, "当前回复");
        assert.ok(chunks >= 1);
    });
}

test("T7 R1 title search continues past the lifecycle stop across chunks and prefers custom over later AI titles", async t => {
    const f = fixture(t), path = join(f.transcripts, "parent.jsonl");
    writeFileSync(path, jsonl([prompt(0, "初始指令"), { type: "custom-title", customTitle: "旧的自定义标题" }, ...toolRecords(30, 1),
        { type: "custom-title", customTitle: "最近自定义标题" }, ...toolRecords(30, 2),
        { type: "ai-title", aiTitle: "更晚的 AI 标题" }, prompt(86430, "当前任务"), end(86440, "当前回复")]));
    let chunks = 0, total = 0;
    await new Discovery(f.store, f, {
        read(path, limit, tail) { const result = readSource(path, limit, tail); total += Math.min(result.size, limit!); return result; },
        readBytes(...args) { chunks++; const result = readSourceBytes(...args); total += result.body.length; return result; },
    }).scan();
    const session = f.store.workspace().sessions[0]!;
    assert.equal(session.title, "最近自定义标题");
    assert.ok(chunks > 1);
    assert.ok(total <= CLAUDE_READ_BUDGET);
    assert.equal(session.lastPromptAt, at(86430));
    assert.equal(f.store.turns(session.id).at(-1)!.endedAt, at(86440));
});

test("T7 R1 title search rejoins UTF-8 titles across a chunk boundary after the lifecycle stop", t => {
    const f = fixture(t), path = join(f.transcripts, "parent.jsonl");
    const rename = jsonl([{ type: "custom-title", customTitle: "跨块😀标题 token=synthetic-secret" }]);
    const split = Buffer.from(rename).indexOf(Buffer.from("😀")) + 2;
    const completed = jsonl([prompt(86430, "当前任务"), end(86440, "当前回复")]);
    const suffix = exactToolBytes(CLAUDE_CHUNK_BYTES - (Buffer.byteLength(rename) - split) - Buffer.byteLength(completed)) + completed;
    writeFileSync(path, jsonl([prompt(0, "旧指令"), { type: "custom-title", customTitle: "旧标题" }, ...toolRecords(30, 1)]) + rename + suffix);
    const parsed = parseClaudeRecords(readClaudeTranscript(path).records, { nativeId: "parent", mtime: at(86460) });
    assert.equal(parsed.title, "跨块😀标题 token=[redacted]");
    assert.equal(parsed.lastPromptAt, at(86430));
    assert.equal(parsed.turns.at(-1)!.lastAgentMessage, "当前回复");
});

test("T7 R1 title-only continuation without a custom title respects the total read cap and cache", async t => {
    const f = fixture(t), path = join(f.transcripts, "parent.jsonl");
    writeFileSync(path, jsonl([prompt(0, "最初指令"), { type: "ai-title", aiTitle: "旧 AI 标题" }]) + exactToolBytes(CLAUDE_READ_BUDGET + CLAUDE_CHUNK_BYTES)
        + jsonl([{ type: "ai-title", aiTitle: "最近 AI 标题" }, prompt(86430, "当前任务"), end(86440, "当前回复")]));
    let total = 0, chunks = 0;
    const discovery = new Discovery(f.store, f, {
        read(path, limit, tail) { const result = readSource(path, limit, tail); total += Math.min(result.size, limit!); return result; },
        readBytes(path, limit, tail, offset) { assert.ok(limit! <= CLAUDE_CHUNK_BYTES); chunks++; const result = readSourceBytes(path, limit, tail, offset); total += result.body.length; return result; },
    });
    await discovery.scan();
    assert.equal(total, CLAUDE_READ_BUDGET);
    assert.ok(chunks > 1);
    const session = f.store.workspace().sessions[0]!;
    assert.equal(session.title, "最近 AI 标题");
    assert.equal(session.lastPromptAt, at(86430));
    assert.equal(f.store.catchup(session.id).lastAgentMessage?.body, "当前回复");
    assert.equal(f.store.turns(session.id).length, 2);
    const count = chunks;
    await discovery.scan();
    assert.equal(chunks, count);
});
