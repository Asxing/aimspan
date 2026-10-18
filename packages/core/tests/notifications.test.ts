import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DEFAULT_SETTINGS, notificationIdentity, validRendererRequest, validRequest, validSettings, type CoreRequest } from "@aimspan/protocol";
import { Store, type Observation } from "../src/store.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 16, 8, 0, seconds)).toISOString();
const observation: Observation = { agent: "claude-code", nativeId: "notification-fixture", title: "合成任务", project: "/Users/__aimspan_fixture__/project",
    state: "working", at: at(0), confidence: "explicit", sources: [], version: "start", lastPromptAt: at(0),
    turns: [{ promptAt: at(0), turnId: "native-turn", errors: [], changedFiles: [], failedCommands: [] }] };
function fixture(t: { after(fn: () => void): void }) {
    const directory = mkdtempSync("/private/tmp/__aimspan_fixture__-notifications-");
    let store = new Store(directory, () => at(600));
    t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    return { get store() { return store; }, reopen() { store.close(); store = new Store(directory, () => at(600)); } };
}

test("stable turn identity, duration and durable notification receipts survive enrichment and restart", t => {
    const f = fixture(t);
    const started = f.store.observe(observation);
    const identity = `completion:${started.latestTurn!.identity}`;
    assert.match(identity, /^completion:turn:/);
    const ended = f.store.observe({ ...observation, state: "ended", at: at(120), version: "end", turns: [{ ...observation.turns![0]!, endedAt: at(120), durationMs: 120_000 }] });
    assert.equal(notificationIdentity(ended, "completion"), identity);
    assert.equal(ended.latestTurn?.durationMs, 120_000);
    const claim: CoreRequest = { method: "notification.claim", sessionId: ended.id, identity, expectedRevision: 0, operationId: "first-notice" };
    assert.equal(f.store.call(claim), true);
    assert.equal(f.store.call(claim), true); // Exact operation replay returns its original result.
    assert.equal(f.store.call({ ...claim, operationId: "same-turn-new-operation" }), false);
    const other = f.store.observe({ ...observation, nativeId: "another-session", turns: [{ ...observation.turns![0]!, endedAt: at(120), durationMs: 120_000 }] });
    assert.equal(notificationIdentity(other, "completion"), identity); // Equal title, project and native turn ID do not merge receipts.
    assert.equal(f.store.call({ ...claim, sessionId: other.id, operationId: "other-session-notice" }), true);
    f.store.call({ method: "idea.save", sessionId: ended.id, body: "  原文\n保留😀  ", expectedRevision: 0, operationId: "idea" });
    f.reopen();
    assert.equal(f.store.workspace().sessions.find(s => s.id === ended.id)!.lastNotifiedIdentity, identity);
    assert.equal(f.store.workspace().ideas[0]!.body, "  原文\n保留😀  ");
    assert.equal(f.store.call({ ...claim, operationId: "after-restart" }), false);
    // Native IDs allow correction of a lifecycle start without replacing the observation identity.
    const refined = f.store.observe({ ...observation, at: at(121), lastPromptAt: at(1), version: "token-metadata", turns: [{ ...observation.turns![0]!, promptAt: at(1), endedAt: at(120), durationMs: 120_000 }] });
    assert.equal(notificationIdentity(refined, "completion"), identity);
    assert.equal(f.store.call({ ...claim, operationId: "after-enrichment" }), false);
    const second = f.store.observe({ ...observation, at: at(400), lastPromptAt: at(200), turns: [{ ...observation.turns![0]!, turnId: "next-native-turn", promptAt: at(200), endedAt: at(400), durationMs: 200_000 }] });
    assert.notEqual(notificationIdentity(second, "completion"), identity);
    assert.equal(f.store.call({ ...claim, identity: notificationIdentity(second, "completion")!, operationId: "second-notice" }), true);
    // The renderer cannot reserve identities or erase receipts by saving old settings.
    assert.equal(validRequest(claim), true); assert.equal(validRendererRequest(claim), false);
    f.store.setSettings({ ...DEFAULT_SETTINGS, language: "en" });
    assert.equal(f.store.workspace().sessions.find(s => s.id === ended.id)!.lastNotifiedIdentity, notificationIdentity(second, "completion"));
    assert.throws(() => f.store.call({ ...claim, identity: "different-payload" }), /core\.errorOperationIdReusedForDifferentContent/);
});

test("R1 registry-only waiting and late completion have stable independent receipts across resume and restart", t => {
    const f = fixture(t);
    const waiting = f.store.observe({ ...observation, turns: [], at: at(10), registry: { live: true, status: "waiting", statusUpdatedAt: at(10) } });
    const identity = notificationIdentity(waiting, "waiting")!;
    const claim: CoreRequest = { method: "notification.claim", sessionId: waiting.id, identity, expectedRevision: 0, operationId: "waiting" };
    assert.equal(identity, "waiting:1");
    assert.throws(() => f.store.call({ ...claim, expectedRevision: 1 }), /core\.errorRecordChangedReloadBeforeSaving/);
    assert.equal(f.store.call(claim), true);
    f.reopen();
    // Metadata and prompt movement within the same wait do not create an entry.
    const repeated = f.store.observe({ ...observation, turns: [], at: at(20), lastPromptAt: at(15), registry: { live: true, status: "requires_action", statusUpdatedAt: at(20) } });
    assert.equal(notificationIdentity(repeated, "waiting"), identity);
    assert.equal(f.store.call({ ...claim, operationId: "repeated-wait" }), false);
    // The review's T60 resume occurs before any transcript turn has arrived.
    f.store.observe({ ...observation, turns: [], at: at(60), lastPromptAt: at(60), registry: { live: true, status: "busy", statusUpdatedAt: at(60) } });
    f.reopen();
    const ended = f.store.observe({ ...observation, at: at(180), turns: [{ ...observation.turns![0]!, endedAt: at(180), durationMs: 180_000 }] });
    assert.equal(ended.lastPromptAt, at(60));
    const completionIdentity = notificationIdentity(ended, "completion")!;
    assert.notEqual(completionIdentity, identity);
    assert.match(completionIdentity, /^completion:turn:/);
    assert.equal(f.store.call({ ...claim, identity: completionIdentity, operationId: "completed" }), true);
    f.reopen();
    assert.equal(f.store.call({ ...claim, identity: completionIdentity, operationId: "completed-again" }), false);
    // Corrected terminal metadata and another moved registry timestamp stay the same completion.
    const enriched = f.store.observe({ ...observation, at: at(181), lastPromptAt: at(90), turns: [{ ...observation.turns![0]!, endedAt: at(181), durationMs: 181_000 }] });
    assert.equal(notificationIdentity(enriched, "completion"), completionIdentity);
    assert.equal(f.store.call({ ...claim, identity: completionIdentity, operationId: "enriched-completion" }), false);
    assert.equal(f.store.workspace().sessions[0]!.lastNotifiedIdentity, completionIdentity);
});

test("R1 each registry waiting entry is durable and independent of projected waiting", t => {
    const f = fixture(t);
    f.store.observe(observation);
    const short = f.store.observe({ ...observation, at: at(10), turns: [{ ...observation.turns![0]!, endedAt: at(10), durationMs: 10_000 }], registry: { live: true, status: "idle", statusUpdatedAt: at(10) } });
    assert.equal(short.state, "waiting");
    const approval: Observation = { ...observation, at: at(21), lastPromptAt: at(20), turns: [{ ...observation.turns![0]!, turnId: "second-turn", promptAt: at(20) }], registry: { live: true, status: "needs_user", statusUpdatedAt: at(21) } };
    const waiting = f.store.observe(approval);
    assert.equal(waiting.state, "waiting");
    const identity = notificationIdentity(waiting, "waiting")!;
    const claim: CoreRequest = { method: "notification.claim", sessionId: waiting.id, identity, expectedRevision: 0, operationId: "first-approval" };
    assert.equal(identity, "waiting:1");
    assert.equal(f.store.call(claim), true);
    f.reopen();
    const repeat = f.store.observe({ ...approval, at: at(22), lastPromptAt: at(22), registry: { live: true, status: "blocked", statusUpdatedAt: at(22) } });
    assert.equal(notificationIdentity(repeat, "waiting"), identity);
    assert.equal(f.store.call({ ...claim, operationId: "same-entry" }), false);
    f.store.observe({ ...approval, at: at(30), registry: { live: true, status: "busy", statusUpdatedAt: at(30) } });
    f.reopen();
    // Even absent or repeated registry timestamps cannot collapse a newly observed entry.
    const reentry = f.store.observe({ ...approval, at: at(31), registry: { live: true, status: "waiting" } });
    assert.equal(reentry.latestTurn?.identity, waiting.latestTurn?.identity);
    const nextIdentity = notificationIdentity(reentry, "waiting")!;
    assert.equal(nextIdentity, "waiting:2");
    assert.equal(f.store.call({ ...claim, identity: nextIdentity, operationId: "second-approval" }), true);
    const stale = f.store.observe({ ...approval, at: at(21), registry: { live: true, status: "busy" } });
    assert.equal(notificationIdentity(stale, "waiting"), nextIdentity);
    assert.equal(f.store.call({ ...claim, identity: nextIdentity, operationId: "second-approval-repeat" }), false);
});

test("notification defaults track bubble changes until an explicit choice, which survives restart and older saves", t => {
    const f = fixture(t);
    assert.equal(f.store.settings().notifications, false);
    assert.equal(f.store.settings().notificationsExplicit, false);
    f.store.setSettings({ ...f.store.settings(), bubbleEnabled: false });
    assert.equal(f.store.settings().notifications, true);
    f.store.setSettings({ ...f.store.settings(), bubbleEnabled: true });
    assert.equal(f.store.settings().notifications, false);
    for (const notifications of [false, true]) {
        f.store.setSettings({ ...f.store.settings(), notifications, notificationsExplicit: true });
        for (const bubbleEnabled of [false, true]) {
            f.store.setSettings({ ...f.store.settings(), bubbleEnabled });
            assert.equal(f.store.settings().notifications, notifications);
            f.reopen();
            assert.equal(f.store.settings().notifications, notifications);
            assert.equal(f.store.settings().notificationsExplicit, true);
        }
    }
    const { notificationsExplicit: _explicit, ...older } = f.store.settings();
    f.store.setSettings({ ...older, language: "en" });
    assert.equal(f.store.settings().notificationsExplicit, true);
    for (const notificationsExplicit of ["true", 1, null]) assert.equal(validSettings({ ...DEFAULT_SETTINGS, notificationsExplicit }), false);
});

test("legacy DND migrates to one shared timestamp; pre-bubble choices and T9 defaults are preserved", t => {
    const f = fixture(t);
    const { notificationsExplicit: _explicit, ...old } = DEFAULT_SETTINGS;
    f.store.setMeta("settings", { ...old, doNotDisturbUntil: 1_800_000_000_000 });
    assert.equal(f.store.settings().dndUntil, 1_800_000_000_000);
    assert.equal(f.store.settings().notificationsExplicit, false);
    assert.equal(Object.hasOwn(f.store.settings(), "doNotDisturbUntil"), false);
    f.store.setSettings({ ...f.store.settings(), dndUntil: 0, bubbleEnabled: false });
    f.reopen();
    assert.equal(f.store.settings().dndUntil, 0); // The retained legacy field cannot reactivate DND.
    assert.equal(f.store.settings().notifications, true);
    const { bubbleEnabled: _bubble, ...preBubble } = old;
    for (const notifications of [false, true]) {
        f.store.setMeta("settings", { ...preBubble, notifications });
        assert.equal(f.store.settings().notifications, notifications);
        assert.equal(f.store.settings().notificationsExplicit, true);
    }
    f.store.setMeta("settings", { ...old, notifications: true });
    assert.equal(f.store.settings().notificationsExplicit, true); // Diverges from the T9 bubble default.
    for (const dndUntil of [-1, NaN, Infinity, "tomorrow", 1.5]) assert.equal(validSettings({ ...DEFAULT_SETTINGS, dndUntil }), false);
});
