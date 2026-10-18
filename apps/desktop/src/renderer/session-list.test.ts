import { expect, test } from "vitest";
import { session } from "../../test/panel-fixtures";
import { compactSessions, freezeOrder, sortSessions, sessionGroup, groupSessions, freezeGroups, sessionRows } from "./session-list";

test("compact puts pins in any state first, then waiting oldest and running newest; respects active root scope", () => {
    const rows = [session("idle", { state: "idle" }), session("unknown", { state: "unknown" }),
        session("new-waiting", { lastTurnEndAt: "2026-10-16T08:00:00Z" }),
        session("old-waiting", { lastTurnEndAt: "2026-10-16T07:00:00Z" }),
        session("old-running", { state: "running", lastPromptAt: "2026-10-16T06:00:00Z" }),
        session("new-running", { state: "running", lastPromptAt: "2026-10-16T08:00:00Z" }),
        ...(["waiting", "running", "idle", "unknown"] as const).map(state => session(`pinned-${state}`, { state, pinned: true })),
        session("automatic", { interactive: false, pinned: true }), session("automation", { surface: "automation", pinned: true }),
        session("archived", { archived: true, pinned: true }), session("inactive", { active: false }),
        session("child", { parentNativeId: "old-waiting", pinned: true })];
    const result = compactSessions(rows);
    expect(result.slice(0, 4).every(s => s.pinned)).toBe(true);
    expect(result.map(s => s.id)).toEqual(["pinned-waiting", "pinned-running", "pinned-idle", "pinned-unknown", "old-waiting", "new-waiting", "new-running", "old-running"]);
    expect(rows[0]!.id).toBe("idle");
});

test("waiting oldest end, running newest prompt, then other newest activity", () => {
    const rows = [session("old-idle", { state: "idle", lastActivityAt: "2026-10-16T07:00:00Z" }),
        session("new-running", { state: "running", lastPromptAt: "2026-10-16T08:30:00Z" }),
        session("new-waiting", { lastTurnEndAt: "2026-10-16T08:00:00Z" }),
        session("old-waiting", { lastTurnEndAt: "2026-10-16T07:00:00Z" }),
        session("unknown", { state: "unknown", lastActivityAt: "2026-10-16T09:00:00Z", lastPromptAt: "2026-10-10" }),
        session("old-running", { state: "running", lastPromptAt: "2026-10-16T06:00:00Z" })];
    expect(sortSessions(rows).map(s => s.id)).toEqual(["old-waiting", "new-waiting", "new-running", "old-running", "unknown", "old-idle"]);
});
test("freeze keeps stable keys while allowing filtering and appending new rows", () => {
    expect(freezeOrder(["a", "b", "c"], ["c", "d", "a"])).toEqual(["a", "c", "d"]);
    expect(freezeOrder(["a", "b"], ["b", "a"])).toEqual(["a", "b"]);
});

test("T14 local calendar buckets prioritize yesterday, start weeks on Monday and handle midnight", () => {
    const local = (month: number, day: number, hour = 0, minute = 0) => new Date(2026, month - 1, day, hour, minute).toISOString();
    const bucket = (at: string, now: string) => sessionGroup(session("a", { lastActivityAt: at }), Date.parse(now));
    const monday = local(10, 19, 12);
    expect(bucket(local(10, 19), monday)).toBe("today");
    expect(bucket(local(10, 18, 23, 59), monday)).toBe("yesterday");
    expect(bucket(local(10, 17, 23, 59), monday)).toBe("earlier");
    const wednesday = local(10, 21, 12);
    expect(bucket(local(10, 20), wednesday)).toBe("yesterday");
    expect(bucket(local(10, 19), wednesday)).toBe("thisWeek");
    expect(bucket(local(10, 18, 23, 59), wednesday)).toBe("earlier");
    expect(bucket(local(10, 19, 23, 59), local(10, 20))).toBe("yesterday");
    expect(bucket(local(10, 20), local(10, 20))).toBe("today");
    expect(bucket(local(10, 19), local(10, 25, 12))).toBe("thisWeek");
    // These also exercise 23/25-hour days when run with TZ=America/New_York.
    expect(bucket(local(3, 8), local(3, 9))).toBe("yesterday");
    expect(bucket(local(11, 1), local(11, 2))).toBe("yesterday");
    expect(sessionGroup(session("fallback", { lastActivityAt: undefined, observedAt: monday }), Date.parse(monday))).toBe("today");
    expect(bucket("invalid", monday)).toBe("earlier");
});

test("T14 groups by activity and keeps state sorting inside each group; frozen groups hold membership", () => {
    const now = new Date(2026, 9, 21, 12).getTime();
    const at = (day: number, hour = 0) => new Date(2026, 9, day, hour).toISOString();
    const rows = sortSessions([
        session("old-waiting", { lastActivityAt: at(1) }),
        session("today-idle", { state: "idle", lastActivityAt: at(21) }),
        session("today-running", { state: "running", lastActivityAt: at(21) }),
        session("yesterday", { lastActivityAt: at(20) }),
        session("monday", { lastActivityAt: at(19) }),
        session("today-waiting", { lastActivityAt: at(21) }),
    ]);
    const grouped = groupSessions(rows, now);
    expect(grouped).toEqual([
        { label: "today", ids: ["today-waiting", "today-running", "today-idle"] },
        { label: "yesterday", ids: ["yesterday"] }, { label: "thisWeek", ids: ["monday"] }, { label: "earlier", ids: ["old-waiting"] },
    ]);
    expect(groupSessions([], now)).toEqual([]);
    const next = [{ label: "today", ids: ["yesterday", "arrival", "today-idle"] }, { label: "earlier", ids: ["old-waiting"] }];
    expect(freezeGroups(grouped, next)).toEqual([
        { label: "today", ids: ["today-idle", "arrival"] }, { label: "yesterday", ids: ["yesterday"] }, { label: "earlier", ids: ["old-waiting"] },
    ]);
});

test("T21 review: a handled parent is not folded back to waiting by a child that ended before handling", () => {
    const parent = session("p", { nativeId: "parent", state: "idle", lastViewedAt: "2026-10-18T10:00:00Z", handledAt: "2026-10-18T10:30:00Z", lastPromptAt: "2026-10-18T09:00:00Z" });
    const child = session("c", { nativeId: "child", parentNativeId: "parent", state: "idle", lastTurnEndAt: "2026-10-18T10:15:00Z" });
    const rows = sessionRows([parent, child]);
    expect(rows.find(s => s.id === "p")!.state).toBe("idle");
});
