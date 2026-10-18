import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CAPTURE_DRAFT_KEY, captureDraftKey, validRequest, validRendererRequest, type CoreRequest, type Idea, type Draft } from "@aimspan/protocol";
import { Store } from "../src/store.js";

const at = "2026-10-16T08:00:00.000Z";
function fixture(t: TestContext) {
    const directory = mkdtempSync("/private/tmp/__aimspan_fixture__-ideas-");
    let store = new Store(directory, () => at);
    t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    return { directory, get store() { return store; }, reopen() { store.close(); store = new Store(directory, () => at); } };
}
function session(store: Store, nativeId = "native-a") {
    return store.observe({ agent: "codex", nativeId, title: "相同标题", project: "/__aimspan_fixture__/project", state: "unknown", at, confidence: "unknown", sources: [], version: "v1" });
}
function save(store: Store, body = "  token=user-authored\n中文😀  ", sessionId: string | null = null, operationId = "create") {
    return store.call({ method: "idea.save", sessionId, body, expectedRevision: 0, operationId }) as Idea;
}
function replay<T>(store: Store, request: CoreRequest) {
    const result = store.call(request) as T, seq = store.workspace().seq;
    assert.deepEqual(store.call(request), result);
    assert.equal(store.workspace().seq, seq);
    return result;
}

function legacyDraft(store: Store, target: string, body: string, updatedAt = at) {
    const draft: Draft = { target, body, revision: 7, updatedAt };
    store.db.prepare("INSERT INTO drafts VALUES(?,?,?)").run(target, draft.revision, JSON.stringify(draft));
    return draft;
}

test("migration 3 copies the newest non-empty capture draft verbatim, including missing targets, without changing old rows", t => {
    const f = fixture(t), a = session(f.store);
    f.store.db.exec("DELETE FROM schema_migrations WHERE version=3");
    legacyDraft(f.store, captureDraftKey(a.id), "会话草稿", "2026-10-16T07:00:00Z");
    legacyDraft(f.store, captureDraftKey(null), "收件箱草稿", "2026-10-16T07:30:00Z");
    const newest = legacyDraft(f.store, captureDraftKey("missing"), "  token=用户原文😀\n末行  ", at);
    legacyDraft(f.store, captureDraftKey("empty"), "", "2026-10-17T08:00:00Z");
    for (const target of ["inbox", a.id, "capture"]) legacyDraft(f.store, target, "别的草稿", "2026-10-17T09:00:00Z");
    const originals = f.store.db.prepare("SELECT * FROM drafts ORDER BY target").all();
    f.reopen();
    assert.deepEqual(f.store.workspace().drafts[CAPTURE_DRAFT_KEY], { target: CAPTURE_DRAFT_KEY, body: newest.body, revision: 1, updatedAt: newest.updatedAt });
    assert.deepEqual(f.store.db.prepare("SELECT * FROM drafts WHERE target<>? ORDER BY target").all(CAPTURE_DRAFT_KEY), originals);
    const migrated = f.store.workspace();
    f.reopen();
    assert.deepEqual(f.store.workspace(), migrated);
    const request = { method: "draft.save" as const, target: "capture", body: "", expectedRevision: 1, operationId: "clear" };
    replay<Draft>(f.store, request);
    assert.throws(() => f.store.call({ ...request, operationId: "stale" }), /core\.errorRecordChangedReloadBeforeSaving/);
    f.reopen();
    assert.equal(f.store.workspace().drafts[CAPTURE_DRAFT_KEY]!.body, "");
    assert.equal(f.store.workspace().drafts[CAPTURE_DRAFT_KEY]!.revision, 2);
    assert.deepEqual(f.store.db.prepare("SELECT * FROM drafts WHERE target<>? ORDER BY target").all(CAPTURE_DRAFT_KEY), originals);
});

test("migration 3 chooses an inbox draft by timestamp and never overwrites an existing shared draft, even empty", t => {
    const f = fixture(t);
    f.store.db.exec("DELETE FROM schema_migrations WHERE version=3");
    legacyDraft(f.store, captureDraftKey("a"), "a", "2026-10-16T09:00:00+08:00");
    legacyDraft(f.store, captureDraftKey(null), "最新收件箱", "2026-10-16T02:00:00Z");
    f.reopen();
    assert.equal(f.store.workspace().drafts[CAPTURE_DRAFT_KEY]!.body, "最新收件箱");
    f.store.call({ method: "draft.save", target: "capture", body: "", expectedRevision: 1, operationId: "clear" });
    f.store.db.exec("DELETE FROM schema_migrations WHERE version=3");
    f.reopen();
    assert.equal(f.store.workspace().drafts[CAPTURE_DRAFT_KEY]!.body, "");
    assert.equal(f.store.workspace().drafts[CAPTURE_DRAFT_KEY]!.revision, 2);
});

test("migration 3 with empty legacy drafts leaves a new shared draft at revision zero; target-scoped writes are rejected", t => {
    const f = fixture(t);
    f.store.db.exec("DELETE FROM schema_migrations WHERE version=3");
    legacyDraft(f.store, captureDraftKey(null), "");
    f.reopen();
    assert.equal(f.store.workspace().drafts[CAPTURE_DRAFT_KEY], undefined);
    const request = { method: "draft.save" as const, target: "capture", body: "共享草稿", expectedRevision: 0, operationId: "shared" };
    for (const sessionId of [null, "missing"]) {
        const scoped = { ...request, sessionId };
        assert.equal(validRequest(scoped), false);
        assert.throws(() => f.store.call(scoped), /Invalid/);
    }
    replay<Draft>(f.store, request);
    f.reopen();
    assert.equal(f.store.workspace().drafts[CAPTURE_DRAFT_KEY]!.body, request.body);
    assert.equal(f.store.workspace().drafts[captureDraftKey(null)]!.body, "");
});

test("migration 2 converts memo records and drafts once, preserving every old row and raw body", t => {
    const f = fixture(t), s = session(f.store);
    // Build the T4 boundary without writing a second implementation of its schema.
    f.store.db.exec("DROP TABLE ideas; DROP TABLE drafts; DROP TABLE idea_imports; DELETE FROM schema_migrations WHERE version>=2");
    for (const [id, sessionId] of [["mapped", s.id], ["orphan", "missing"], ["unassigned", "import-unassigned"]]) {
        f.store.put("memo", { id: id!, sessionId, body: "  token=原样😀\n  ", purpose: "next-step", deleted: false, createdAt: at, updatedAt: at, revision: 5 });
    }
    f.store.setMeta(`draft:${s.id}`, " 旧草稿😀 ");
    const legacy = f.store.db.prepare("SELECT * FROM records WHERE kind='memo'").all();
    f.reopen();
    assert.deepEqual(f.store.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map(row => row.version), [1, 2, 3, 4]);
    const w = f.store.workspace();
    assert.equal(w.ideas.length, 3);
    assert.equal(w.inboxIdeaCount, 2);
    assert.equal(w.sessions[0]!.pendingIdeaCount, 1);
    assert.ok(w.ideas.every(idea => idea.status === "pending" && idea.body === "  token=原样😀\n  "));
    assert.equal(w.drafts[s.id]!.body, " 旧草稿😀 ");
    assert.equal(w.drafts[s.id]!.revision, 1);
    f.reopen();
    assert.deepEqual(f.store.workspace(), w);
    assert.deepEqual(f.store.db.prepare("SELECT * FROM records WHERE kind='memo'").all(), legacy);
    const idea = w.ideas[0]!;
    const discarded = f.store.call({ method: "idea.setStatus", id: idea.id, status: "discarded", expectedRevision: 1, operationId: "discard" }) as Idea;
    f.store.call({ method: "idea.purge", id: idea.id, expectedRevision: discarded.revision, operationId: "purge" });
    f.reopen();
    assert.equal(f.store.workspace().ideas.length, 2);
    assert.deepEqual(f.store.db.prepare("SELECT * FROM records WHERE kind='memo'").all(), legacy);
});

test("save/edit/move are revisioned, replay original results and keep pending counts correct through restart", t => {
    const f = fixture(t), a = session(f.store), b = session(f.store, "native-b");
    const request = { method: "idea.save" as const, sessionId: a.id, body: "  密钥 token=用户文本\n😀  ", expectedRevision: 0, operationId: "create" };
    const original = replay<Idea>(f.store, request);
    assert.equal(original.body, request.body);
    assert.throws(() => f.store.call({ ...request, body: "different" }), /core\.errorOperationIdReusedForDifferentContent/);
    const edit = { ...request, id: original.id, body: "修改\n  😀", expectedRevision: 1, operationId: "edit" };
    const edited = replay<Idea>(f.store, edit);
    assert.equal(edited.revision, 2);
    assert.throws(() => f.store.call({ ...edit, operationId: "stale" }), /core\.errorRecordChangedReloadBeforeSaving/);
    assert.throws(() => f.store.call({ ...edit, id: "missing", operationId: "missing" }), /core\.error(?:Idea|Session)NoLongerExists/);
    assert.throws(() => f.store.call({ ...edit, sessionId: b.id, expectedRevision: 2, operationId: "wrong-owner" }), /core\.errorUseIdeaMoveToChangeTheOwner/);
    assert.equal(f.store.workspace().sessions.find(s => s.id === a.id)!.pendingIdeaCount, 1);
    const move = { method: "idea.move" as const, id: original.id, sessionId: null, expectedRevision: 2, operationId: "inbox" };
    replay<Idea>(f.store, move);
    assert.equal(f.store.workspace().inboxIdeaCount, 1);
    assert.equal(f.store.workspace().sessions.find(s => s.id === a.id)!.pendingIdeaCount, 0);
    assert.throws(() => f.store.call({ ...move, operationId: "stale-move" }), /core\.errorRecordChangedReloadBeforeSaving/);
    assert.throws(() => f.store.call({ ...move, sessionId: "missing", expectedRevision: 3, operationId: "missing-target" }), /Session/);
    const moved = replay<Idea>(f.store, { ...move, sessionId: b.id, expectedRevision: 3, operationId: "to-b" });
    assert.equal(moved.body, edited.body);
    f.reopen();
    assert.deepEqual(f.store.call(request), original);
    assert.deepEqual(f.store.workspace().ideas, [moved]);
    assert.equal(f.store.workspace().inboxIdeaCount, 0);
    assert.equal(f.store.workspace().sessions.find(s => s.id === b.id)!.pendingIdeaCount, 1);
});

test("brought undo, discarded restore and purge guards preserve text and enforce transitions", t => {
    const f = fixture(t);
    let idea = save(f.store);
    const status = (value: Idea["status"], operationId: string) => replay<Idea>(f.store, { method: "idea.setStatus", id: idea.id, status: value, expectedRevision: idea.revision, operationId });
    const purge = () => f.store.call({ method: "idea.purge", id: idea.id, expectedRevision: idea.revision, operationId: "purge" });
    assert.throws(purge, /core\.errorOnlyDiscardedIdeasCanBePurged/);
    idea = status("brought", "bring");
    assert.equal(idea.broughtAt, at);
    assert.equal(f.store.workspace().inboxIdeaCount, 0);
    assert.throws(purge, /core\.errorOnlyDiscardedIdeasCanBePurged/);
    assert.throws(() => status("discarded", "wrong-status"), /Restore/);
    idea = status("pending", "undo");
    assert.equal(idea.broughtAt, undefined);
    assert.equal(f.store.workspace().inboxIdeaCount, 1);
    idea = status("discarded", "discard");
    assert.equal(idea.discardedAt, at);
    assert.throws(() => status("brought", "wrong-status"), /Restore/);
    idea = status("pending", "restore");
    assert.equal(idea.discardedAt, undefined);
    assert.equal(idea.body, "  token=user-authored\n中文😀  ");
    idea = status("discarded", "discard-again");
    assert.throws(() => f.store.call({ method: "idea.purge", id: idea.id, expectedRevision: 1, operationId: "old-purge" }), /core\.errorRecordChangedReloadBeforeSaving/);
    const request = { method: "idea.purge" as const, id: idea.id, expectedRevision: idea.revision, operationId: "purge" };
    const result = replay(f.store, request);
    f.reopen();
    assert.deepEqual(f.store.call(request), result);
    assert.equal(f.store.workspace().ideas.length, 0);
    assert.throws(() => f.store.call({ ...request, operationId: "purge-again" }), /core\.error(?:Idea|Session)NoLongerExists/);
});

test("4000-code-point input allows CJK and astral emoji, never redacts or trims and rejects oversized edits", t => {
    const f = fixture(t);
    for (const [index, body] of ["汉".repeat(4000), "😀".repeat(4000), "中😀".repeat(2000), " \npassword=用户输入\0😀 "].entries()) {
        const idea = save(f.store, body, null, `unicode-${index}`);
        assert.equal(idea.body, body);
        assert.throws(() => f.store.call({ method: "idea.save", id: idea.id, sessionId: null, body: "😀".repeat(4001), expectedRevision: 1, operationId: `long-edit-${index}` }), /Invalid/);
    }
    for (const body of ["中".repeat(4001), "😀".repeat(4001), " ", ""]) assert.throws(() => save(f.store, body, null, "invalid"), /core\.error(?:InvalidRequest|IdeaIsEmpty)/);
    f.reopen();
    assert.equal(f.store.workspace().ideas.length, 4);
    assert.ok(f.store.workspace().ideas.some(idea => idea.body.includes("password=用户输入\0")));
    assert.equal(validRequest({ method: "memo.save", sessionId: "s", body: "old", expectedRevision: 0, operationId: "old" }), false);
    assert.equal(validRequest({ method: "idea.save", sessionId: null, body: "new", operationId: "missing-revision" }), false);
});

test("session, inbox and capture drafts persist revisions and replay without clearing later text", t => {
    const f = fixture(t), s = session(f.store);
    for (const target of [s.id, "inbox", "capture"]) {
        const request = { method: "draft.save" as const, target, body: "  草稿😀\n ", expectedRevision: 0, operationId: `draft:${target}` };
        const first = replay<Draft>(f.store, request);
        assert.equal(first.revision, 1);
        const second = replay<Draft>(f.store, { ...request, body: "后来写的字", expectedRevision: 1, operationId: `draft-edit:${target}` });
        assert.throws(() => f.store.call({ ...request, operationId: `stale:${target}` }), /core\.errorRecordChangedReloadBeforeSaving/);
        assert.throws(() => f.store.call({ ...request, body: "different" }), /core\.errorOperationIdReusedForDifferentContent/);
        assert.deepEqual(f.store.call(request), first);
        f.reopen();
        assert.deepEqual(f.store.workspace().drafts[target === "capture" ? CAPTURE_DRAFT_KEY : target], second);
    }
    save(f.store, "已提交的想法", s.id);
    assert.equal(f.store.workspace().drafts[s.id]!.body, "后来写的字");
    assert.throws(() => f.store.call({ method: "draft.save", target: "missing", body: "text", expectedRevision: 0, operationId: "unknown-draft" }), /Session/);
    assert.throws(() => f.store.call({ method: "draft.save", target: "capture", body: "😀".repeat(4001), expectedRevision: 2, operationId: "long-draft" }), /Invalid/);
});

test("legacy import maps only memos, retains source tables, deduplicates by source key and exports all legacy databases", async t => {
    const f = fixture(t), s = session(f.store);
    const path = join(f.directory, "aimspan.sqlite3"), legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE sessions(id,agent,native_session_id,title,project_path);
        CREATE TABLE matter_session_links(matter_id,session_id,unlinked_at);
        CREATE TABLE notes(id,matter_id,session_id,body,created_at);
        CREATE TABLE captures(id,session_id,body);
        CREATE TABLE todos(id,body); CREATE TABLE receipts(id,payload);`);
    legacy.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run("old-a", "codex", "native-a", "Original", "/__aimspan_fixture__/project");
    legacy.prepare("INSERT INTO matter_session_links VALUES(?,?,NULL)").run("matter", "old-a");
    legacy.prepare("INSERT INTO notes VALUES(?,?,?,?,?)").run("n1", "matter", null, "  token=用户旧文\n😀  ", at);
    legacy.prepare("INSERT INTO notes VALUES(?,?,?,?,?)").run("n2", null, "unmapped", "收件箱原文", at);
    legacy.prepare("INSERT INTO captures VALUES(?,?,?)").run("c1", "old-a", "捕获的备忘录");
    legacy.prepare("INSERT INTO todos VALUES(?,?)").run("t", "仅供旧数据导出");
    legacy.prepare("INSERT INTO receipts VALUES(?,?)").run(9223372036854775807n, new Uint8Array([0, 255]));
    legacy.close();
    const original = readFileSync(path);
    await f.store.importLegacy(path);
    const w = f.store.workspace();
    assert.equal(w.sessions.length, 1);
    assert.equal(w.ideas.length, 3);
    assert.equal(w.ideas.find(idea => idea.body.includes("token="))!.sessionId, s.id);
    assert.equal(w.inboxIdeaCount, 1);
    assert.equal(w.sessions[0]!.pendingIdeaCount, 2);
    assert.equal(f.store.get("attention", "t"), null);
    const recovery = f.store.meta<{ recovery: string }>("importReport")!.recovery;
    assert.ok(statSync(recovery).isFile());
    await f.store.importLegacy(path);
    f.reopen();
    assert.deepEqual(f.store.workspace().ideas, w.ideas);
    // Source-key receipts still prevent duplicates if the file-level receipt is absent.
    f.store.db.prepare("DELETE FROM imported WHERE source=?").run(path);
    await f.store.importLegacy(path);
    assert.deepEqual(f.store.workspace().ideas, w.ideas);
    assert.deepEqual(readFileSync(path), original);
    f.store.db.exec("CREATE TABLE old_briefs(id,body); INSERT INTO old_briefs VALUES('b','保留简报')");
    const attached = join(f.directory, "attached.sqlite3"), extra = new DatabaseSync(attached);
    extra.exec("CREATE TABLE old_contexts(id,body); INSERT INTO old_contexts VALUES('context','保留背景')"); extra.close();
    f.store.db.prepare("ATTACH DATABASE ? AS previous").run(attached);
    const exportPath = join(f.directory, "export.json");
    const request = { method: "legacy.export" as const, path: exportPath, operationId: "export" };
    assert.equal(validRequest(request), true);
    assert.equal(validRendererRequest(request), false);
    const result = replay(f.store, request);
    const exported = JSON.parse(readFileSync(exportPath, "utf8")) as { databases: { name: string; tables: { name: string; rows: Record<string, unknown>[] }[] }[] };
    const tables = exported.databases.flatMap(db => db.tables);
    assert.ok(tables.some(table => table.name === "old_briefs" && table.rows[0]!.body === "保留简报"));
    assert.ok(tables.some(table => table.name === "old_contexts" && table.rows[0]!.body === "保留背景"));
    assert.ok(tables.some(table => table.name === "todos" && table.rows[0]!.body === "仅供旧数据导出"));
    assert.deepEqual(tables.find(table => table.name === "receipts")!.rows[0], { id: { type: "integer", value: "9223372036854775807" }, payload: { type: "blob", base64: "AP8=" } });
    assert.equal(statSync(exportPath).mode & 0o777, 0o600);
    writeFileSync(exportPath, "do not overwrite on replay");
    f.reopen();
    assert.deepEqual(f.store.call(request), result);
    assert.equal(readFileSync(exportPath, "utf8"), "do not overwrite on replay");
    assert.throws(() => f.store.call({ ...request, path: join(f.directory, "other.json") }), /core\.errorOperationIdReusedForDifferentContent/);
    const removed = w.ideas[0]!;
    f.store.call({ method: "idea.setStatus", id: removed.id, status: "discarded", expectedRevision: removed.revision, operationId: "discard-import" });
    f.store.call({ method: "idea.purge", id: removed.id, expectedRevision: removed.revision + 1, operationId: "purge-import" });
    f.store.db.prepare("DELETE FROM imported WHERE source=?").run(path);
    await f.store.importLegacy(path);
    assert.equal(f.store.workspace().ideas.length, 2);
    assert.ok(!f.store.workspace().ideas.some(idea => idea.id === removed.id));
});

test("export rejects unsafe paths and rolls back failed operations", t => {
    const f = fixture(t), destination = join(f.directory, "export.json"), link = join(f.directory, "link.json");
    writeFileSync(destination, "untouched"); symlinkSync(destination, link);
    for (const path of [link, join(f.directory, "companion.sqlite3"), join(f.directory, ".claude", "export.json")]) {
        assert.throws(() => f.store.call({ method: "legacy.export", path, operationId: "export" }), /core\.error(?:SymlinkPathsAreNotSupported|ChooseAJsonFileOutsideNativeAgentDirectories)/);
    }
    assert.equal(readFileSync(destination, "utf8"), "untouched");
    assert.equal(f.store.db.prepare("SELECT id FROM operations WHERE id='export'").get(), undefined);
    replay(f.store, { method: "legacy.export", path: destination, operationId: "export" });
});

test("bounded export fails atomically instead of truncating legacy rows", t => {
    const f = fixture(t), destination = join(f.directory, "export.json");
    f.store.db.exec(`CREATE TABLE historical_rows(id);
        INSERT INTO historical_rows WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<100001) SELECT n FROM ids;`);
    writeFileSync(destination, "previous export");
    assert.throws(() => f.store.call({ method: "legacy.export", path: destination, operationId: "bounded-export" }), /core\.errorLegacyExportExceedsTheRowLimit/);
    assert.equal(readFileSync(destination, "utf8"), "previous export");
    assert.equal(f.store.db.prepare("SELECT id FROM operations WHERE id='bounded-export'").get(), undefined);
    assert.ok(!readdirSync(f.directory).some(name => name.endsWith(".tmp")));
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM historical_rows").get()!.n, 100001);
});

test("historical long memos migrate verbatim while new edits retain the 4000-code-point limit", t => {
    const f = fixture(t), body = "😀中".repeat(3000);
    f.store.db.exec("DROP TABLE ideas; DROP TABLE drafts; DROP TABLE idea_imports; DELETE FROM schema_migrations WHERE version>=2");
    f.store.put("memo", { id: "long", sessionId: "missing", body, createdAt: at, updatedAt: at, revision: 1 });
    f.reopen();
    const idea = f.store.workspace().ideas[0]!;
    assert.equal(idea.body, body);
    assert.equal(idea.sessionId, null);
    assert.throws(() => f.store.call({ method: "idea.save", id: idea.id, sessionId: null, body, expectedRevision: 1, operationId: "long-edit" }), /Invalid/);
    assert.equal(f.store.get<{ body: string }>("memo", "long")!.body, body);
});

test("R1 idea.move rejects child and non-interactive targets without losing inbox ideas", t => {
    const f = fixture(t), root = session(f.store);
    const child = f.store.observe({ agent: "codex", nativeId: "child", parentNativeId: root.nativeId, title: "Child", project: root.project, state: "unknown", at, confidence: "unknown", sources: [], version: "v1" });
    const orphan = f.store.observe({ agent: "codex", nativeId: "orphan", parentNativeId: "unseen-parent", title: "Orphan", project: root.project, state: "unknown", at, confidence: "unknown", sources: [], version: "v1" });
    const automated = f.store.observe({ agent: "codex", nativeId: "automated", entrypoint: "codex_exec", title: "Automation", project: root.project, state: "unknown", at, confidence: "unknown", sources: [], version: "v1" });
    const idea = save(f.store), before = f.store.workspace();
    for (const target of [child, orphan, automated]) {
        assert.throws(() => f.store.call({ method: "idea.move", id: idea.id, sessionId: target.id, expectedRevision: 1, operationId: "move" }), /core\.errorChooseARootInteractiveSessionOrTheInboxChildAndNonInteractiveSessionsCannotReceiveMovedIdeas/);
        assert.deepEqual(f.store.workspace(), before);
        assert.equal(f.store.db.prepare("SELECT id FROM operations WHERE id='move'").get(), undefined);
    }
    const moved = replay<Idea>(f.store, { method: "idea.move", id: idea.id, sessionId: root.id, expectedRevision: 1, operationId: "move" });
    replay(f.store, { method: "idea.move", id: idea.id, sessionId: null, expectedRevision: moved.revision, operationId: "inbox" });
    f.reopen();
    assert.equal(f.store.workspace().ideas[0]!.body, idea.body);
    assert.equal(f.store.workspace().inboxIdeaCount, 1);
});

test("panel preferences survive restart and legacy import statistics expose no source paths", async t => {
    const f = fixture(t);
    f.store.call({ method: "settings.save", settings: { ...f.store.settings(), captureShortcut: "CommandOrControl+Shift+I", bubbleShortcut: "CommandOrControl+Shift+B", bubbleEnabled: false, notifications: true } });
    f.reopen();
    assert.equal(f.store.settings().captureShortcut, "CommandOrControl+Shift+I");
    assert.equal(f.store.settings().bubbleShortcut, "CommandOrControl+Shift+B");
    assert.equal(f.store.settings().bubbleEnabled, false);
    assert.deepEqual(f.store.workspace().legacyImport, { databases: 0, sessions: 0, ideas: 0 });
    const path = join(f.directory, "old.sqlite3"), db = new DatabaseSync(path);
    db.exec("CREATE TABLE memos(id TEXT,body TEXT); INSERT INTO memos VALUES('old','旧想法')"); db.close();
    await f.store.importLegacy(path);
    f.reopen();
    assert.deepEqual(f.store.workspace().legacyImport, { databases: 1, sessions: 0, ideas: 1 });
    assert.equal(JSON.stringify(f.store.workspace().legacyImport).includes(f.directory), false);
    assert.equal(validRequest({ method: "settings.save", settings: { ...f.store.settings(), bubbleEnabled: "yes" } }), false);
    assert.equal(validRequest({ method: "settings.save", settings: { ...f.store.settings(), captureShortcut: "x".repeat(161) } }), false);
});
