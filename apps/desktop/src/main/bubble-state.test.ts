// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";
import { session } from "../../test/panel-fixtures";
import { BubbleInteraction, visualState } from "./bubble-state";
import { trayTitle } from "./panel";
import { attentionCounts } from "./attention-counts";
afterEach(() => vi.useRealTimers());
test.each([[0, 0], [2, 0], [0, 3], [2, 3]])("shared count contract: %i running + %i waiting", (running, waiting) => {
    const sessions = [
        ...Array.from({ length: running }, (_, i) => session(`running-${i}`, { state: "running" })),
        ...Array.from({ length: waiting }, (_, i) => session(`waiting-${i}`)),
        session("idle", { state: "idle" }), session("unknown", { state: "unknown" }),
        session("hidden-running", { state: "running", active: false }),
    ];
    expect(attentionCounts(sessions)).toEqual({ running, waiting });
    expect(visualState(sessions, undefined)).toMatchObject({ running, waiting });
    expect(trayTitle(sessions)).toBe([running && `🟢${running}`, waiting && `🟠${waiting}`].filter(Boolean).join(" "));
});
test("bubble derives the same counts as the tray and never pulses on initial history or regressions", () => {
    const sessions = [session("waiting", { lastTurnEndAt: "2026-10-16T08:00:00Z" }), session("running", { state: "running" }),
        session("auto", { interactive: false }), session("exec", { entrypoint: "codex_exec" }), session("sdk", { agent: "claude-code", entrypoint: "sdk-cli" }),
        session("child", { parentNativeId: "waiting" }), session("archived", { archived: true }), session("inactive", { active: false })];
    const initial = visualState(sessions, undefined);
    expect(trayTitle(sessions)).toBe("🟢1 🟠1");
    expect(initial).toMatchObject({ waiting: 1, running: 1, pulse: false });
    expect(visualState(sessions, initial.lastEnd).pulse).toBe(false);
    expect(visualState([], initial.lastEnd)).toMatchObject({ waiting: 0, running: 0, pulse: false, lastEnd: initial.lastEnd });
    sessions[0]!.lastTurnEndAt = "2026-10-16T08:02:00Z";
    expect(visualState(sessions, initial.lastEnd).pulse).toBe(true);
});
test("350ms sampled rest opens; crossing between surfaces cancels the 500ms dismissal", () => {
    vi.useFakeTimers(); const changed = vi.fn(), interaction = new BubbleInteraction(changed);
    const sample = (at: number) => interaction.sample({ at, x: 0, y: 0, inside: true, buttons: null });
    sample(0); sample(349); expect(interaction.open).toBe(false);
    sample(350); expect(interaction.open).toBe(true);
    interaction.hover("bubble", false); vi.advanceTimersByTime(400);
    interaction.hover("list", true); vi.advanceTimersByTime(500); expect(interaction.open).toBe(true);
    interaction.hover("list", false); vi.advanceTimersByTime(499); expect(interaction.open).toBe(true);
    vi.advanceTimersByTime(1); expect(interaction.open).toBe(false);
    interaction.stop();
});
test("short hover cancels, header pin survives close/reopen, unpin closes, and stop cancels timers", () => {
    vi.useFakeTimers(); const interaction = new BubbleInteraction(vi.fn());
    const sample = (at: number, inside = true) => interaction.sample({ at, x: 0, y: 0, inside, buttons: 0 });
    sample(0); sample(349); sample(350, false);
    vi.advanceTimersByTime(1000); expect(interaction.open).toBe(false);
    interaction.toggle(); interaction.togglePinned(); interaction.hover("list", true); interaction.hover("list", false);
    vi.advanceTimersByTime(1000); expect(interaction.pinned).toBe(true); expect(interaction.open).toBe(true);
    interaction.close(); expect(interaction.open).toBe(false); expect(interaction.pinned).toBe(true);
    interaction.toggle(); expect(interaction.open).toBe(true); expect(interaction.pinned).toBe(true);
    interaction.togglePinned(); expect(interaction.open).toBe(false); expect(interaction.pinned).toBe(false);
    sample(400); interaction.close(); sample(1000); expect(interaction.open).toBe(false);
    interaction.reset(); sample(1100); sample(1450); expect(interaction.open).toBe(true);
    sample(1500, false); interaction.stop(); vi.advanceTimersByTime(1000); expect(interaction.open).toBe(true);
});
test("click-open waits for list entry, then closes after 1s outside both surfaces", () => {
    vi.useFakeTimers(); const interaction = new BubbleInteraction(vi.fn());
    interaction.toggle(); expect(interaction.pinned).toBe(false);
    interaction.hover("bubble", true); interaction.hover("bubble", false);
    vi.advanceTimersByTime(5000); expect(interaction.open).toBe(true);
    interaction.hover("list", true); interaction.hover("list", false);
    vi.advanceTimersByTime(999); expect(interaction.open).toBe(true);
    vi.advanceTimersByTime(1); expect(interaction.open).toBe(false);
    // Each new click-open must earn its own first list entry.
    interaction.toggle(); interaction.hover("bubble", true); interaction.hover("bubble", false);
    vi.advanceTimersByTime(5000); expect(interaction.open).toBe(true);
    interaction.stop();
});
test.each(["bubble", "list"] as const)("re-entering %s cancels the click-open timeout and restarts a full second", surface => {
    vi.useFakeTimers(); const interaction = new BubbleInteraction(vi.fn());
    interaction.toggle(); interaction.hover("list", true); interaction.hover("list", false);
    vi.advanceTimersByTime(900); interaction.hover(surface, true);
    vi.advanceTimersByTime(1000); expect(interaction.open).toBe(true);
    interaction.hover(surface, false); vi.advanceTimersByTime(999); expect(interaction.open).toBe(true);
    vi.advanceTimersByTime(1); expect(interaction.open).toBe(false);
});
test("completed actions close hover/click opens, pin cancels pending close, explicit bubble click always closes", () => {
    vi.useFakeTimers(); const interaction = new BubbleInteraction(vi.fn());
    interaction.sample({ at: 0, x: 0, y: 0, inside: true, buttons: 0 });
    interaction.sample({ at: 350, x: 0, y: 0, inside: true, buttons: 0 });
    interaction.actionCompleted(); expect(interaction.open).toBe(false);
    interaction.toggle(); interaction.actionCompleted(); expect(interaction.open).toBe(false);
    interaction.toggle(); interaction.hover("bubble", false); interaction.hover("list", true); interaction.hover("list", false);
    vi.advanceTimersByTime(900); interaction.togglePinned();
    vi.advanceTimersByTime(5000); interaction.actionCompleted(); expect(interaction.open).toBe(true);
    interaction.toggle(); expect(interaction.open).toBe(false);
    interaction.toggle(); expect(interaction.open).toBe(true);
    interaction.togglePinned(); expect(interaction.open).toBe(false);
    expect(new BubbleInteraction(vi.fn()).pinned).toBe(false);
});
