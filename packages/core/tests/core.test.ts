import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import { parseRecords } from "../src/adapters.js";
import { readSource } from "../src/security.js";
import { DEFAULT_SETTINGS, validRequest } from "@aimspan/protocol";
import type { Idea } from "@aimspan/protocol";
const dir = () => mkdtempSync("/private/tmp/__aimspan_fixture__-");
const observation = (state: "working" | "waiting" | "ended" = "waiting", version = "v1") => ({ agent: "codex" as const, nativeId: "native-a", title: "任务 A", project: "/__aimspan_fixture__/project", state, at: "2026-10-12T10:00:00.000Z", confidence: "explicit" as const, sources: [{ id: "s1", kind: "agent" as const, time: "2026-10-12T10:00:00.000Z", excerpt: "Should we keep A?" }], version, eventId: version, lastPromptAt: "2026-10-12T09:59:00.000Z", turns: [{ promptAt: "2026-10-12T09:59:00.000Z", ...(state === "working" ? {} : { endedAt: "2026-10-12T10:00:00.000Z" }), errors: [], changedFiles: [], failedCommands: [] }] });
test("existing legacy schema and rows survive opening, projection, idea edits and restart", () => {
    const root = dir();
    const db = new DatabaseSync(join(root, "companion.sqlite3"));
    db.exec(readFileSync(new URL("../../tests/fixtures/legacy-state.sql", import.meta.url), "utf8"));
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const snapshot = new Map(tables.map(row => {
        const name = String(row.name);
        return [name, db.prepare(`SELECT * FROM "${name}"`).all()];
    }));
    db.close();
    let store = new Store(root, () => "2026-10-15T10:00:00Z");
    try {
        // Preserve the legacy notification preference while filling new panel defaults.
        assert.deepEqual(store.workspace().settings, { ...DEFAULT_SETTINGS, language: "zh", notifications: true, notificationsExplicit: true });
        assert.deepEqual(Object.keys(store.workspace()).sort(), ["sessions", "ideas", "inboxIdeaCount", "drafts", "settings", "seq", "deviceId", "diagnostics", "legacyImport"].sort());
        assert.deepEqual(store.workspace().sessions, []);
        const session = store.observe(observation("working"));
        const memo = store.call({ method: "idea.save", sessionId: session.id, body: "原样保存\n下一步", expectedRevision: 0, operationId: "create" }) as Idea;
        const edited = store.call({ method: "idea.save", id: memo.id, sessionId: session.id, body: "编辑后原文\n第二行", expectedRevision: memo.revision, operationId: "edit" }) as Idea;
        assert.equal(edited.body, "编辑后原文\n第二行");
        store.call({ method: "idea.setStatus", status: "discarded", id: memo.id, expectedRevision: edited.revision, operationId: "delete" });
        store.call({ method: "settings.save", settings: store.settings() });
        store.close();
        store = new Store(root);
        assert.equal(store.workspace().ideas[0]!.body, edited.body);
        assert.equal(store.workspace().ideas[0]!.status, "discarded");
        assert.equal(store.workspace().sessions[0]!.pendingIdeaCount, 0);
        const currentSchema = store.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
        assert.deepEqual(currentSchema.filter(row => schema.some(old => old.name === row.name)), schema);
        assert.deepEqual(store.db.prepare("SELECT version FROM schema_migrations").all().map(r => r.version), [1, 2, 3, 4]);
        for (const [name, rows] of snapshot) {
            const current = store.db.prepare(`SELECT * FROM "${name}"`).all();
            for (const row of rows) {
                if (name === "metadata" && row.key === "settings") {
                    // Saving the projected settings adds panel defaults without losing old fields.
                    const saved = JSON.parse(String(current.find(value => value.key === "settings")!.json)) as Record<string, unknown>;
                    for (const [key, value] of Object.entries(JSON.parse(String(row.json)) as Record<string, unknown>)) assert.deepEqual(saved[key], value);
                } else assert.ok(current.some(value => JSON.stringify(value) === JSON.stringify(row)), `${name} lost or changed an existing row`);
            }
        }
    } finally {
        store.close();
        rmSync(root, { recursive: true });
    }
});

test("session identity, archive, drafts and local notes persist without changing source state", () => {
    const root = dir();
    let store = new Store(root, () => "2026-10-12T10:01:00Z");
    try {
        const session = store.observe(observation("working"));
        const other = store.observe({ ...observation("working"), nativeId: "native-b" });
        assert.notEqual(session.id, other.id);
        const memo = store.call({ method: "idea.save", sessionId: session.id, body: "  下一步\n检查键盘  ", expectedRevision: 0, operationId: "memo" });
        assert.deepEqual(store.requireSession(session.id), session);
        store.call({ method: "draft.save", expectedRevision: 0, operationId: "draft", target: session.id, body: "未完成草稿" });
        const archive = { method: "session.archive" as const, sessionId: session.id, archived: true, operationId: "archive" };
        assert.deepEqual(store.call(archive), store.call(archive));
        store.close();
        store = new Store(root, () => "2026-10-12T10:02:00Z");
        assert.deepEqual(store.workspace().ideas, [memo]);
        assert.equal(store.workspace().drafts[session.id]?.body, "未完成草稿");
        assert.equal(store.requireSession(session.id).archived, true);
        assert.equal(store.requireSession(session.id).state, "running");
    } finally {
        store.close();
        rmSync(root, { recursive: true });
    }
});

test("protocol accepts the reduced local settings and rejects unsupported operations", () => {
    assert.equal(validRequest({ method: "settings.save", settings: DEFAULT_SETTINGS }), true);
    assert.equal(validRequest({ method: "settings.save", settings: { ...DEFAULT_SETTINGS, roots: [1] } }), false);
    assert.equal(validRequest({ method: "unknown", sessionId: "a", operationId: "op", expectedRevision: 1 }), false);
});
test("error completion and reordered records never create successful result; parent recognized", () => { const at = "2026-10-12T10:00:00Z"; const data = [{ type: "session_meta", payload: { id: "c", cwd: "/__aimspan_fixture__/project", source: { subagent: { thread_spawn: { parent_thread_id: "p" } } } } }, { type: "event_msg", timestamp: at, payload: { type: "task_complete", error: { message: "limit" } } }, { type: "event_msg", timestamp: "2026-10-11T09:00:00Z", payload: { type: "task_started" } }]; const o = parseRecords("codex", data, { nativeId: "fallback", mtime: at }); assert.equal(o.state, "failed"); assert.equal(o.parentNativeId, "p"); assert.equal(parseRecords("claude-code", [{ type: "assistant", timestamp: at, sessionId: "a", cwd: "/__aimspan_fixture__/project", message: { role: "assistant", content: [{ type: "text", text: "Done" }], stop_reason: "end_turn" } }], { nativeId: "f", mtime: at }).state, "ended"); });
test("bounded source reads refuse symlinks", () => { const root = dir(), file = join(root, "a.jsonl"), link = join(root, "link.jsonl"); writeFileSync(file, "x".repeat(10000)); symlinkSync(file, link); assert.throws(() => readSource(link), /Symlink/); assert.equal(readSource(file, 100).body.length, 100); rmSync(root, { recursive: true }); });
test("Claude sidechain identity stays with its parent session",()=>{
    const at="2026-10-14T08:00:00Z";
    const child=parseRecords("claude-code",[{type:"user",sessionId:"parent",agentId:"child",isSidechain:true,cwd:"/project",timestamp:at,message:{role:"user",content:"Review the change"}}],{nativeId:"fallback",mtime:at});
    assert.equal(child.nativeId,"parent");assert.equal(child.parentNativeId,undefined);assert.equal(child.subagentRunning,true);
});

test("T23 source references expose kinds while legacy stored labels and text remain untouched", () => {
    const root = dir();
    const store = new Store(root);
    try {
        const session = store.observe(observation())!;
        const stored = store.get<import("@aimspan/protocol").Session>("session", session.id)!;
        const legacy = { ...stored, references: [{ id: "native-user", label: "用户消息", time: stored.observedAt, excerpt: "  原文😀  " }] };
        store.db.prepare("UPDATE records SET json=? WHERE kind='session' AND id=?").run(JSON.stringify(legacy), session.id);
        expectReference();
        assert.deepEqual(store.get("session", session.id), legacy);
        assert.throws(() => store.requireSession("missing"), { message: "core.errorSessionNoLongerExists" });
        function expectReference() {
            for (const projected of [store.workspace().sessions[0]!, store.requireSession(session.id)]) {
                assert.deepEqual(projected.references, [{ id: "native-user", kind: "user", time: stored.observedAt, excerpt: "  原文😀  " }]);
            }
        }
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
