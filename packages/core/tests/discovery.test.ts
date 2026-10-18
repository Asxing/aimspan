import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DiscoveryLoop } from "../src/discovery-loop.js";
import { Discovery } from "../src/adapters.js";
import { Store } from "../src/store.js";
import { readSource, readSourceBytes } from "../src/security.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 16, 8, 0, seconds)).toISOString();
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const jsonl = (records: unknown[]) => records.map(r => JSON.stringify(r)).join("\n") + "\n";

test("watch bursts debounce for 500 ms, reads serialize, errors reconcile at 60 s and shutdown closes handles", async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let callback: (filename?: string) => void = () => {}, fail: () => void = () => {}, closed = 0, publishes = 0;
    const reads: (string[] | undefined)[] = [];
    let finish: (() => void) | undefined;
    const loop = new DiscoveryLoop([{ path: "/__aimspan_fixture__/sessions", recursive: true }], async dirty => {
        reads.push(dirty ? [...dirty] : undefined);
        if (reads.length === 1) await new Promise<void>(resolve => { finish = resolve; });
    }, () => { publishes++; }, { watch(_path, recursive, changed) {
        assert.equal(recursive, true); callback = changed;
        return { close() { closed++; }, on(_event, listener) { fail = listener; } };
    } });
    loop.start(); callback("a.jsonl"); t.mock.timers.tick(250); callback("a.jsonl"); callback("b.jsonl");
    t.mock.timers.tick(499); assert.equal(reads.length, 0);
    t.mock.timers.tick(1); await settle();
    assert.deepEqual(reads[0], ["/__aimspan_fixture__/sessions/a.jsonl", "/__aimspan_fixture__/sessions/b.jsonl"]);
    callback("c.jsonl"); t.mock.timers.tick(500); assert.equal(reads.length, 1);
    finish!(); await settle();
    assert.deepEqual(reads[1], ["/__aimspan_fixture__/sessions/c.jsonl"]);
    fail(); assert.match(loop.diagnostics[0]!.code, /watch-fallback/);
    t.mock.timers.tick(60000); await settle();
    assert.equal(reads.at(-1), undefined); assert.ok(publishes > 0);
    await loop.stop(); assert.ok(closed >= 2);
    const count = reads.length; callback("d.jsonl"); t.mock.timers.tick(60000); await settle();
    assert.equal(reads.length, count);
});

test("unsupported recursive watchers fall back, while a failing pass can retry", async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let scans = 0;
    const loop = new DiscoveryLoop([{ path: "/__aimspan_fixture__/projects", recursive: true }], async () => { if (++scans === 1) throw new Error("synthetic read failure"); }, () => {}, { watch() { throw new Error("unsupported"); } });
    loop.start(); assert.match(loop.diagnostics[0]!.code, /watch-fallback/);
    t.mock.timers.tick(60000); await settle(); assert.equal(scans, 1);
    assert.ok(loop.diagnostics.some(d => d.code === "discovery.read"));
    t.mock.timers.tick(60000); await settle(); assert.equal(scans, 2);
    assert.equal(loop.diagnostics.some(d => d.code === "discovery.read"), false);
    await loop.stop();
});

test("continuous watch events flush coalesced dirty paths within two seconds of the first event", async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let changed: (filename?: string) => void = () => {};
    const passes: string[][] = [];
    const loop = new DiscoveryLoop([{ path: "/__aimspan_fixture__/sessions", recursive: true }], async dirty => {
        passes.push([...(dirty ?? [])]);
    }, () => {}, { watch(_path, _recursive, listener) { changed = listener; return { close() {}, on() {} }; } });
    t.after(() => loop.stop());
    loop.start();
    for (let batch = 0; batch < 3; batch++) {
        changed(`completion-${batch}.jsonl`);
        for (let event = 0; event < 9; event++) { t.mock.timers.tick(200); changed("busy.jsonl"); }
        t.mock.timers.tick(199); await settle(); assert.equal(passes.length, batch);
        t.mock.timers.tick(1); await settle(); assert.equal(passes.length, batch + 1);
        assert.deepEqual(passes[batch], [`/__aimspan_fixture__/sessions/completion-${batch}.jsonl`, "/__aimspan_fixture__/sessions/busy.jsonl"]);
    }
    t.mock.timers.tick(500); await settle(); assert.equal(passes.length, 3);
    changed("stopped.jsonl"); await loop.stop();
    t.mock.timers.tick(2000); await settle(); assert.equal(passes.length, 3);
});

test("max-wait events queue behind an in-flight scan without overlapping or leaving extra timers", async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let changed: (filename?: string) => void = () => {}, finish: () => void = () => {};
    const passes: string[][] = [];
    const loop = new DiscoveryLoop([{ path: "/__aimspan_fixture__/sessions", recursive: true }], async dirty => {
        passes.push([...(dirty ?? [])]);
        if (passes.length === 1) await new Promise<void>(resolve => { finish = resolve; });
    }, () => {}, { watch(_path, _recursive, listener) { changed = listener; return { close() {}, on() {} }; } });
    t.after(() => loop.stop());
    loop.start(); changed("initial.jsonl"); t.mock.timers.tick(500); await settle();
    changed("completion.jsonl");
    for (let event = 0; event < 10; event++) { changed("busy.jsonl"); t.mock.timers.tick(200); }
    await settle(); assert.equal(passes.length, 1);
    finish(); await settle();
    assert.deepEqual(passes[1], ["/__aimspan_fixture__/sessions/completion.jsonl", "/__aimspan_fixture__/sessions/busy.jsonl"]);
    t.mock.timers.tick(2000); await settle(); assert.equal(passes.length, 2);
    changed("quiet.jsonl"); t.mock.timers.tick(500); await settle(); assert.equal(passes.length, 3);
    t.mock.timers.tick(2000); await settle(); assert.equal(passes.length, 3);
});

test("dirty discovery reads only changed files, evicts removed caches, isolates failures and preserves data after restart", async t => {
    const root = mkdtempSync("/private/tmp/__aimspan_fixture__-discovery-");
    const claude = join(root, "claude"), codex = join(root, "codex"), projects = join(claude, "projects", "project"), registry = join(claude, "sessions"), sessions = join(codex, "sessions");
    for (const directory of [projects, registry, sessions]) mkdirSync(directory, { recursive: true });
    const index = join(codex, "session_index.jsonl"); writeFileSync(index, "");
    const cwd = "/Users/__aimspan_fixture__/project";
    const a = join(projects, "a.jsonl"), b = join(projects, "b.jsonl"), c = join(sessions, "c.jsonl"), d = join(sessions, "d.jsonl");
    const prompt = (id: string) => ({ type: "user", uuid: `${id}-prompt`, sessionId: id, cwd, timestamp: at(0), message: { content: "任务" } });
    for (const [id, path] of [["a", a], ["b", b]]) writeFileSync(path!, jsonl([prompt(id!)]));
    for (const [id, path] of [["c", c], ["d", d]]) writeFileSync(path!, jsonl([{ type: "session_meta", payload: { id, cwd } }, { type: "event_msg", timestamp: at(0), payload: { type: "task_started", turn_id: "t" } }]));
    const live = join(registry, "101.json"); writeFileSync(live, JSON.stringify({ pid: 101, sessionId: "a", cwd, status: "busy" }));
    const reads: string[] = []; let unreadable = "";
    let store = new Store(join(root, "state"), () => at(20));
    t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
    const source = () => new Discovery(store, { claude, codex }, { isPidAlive: () => true, read(path, ...args) { reads.push(path); if (path === unreadable) throw new Error("synthetic denial"); return readSource(path, ...args); } }, { now: () => Date.parse(at(20)), read(path, ...args) { reads.push(path); if (path === unreadable) throw new Error("synthetic denial"); return readSourceBytes(path, ...args); } });
    let discovery = source(); await discovery.scan(); assert.equal(store.workspace().sessions.length, 4);
    reads.length = 0;
    appendFileSync(a, jsonl([{ type: "assistant", uuid: "end", timestamp: at(10), message: { content: "完成", stop_reason: "end_turn" } }]));
    await discovery.scan(new Set([a])); assert.deepEqual([...new Set(reads)], [a]);
    reads.length = 0;
    writeFileSync(index, jsonl([{ id: "c", thread_name: "新标题" }]));
    await discovery.scan(new Set([index])); assert.deepEqual(reads, [index]);
    assert.equal(store.workspace().sessions.find(s => s.nativeId === "c")!.title, "新标题");
    const bSession = store.workspace().sessions.find(s => s.nativeId === "b")!;
    store.call({ method: "idea.save", sessionId: bSession.id, body: "保留想法", operationId: "memo", expectedRevision: 0 });
    unreadable = b; appendFileSync(b, "\n");
    await discovery.scan(new Set([b]));
    assert.equal(store.requireSession(bSession.id).state, "unknown");
    assert.ok(store.diagnostics.length > 0);
    await discovery.scan(new Set([a])); assert.equal(store.requireSession(bSession.id).state, "unknown");
    assert.ok(store.diagnostics.length > 0);
    rmSync(a); rmSync(b); rmSync(c); rmSync(d); rmSync(live);
    await discovery.scan();
    assert.equal(store.workspace().sessions.length, 4); assert.equal(store.workspace().ideas[0]!.body, "保留想法");
    // Recreating a path with fresh content must read it after eviction.
    reads.length = 0; writeFileSync(c, jsonl([{ type: "session_meta", payload: { id: "e", cwd } }, { type: "event_msg", timestamp: at(12), payload: { type: "task_started", turn_id: "e" } }]));
    await discovery.scan(new Set([c])); assert.ok(reads.includes(c));
    store.close(); store = new Store(join(root, "state"), () => at(20)); discovery = source(); await discovery.scan();
    assert.equal(store.workspace().sessions.find(s => s.nativeId === "a")!.state, "unknown");
    assert.equal(store.workspace().ideas.length, 1);
    assert.ok(store.turns(bSession.id).length > 0);
});

test("a scan that reports backlog reruns about 100 ms later until the backlog is gone, without file events", async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let callback: (filename?: string) => void = () => {};
    let scans = 0;
    const loop: DiscoveryLoop = new DiscoveryLoop([{ path: "/__aimspan_fixture__/sessions", recursive: true }], async () => {
        scans++;
        if (scans < 3) loop.requestRerun();
    }, () => {}, { watch(_path, _recursive, changed) { callback = changed; return { close() {}, on() {} }; } });
    loop.start(); callback("big.jsonl"); t.mock.timers.tick(500); await settle();
    assert.equal(scans, 1);
    t.mock.timers.tick(100); await settle();
    assert.equal(scans, 2);
    t.mock.timers.tick(100); await settle();
    assert.equal(scans, 3);
    t.mock.timers.tick(1000); await settle();
    assert.equal(scans, 3, "no rerun once backlog is cleared");
    await loop.stop();
});

test("a rerun requested while idle (e.g. backlog left by the initial scan) is scheduled without waiting for file events", async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let scans = 0;
    const loop = new DiscoveryLoop([{ path: "/__aimspan_fixture__/sessions", recursive: true }], async () => { scans++; }, () => {},
        { watch() { return { close() {}, on() {} }; } });
    loop.start(); loop.requestRerun();
    t.mock.timers.tick(99); await settle(); assert.equal(scans, 0);
    t.mock.timers.tick(1); await settle(); assert.equal(scans, 1);
    await loop.stop();
});
