// @vitest-environment node
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS, notificationIdentity, type CoreRequest, type Session, type Settings } from "@aimspan/protocol";
import { session, workspace } from "../../test/panel-fixtures";
import { Store, type Observation } from "../../../../packages/core/src/store";

vi.mock("electron", async () => {
    const { EventEmitter } = await import("node:events");
    class Notification extends EventEmitter {
        static instances: Notification[] = [];
        static isSupported = vi.fn(() => true);
        constructor(readonly options: { title: string; body: string }) { super(); Notification.instances.push(this); }
        show = vi.fn();
        close = vi.fn();
    }
    return { Notification };
});
import { Notification } from "electron";
import { SessionNotifications, shouldNotify } from "./notifications";
const shown = () => Reflect.get(Notification, "instances") as (EventEmitter & { options: { title: string; body: string }; show: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> })[];
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 16, 8, 0, seconds)).toISOString();
const now = Date.parse(at(600));
const enabled: Settings = { ...DEFAULT_SETTINGS, language: "zh", bubbleEnabled: false, notifications: true };
const running = (patch: Partial<Session> = {}) => session("a", { state: "running", hasNewResult: false, lastPromptAt: at(0),
    latestTurn: { identity: "turn:first", promptAt: at(0) }, ...patch });
const ended = (patch: Partial<Session> = {}) => session("a", { lastPromptAt: at(0), lastTurnEndAt: at(120),
    latestTurn: { identity: "turn:first", promptAt: at(0), endedAt: at(120), durationMs: 120_000 }, ...patch });
beforeEach(() => { vi.clearAllMocks(); shown().length = 0; vi.mocked(Notification.isSupported).mockReturnValue(true); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());

test("R1 registry-only waiting keeps its entry identity when lastPromptAt moves", () => {
    const prev = running({ agent: "claude-code", latestTurn: undefined, registry: { live: true, status: "busy" } });
    const waiting = { ...prev, state: "waiting" as const, registryWaitingEntry: 1, registry: { live: true, status: "waiting", statusUpdatedAt: at(10) } };
    const first = shouldNotify(prev, waiting, enabled, now);
    const moved = shouldNotify(prev, { ...waiting, lastPromptAt: at(60) }, enabled, now);
    expect(first).not.toBeNull();
    expect(moved?.identity).toBe(first?.identity);
});

test("R1 approval wait after a short completed turn uses registry evidence", () => {
    const prev = ended({ agent: "claude-code", lastTurnEndAt: at(10), registry: { live: true, status: "idle" },
        latestTurn: { identity: "turn:first", promptAt: at(0), endedAt: at(10), durationMs: 10_000 } });
    expect(shouldNotify(running({ agent: "claude-code" }), prev, enabled, now)).toBeNull();
    const next = { ...prev, lastPromptAt: at(20), hasNewResult: false, registryWaitingEntry: 1,
        latestTurn: { identity: "turn:second", promptAt: at(20) }, registry: { live: true, status: "requires_action", statusUpdatedAt: at(21) } };
    expect(prev.state).toBe("waiting"); expect(next.state).toBe("waiting");
    expect(shouldNotify(prev, next, enabled, now)?.body).toBe("等待你的输入");
});

function persistedFixture(after: (cleanup: () => void) => void) {
    const directory = mkdtempSync("/private/tmp/__aimspan_fixture__-notification-review-");
    let store = new Store(directory, () => at(600));
    store.setSettings(enabled);
    let current = store.workspace();
    const core = { snapshot: () => current, call: async (request: CoreRequest) => {
        const result = store.call(request); current = store.workspace(); return result;
    } };
    let controller = new SessionNotifications(core, vi.fn());
    after(() => { controller.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });
    return {
        async observe(observation: Observation, publish = true) {
            store.observe(observation); current = store.workspace();
            if (publish) await controller.publish(current);
            return current.sessions[0]!;
        },
        async restart() {
            controller.stop(); store.close(); store = new Store(directory, () => at(600)); current = store.workspace();
            controller = new SessionNotifications(core, vi.fn()); await controller.publish(current);
        },
    };
}
const registryOnly: Observation = { agent: "claude-code", nativeId: "review-fixture", title: "评审合成会话", project: "/Users/__aimspan_fixture__/project",
    state: "working", at: at(0), lastPromptAt: at(0), confidence: "explicit", sources: [], version: "initial", turns: [], registry: { live: true, status: "busy", statusUpdatedAt: at(0) } };

test("R1 persisted registry-only wait, resume and late completion display each kind once", async ({ onTestFinished }) => {
    const f = persistedFixture(onTestFinished);
    await f.observe(registryOnly);
    await f.observe({ ...registryOnly, at: at(10), registry: { live: true, status: "waiting", statusUpdatedAt: at(10) } });
    expect(shown().map(n => n.options.body)).toEqual(["等待你的输入"]);
    await f.restart();
    await f.observe({ ...registryOnly, at: at(20), lastPromptAt: at(15), registry: { live: true, status: "requires_action", statusUpdatedAt: at(20) } });
    expect(shown()).toHaveLength(1);
    await f.observe({ ...registryOnly, at: at(60), lastPromptAt: at(60), registry: { live: true, status: "busy", statusUpdatedAt: at(60) } });
    await f.restart();
    const turn = { turnId: "same-turn", promptAt: at(0), endedAt: at(180), durationMs: 180_000, errors: [], changedFiles: [], failedCommands: [] };
    const completed: Observation = { ...registryOnly, at: at(180), turns: [turn], registry: { live: true, status: "idle", statusUpdatedAt: at(180) } };
    const first = await f.observe(completed);
    expect(first.lastPromptAt).toBe(at(60));
    expect(shown().map(n => n.options.body)).toEqual(["等待你的输入", "结束一轮"]);
    await f.restart();
    // Even a newly observed end timestamp cannot count this completed turn twice.
    const repeat = await f.observe({ ...completed, at: at(181), lastPromptAt: at(90), turns: [{ ...turn, endedAt: at(181), durationMs: 181_000 }], version: "extra-metadata" });
    expect(repeat.latestTurn?.identity).toBe(first.latestTurn?.identity);
    expect(shown()).toHaveLength(2);
});

test("R1 persisted short completion followed by approval waiting displays the new wait", async ({ onTestFinished }) => {
    const f = persistedFixture(onTestFinished);
    const turn = { turnId: "short-turn", promptAt: at(0), errors: [], changedFiles: [], failedCommands: [] };
    await f.observe({ ...registryOnly, turns: [turn] });
    const short = await f.observe({ ...registryOnly, at: at(10), turns: [{ ...turn, endedAt: at(10), durationMs: 10_000 }], registry: { live: true, status: "idle" } });
    expect(short.state).toBe("waiting"); expect(shown()).toHaveLength(0);
    const approval: Observation = { ...registryOnly, at: at(21), lastPromptAt: at(20), turns: [{ ...turn, turnId: "next-turn", promptAt: at(20) }], registry: { live: true, status: "needs_user" } };
    const waiting = await f.observe(approval);
    expect(waiting.state).toBe("waiting");
    expect(shown().map(n => n.options.body)).toEqual(["等待你的输入"]);
    await f.restart(); await f.observe({ ...approval, at: at(22) });
    expect(shown()).toHaveLength(1);
    // Core can observe a resume between publications; the persisted entry still reaches Main.
    await f.observe({ ...approval, at: at(30), registry: { live: true, status: "busy" } }, false);
    await f.observe({ ...approval, at: at(31) });
    expect(shown().map(n => n.options.body)).toEqual(["等待你的输入", "等待你的输入"]);
});

test("only a newly ended, known, non-aborted turn lasting at least two minutes qualifies", () => {
    expect(shouldNotify(running(), ended({ pendingIdeaCount: 2 }), enabled, now)).toEqual({ identity: "completion:turn:first", title: "会话 a", body: "结束一轮 · 你记了 2 条想法" });
    expect(shouldNotify(running(), ended(), enabled, now)?.body).toBe("结束一轮");
    for (const durationMs of [undefined, NaN, Infinity, -1, 0, 119_999])
        expect(shouldNotify(running(), ended({ latestTurn: { ...ended().latestTurn!, durationMs } }), enabled, now)).toBeNull();
    for (const durationMs of [120_000, 600_000])
        expect(shouldNotify(running(), ended({ latestTurn: { ...ended().latestTurn!, durationMs } }), enabled, now)).not.toBeNull();
    for (const patch of [
        { latestTurn: { ...ended().latestTurn!, aborted: true } }, { latestTurn: { promptAt: at(0), endedAt: at(120), durationMs: 120_000 } },
        { latestTurn: undefined }, { sourceUncertain: true }, { state: "unknown" as const }, { hasNewResult: false },
        { unmatchedCompletion: { endedAt: at(120) } }, { lastTurnEndAt: at(121) },
    ]) expect(shouldNotify(running(), ended(patch), enabled, now)).toBeNull();
    expect(shouldNotify(running(), ended(), enabled, Date.parse(at(119)))).toBeNull();
    expect(shouldNotify(undefined, ended(), enabled, now)).toBeNull();
    expect(shouldNotify(running({ nativeId: "different" }), ended(), enabled, now)).toBeNull();
});

test("metadata, idea counts, repeats, and older ends never create an event", () => {
    expect(shouldNotify(ended(), ended({ sourceVersion: "token-count-update", revision: 20, pendingIdeaCount: 4 }), enabled, now)).toBeNull();
    expect(shouldNotify(ended({ lastTurnEndAt: at(200) }), ended(), enabled, now)).toBeNull();
    expect(shouldNotify(running(), ended({ lastNotifiedIdentity: "completion:turn:first" }), enabled, now)).toBeNull();
    expect(shouldNotify(running(), ended({ lastNotifiedIdentity: "completion:turn:older" }), enabled, now)).not.toBeNull();
});

test("the same tray gate excludes automation, child, archived and inactive sessions", () => {
    for (const patch of [{ interactive: false }, { entrypoint: "codex_exec" }, { agent: "claude-code" as const, entrypoint: "sdk-cli" },
        { agent: "claude-code" as const, entrypoint: "sdk-ts" }, { agent: "claude-code" as const, entrypoint: "sdk-py" },
        { parentNativeId: "parent" }, { active: false }, { archived: true }]) {
        const next = ended(patch);
        expect(shouldNotify(running({ agent: next.agent }), next, enabled, now)).toBeNull();
    }
});

test.each([
    [true, undefined, true, false], [false, undefined, false, true],
    [true, false, true, false], [false, false, false, true],
    [true, true, false, false], [true, true, true, true],
    [false, true, false, false], [false, true, true, true],
])("bubble=%s explicit=%s saved=%s yields enabled=%s", (bubbleEnabled, explicit, notifications, expected) => {
    const settings: Settings = { ...enabled, bubbleEnabled: bubbleEnabled!, notifications: notifications!, ...(explicit === undefined ? {} : { notificationsExplicit: explicit }) };
    expect(!!shouldNotify(running(), ended(), settings, now)).toBe(expected);
});

test("DND suppresses until the exact shared expiry, regardless of explicit notification choice", () => {
    expect(shouldNotify(running(), ended(), { ...enabled, dndUntil: now + 1 }, now)).toBeNull();
    expect(shouldNotify(running(), ended(), { ...enabled, notificationsExplicit: true, dndUntil: now + 1 }, now)).toBeNull();
    expect(shouldNotify(running(), ended(), { ...enabled, dndUntil: now }, now)).not.toBeNull();
});

test("only a new live registry waiting transition qualifies without a two-minute duration", () => {
    const prev = running({ agent: "claude-code" });
    for (const status of ["waiting", "needs_user", "requires_action", "blocked"]) {
        const next = { ...prev, state: "waiting" as const, registryWaitingEntry: 1, registry: { live: true, status, statusUpdatedAt: at(1) } };
        expect(shouldNotify(prev, next, enabled, now)?.body).toBe("等待你的输入");
        expect(shouldNotify(prev, { ...next, pendingIdeaCount: 1 }, enabled, now)?.body).toBe("等待你的输入 · 你记了 1 条想法");
        expect(shouldNotify(next, { ...next, registry: { ...next.registry, statusUpdatedAt: at(2) } }, enabled, now)).toBeNull();
        expect(shouldNotify(prev, { ...next, lastNotifiedIdentity: "waiting:1" }, enabled, now)).toBeNull();
        expect(shouldNotify(prev, { ...next, registry: { ...next.registry, live: false } }, enabled, now)).toBeNull();
    }
    for (const status of ["busy", "idle", "paused", "needs_trust", "future", "toString"])
        expect(shouldNotify(prev, { ...prev, state: "waiting", registry: { live: true, status } }, enabled, now)).toBeNull();
    expect(shouldNotify(running(), { ...running(), state: "waiting", registry: { live: true, status: "waiting" } }, enabled, now)).toBeNull();
    const noTurn = { ...prev, latestTurn: undefined, state: "waiting" as const, registryWaitingEntry: 1, registry: { live: true, status: "waiting" } };
    expect(shouldNotify(prev, noTurn, enabled, now)?.identity).toBe("waiting:1");
    expect(shouldNotify(prev, { ...noTurn, lastPromptAt: undefined }, enabled, now)?.identity).toBe("waiting:1");
    const { registryWaitingEntry: _entry, ...missingEntry } = noTurn;
    expect(shouldNotify(prev, missingEntry, enabled, now)).toBeNull();
});

function fixture() {
    let current = { ...workspace([running()]), settings: enabled };
    const receipts = new Set<string>();
    const core = { snapshot: () => current, call: vi.fn(async (request: CoreRequest) => {
        if (request.method !== "notification.claim") throw new Error("Unexpected call");
        const key = JSON.stringify([request.sessionId, request.identity]);
        if (receipts.has(key)) return false;
        receipts.add(key);
        current = { ...current, sessions: current.sessions.map(s => s.id === request.sessionId ? { ...s, lastNotifiedIdentity: request.identity } : s) };
        return true;
    }) };
    const open = vi.fn();
    const controller = new SessionNotifications(core, open);
    return { core, open, controller, receipts, snapshot: () => current,
        publish: (next: Session, settings = current.settings) => { current = { ...current, sessions: [next], settings }; return controller.publish(current); } };
}

test("receipt precedes display, concurrent publishes do not duplicate, and clicks use explicit panel navigation", async () => {
    const f = fixture();
    await f.controller.publish(f.snapshot());
    let release!: (value: boolean) => void;
    f.core.call.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const delivery = f.publish(ended());
    expect(shown()).toHaveLength(0);
    await f.publish(ended({ sourceVersion: "extra-metadata" }));
    expect(f.core.call).toHaveBeenCalledOnce();
    release(true); await delivery;
    expect(shown()).toHaveLength(1); expect(shown()[0]!.show).toHaveBeenCalledOnce();
    expect(shown()[0]!.options).toEqual({ title: "会话 a", body: "结束一轮" });
    expect(f.open).not.toHaveBeenCalled();
    shown()[0]!.emit("click"); expect(f.open).toHaveBeenCalledExactlyOnceWith({ kind: "session", sessionId: "a" });
    f.controller.stop(); expect(shown()[0]!.close).toHaveBeenCalledOnce();
    shown()[0]!.emit("click"); expect(f.open).toHaveBeenCalledOnce();
});

test("waiting entries and completion have independent receipts across restart", async () => {
    const f = fixture();
    const prev = running({ agent: "claude-code" });
    await f.publish(prev);
    const waiting = { ...prev, state: "waiting" as const, registryWaitingEntry: 1, registry: { live: true, status: "waiting" } };
    await f.publish(waiting);
    expect(shown()).toHaveLength(1);
    const resumed = { ...prev, lastPromptAt: at(60), registryWaitingEntry: 1, registry: { live: true, status: "busy", statusUpdatedAt: at(60) } };
    await f.publish(resumed);
    // A second approval in the same native turn gets its own entry receipt.
    await f.publish({ ...waiting, lastPromptAt: at(60), registryWaitingEntry: 2 });
    expect(shown()).toHaveLength(2);
    await f.publish(resumed);
    const completed = ended({ agent: "claude-code", lastPromptAt: at(60) });
    await f.publish(completed);
    expect(shown()).toHaveLength(3);
    expect(shown().map(n => n.options.body)).toEqual(["等待你的输入", "等待你的输入", "结束一轮"]);
    f.controller.stop();
    const restarted = new SessionNotifications(f.core, f.open);
    await restarted.publish(f.snapshot());
    await restarted.publish({ ...f.snapshot(), sessions: [prev] });
    await restarted.publish({ ...f.snapshot(), sessions: [completed] });
    expect(shown()).toHaveLength(3);
    for (const identity of ["waiting:1", "waiting:2", notificationIdentity(completed, "completion")])
        expect(f.receipts.has(JSON.stringify(["a", identity]))).toBe(true);
    restarted.stop();
});

test("disabled and DND events are not queued for later delivery", async () => {
    for (const settings of [{ ...enabled, notificationsExplicit: true, notifications: false }, { ...enabled, dndUntil: now + 1000 }]) {
        const f = fixture(); await f.publish(running(), settings); await f.publish(ended(), settings);
        await f.publish(ended(), enabled);
        expect(f.core.call).not.toHaveBeenCalled(); f.controller.stop();
    }
    expect(shown()).toHaveLength(0);
});

test("failed receipt, unsupported OS, or a DND change while saving never displays", async () => {
    const f = fixture(); await f.controller.publish(f.snapshot());
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    f.core.call.mockRejectedValueOnce(new Error("disk unavailable"));
    await f.publish(ended()); expect(shown()).toHaveLength(0); expect(error).toHaveBeenCalledOnce();
    vi.mocked(Notification.isSupported).mockReturnValue(false);
    await f.publish(running()); await f.publish(ended()); expect(f.core.call).toHaveBeenCalledOnce();
    vi.mocked(Notification.isSupported).mockReturnValue(true);
    await f.publish(running());
    let release!: (value: boolean) => void;
    f.core.call.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const delivery = f.publish(ended());
    await f.publish(ended(), { ...enabled, dndUntil: now + 1000 });
    release(true); await delivery;
    expect(shown()).toHaveLength(0); f.controller.stop();
});

test("T23 notifications use current settings and English singular/plural wording", () => {
    expect(shouldNotify(running(), ended({ pendingIdeaCount: 1 }), { ...enabled, language: "en" }, now)?.body).toBe("Finished a turn · You saved 1 idea");
    expect(shouldNotify(running(), ended({ pendingIdeaCount: 2 }), { ...enabled, language: "en" }, now)?.body).toBe("Finished a turn · You saved 2 ideas");
    expect(shouldNotify(running(), ended({ pendingIdeaCount: 2 }), { ...enabled, language: "zh" }, now)?.body).toBe("结束一轮 · 你记了 2 条想法");
});
