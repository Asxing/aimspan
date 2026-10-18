import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { validSettings } from "@aimspan/protocol";
import { Store } from "../src/store.js";

test("bubble position and timed preferences survive restart and older callers without deleting ideas", t => {
    const directory = mkdtempSync("/private/tmp/__aimspan_fixture__-bubble-");
    let store = new Store(directory);
    t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    const original = store.settings();
    assert.equal(original.bubbleEnabled, true); assert.equal(original.bubbleShortcut, "");
    store.call({ method: "idea.save", sessionId: null, body: "  保留原文😀\n  ", expectedRevision: 0, operationId: "bubble-idea" });
    const position = { x: -22, y: 100, side: "left" as const };
    store.setSettings({ ...original, bubblePosition: position, bubbleHiddenUntil: 1_800_000_000_000, dndUntil: 1_800_000_000_001 });
    const { bubblePosition: _position, bubbleHiddenUntil: _hidden, dndUntil: _dnd, ...older } = original;
    store.setSettings({ ...older, language: "en" });
    store.close(); store = new Store(directory);
    assert.deepEqual(store.settings().bubblePosition, position);
    assert.equal(store.settings().bubbleHiddenUntil, 1_800_000_000_000);
    assert.equal(store.settings().dndUntil, 1_800_000_000_001);
    assert.equal(store.workspace().ideas[0]!.body, "  保留原文😀\n  ");
    for (const bubblePosition of [{ x: NaN, y: 0, side: "free" }, { x: 0, y: Infinity, side: "left" }, { x: 0, y: 0, side: "top" }, { x: 1_000_001, y: 0, side: "right" }])
        assert.equal(validSettings({ ...original, bubblePosition }), false);
    for (const bubbleHiddenUntil of [-1, Infinity, "tomorrow", 1.5]) assert.equal(validSettings({ ...original, bubbleHiddenUntil }), false);
});

test("T18 last new-session app defaults to Codex and survives restart and older settings callers", t => {
    const directory = mkdtempSync("/private/tmp/__aimspan_fixture__-new-session-");
    let store = new Store(directory);
    t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    assert.equal(store.settings().lastNewSessionApp, "codex");
    const { lastNewSessionApp: _app, ...older } = store.settings();
    store.setSettings({ ...older, lastNewSessionApp: "claude" });
    store.setSettings({ ...older, language: "en" });
    store.close(); store = new Store(directory);
    assert.equal(store.settings().lastNewSessionApp, "claude");
    assert.equal(store.settings().language, "en");
    for (const lastNewSessionApp of ["other", "claude-code", null, 1]) assert.equal(validSettings({ ...older, lastNewSessionApp }), false);
    store.setSettings({ ...store.settings(), lastNewSessionApp: "codex" });
    store.close(); store = new Store(directory);
    assert.equal(store.settings().lastNewSessionApp, "codex");
});

test("T23 new profiles default to English and stored Chinese survives restart unchanged", t => {
    const directory = mkdtempSync("/private/tmp/__aimspan_fixture__-language-");
    let store = new Store(directory);
    t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    assert.equal(store.settings().language, "en");
    store.setSettings({ ...store.settings(), language: "zh" });
    store.call({ method: "idea.save", sessionId: null, body: "  原文 idea\n保留  ", expectedRevision: 0, operationId: "language-idea" });
    store.close(); store = new Store(directory);
    assert.equal(store.settings().language, "zh");
    store.setSettings({ ...store.settings(), language: "en" });
    assert.equal(store.workspace().ideas[0]!.body, "  原文 idea\n保留  ");
});
