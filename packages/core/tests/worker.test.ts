import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.js";
import type { CatchUp, Workspace } from "@aimspan/protocol";
import { CAPTURE_DRAFT_KEY } from "@aimspan/protocol";

test("R1 worker drains queued drafts before stop and restart restores the final body", async t => {
    const root = mkdtempSync("/private/tmp/__aimspan_fixture__-worker-");
    const sources = join(root, "sources"); mkdirSync(sources);
    const directory = join(root, "state");
    const worker = new Worker(new URL("./fixtures/core-worker.js", import.meta.url));
    t.after(async () => { await worker.terminate(); rmSync(root, { recursive: true, force: true }); });
    const messages: { type: string; id?: string; error?: string }[] = [];
    const stopped = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Worker did not acknowledge stop")), 5000);
        worker.once("error", error => { clearTimeout(timer); reject(error); });
        worker.on("message", message => {
            messages.push(message);
            if (message.type === "stopped") { clearTimeout(timer); resolve(); }
        });
    });
    worker.postMessage({ type: "init", directory, codex: sources, claude: sources });
    worker.postMessage({ type: "call", id: "first", request: { method: "draft.save", target: "inbox", body: "第一版", expectedRevision: 0, operationId: "first" } });
    worker.postMessage({ type: "call", id: "final", request: { method: "draft.save", target: "inbox", body: "第一版加上最后几个字😀", expectedRevision: 1, operationId: "final" } });
    worker.postMessage({ type: "call", id: "capture-first", request: { method: "draft.save", target: "capture", body: "浮窗第一版", expectedRevision: 0, operationId: "capture-first" } });
    worker.postMessage({ type: "call", id: "capture-final", request: { method: "draft.save", target: "capture", body: "浮窗最后几个字😀", expectedRevision: 1, operationId: "capture-final" } });
    worker.postMessage({ type: "stop" });
    await stopped;
    assert.deepEqual(messages.filter(message => message.type === "response").map(message => ({ id: message.id, error: message.error })), ["first", "final", "capture-first", "capture-final"].map(id => ({ id, error: undefined })));
    assert.equal(messages.at(-1)!.type, "stopped");
    const reopened = new Store(directory);
    try {
        assert.equal(reopened.workspace().drafts.inbox!.body, "第一版加上最后几个字😀");
        assert.equal(reopened.workspace().drafts.inbox!.revision, 2);
        assert.equal(reopened.workspace().drafts[CAPTURE_DRAFT_KEY]!.body, "浮窗最后几个字😀");
        assert.equal(reopened.workspace().drafts[CAPTURE_DRAFT_KEY]!.revision, 2);
    } finally { reopened.close(); }
});

test("worker serves catchup through the production request path without marking the session viewed", async t => {
    const root = mkdtempSync("/private/tmp/__aimspan_fixture__-catchup-worker-");
    const sources = join(root, "sources"); mkdirSync(sources);
    const directory = join(root, "state"), at = "2026-10-16T08:00:00.000Z";
    const store = new Store(directory, () => at);
    const session = store.observe({ agent: "codex", nativeId: "synthetic", title: "合成会话", project: sources,
        at, state: "unknown", confidence: "unknown", sources: [], version: "fixture",
        turns: [{ promptAt: at, endedAt: at, lastAgentMessage: "合成回复", errors: [], changedFiles: [], failedCommands: [] }] });
    const expected = store.catchup(session.id), seq = store.workspace().seq;
    store.close();
    const worker = new Worker(new URL("./fixtures/core-worker.js", import.meta.url));
    t.after(async () => { await worker.terminate(); rmSync(root, { recursive: true, force: true }); });
    const messages: { type: string; id?: string; error?: string; result?: CatchUp; workspace?: Workspace }[] = [];
    const stopped = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Worker did not acknowledge stop")), 5000);
        worker.once("error", error => { clearTimeout(timer); reject(error); });
        worker.on("message", message => {
            messages.push(message);
            if (message.type === "stopped") { clearTimeout(timer); resolve(); }
        });
    });
    worker.postMessage({ type: "init", directory, codex: sources, claude: sources });
    worker.postMessage({ type: "call", id: "card", request: { method: "catchup", sessionId: session.id } });
    worker.postMessage({ type: "call", id: "missing", request: { method: "catchup", sessionId: "missing" } });
    worker.postMessage({ type: "stop" });
    await stopped;
    const card = messages.find(message => message.id === "card")!;
    assert.equal(card.error, undefined);
    assert.deepEqual(card.result, expected);
    assert.match(messages.find(message => message.id === "missing")!.error!, /core\.errorSessionNoLongerExists/);
    assert.ok(messages.filter(message => message.workspace).every(message => message.workspace!.seq === seq
        && message.workspace!.sessions[0]!.lastViewedAt === undefined && message.workspace!.sessions[0]!.baselinePending === true));
});
