// @vitest-environment node
import { expect, test } from "vitest";
import { initialHoverIntent, sampleHoverIntent, suppressHoverIntent, type HoverIntent, type PointerSample } from "./bubble-intent";

const sample = (state: HoverIntent, at: number, extra: Partial<PointerSample> = {}) => sampleHoverIntent(state, { at, x: 0, y: 0, inside: true, buttons: null, ...extra });

test.each([null, 0])("stationary rest opens at 350ms with buttons=%s, without renderer movement", buttons => {
    let state = initialHoverIntent();
    for (const at of [0, 50, 100, 200, 300, 349]) {
        state = sample(state, at, { buttons });
        expect(state.phase).toBe("tracking");
    }
    expect(sample(state, 350, { buttons }).phase).toBe("ready");
});

test("fast pass-through and fast back-and-forth motion never open even when buttons are unknown", () => {
    let state = sample(initialHoverIntent(), 0);
    state = sample(state, 50, { x: 30 });
    expect(state.slowSince).toBeUndefined();
    state = sample(state, 80, { inside: false });
    expect(state.phase).toBe("outside");
    for (let at = 100; at <= 1000; at += 50) {
        state = sample(state, at, { x: at % 100 ? 30 : 0 });
        expect(state.phase).toBe("tracking");
    }
});

test("slow motion below 0.1px/ms qualifies; the exact speed boundary does not", () => {
    let slow = initialHoverIntent(), boundary = initialHoverIntent();
    for (let at = 0; at <= 350; at += 50) {
        slow = sample(slow, at, { x: at * 0.08, buttons: 0 });
        boundary = sample(boundary, at, { x: at * 0.1, buttons: 0 });
    }
    expect(slow.phase).toBe("ready");
    expect(boundary.phase).toBe("tracking");
});

test("a fast sample restarts the full slow dwell after it leaves the last 100ms window", () => {
    let state = sample(initialHoverIntent(), 0);
    state = sample(state, 250);
    state = sample(state, 300, { x: 30 });
    state = sample(state, 350, { x: 30 });
    expect(state.slowSince).toBeUndefined();
    state = sample(state, 400, { x: 30 });
    expect(state.slowSince).toBe(400);
    state = sample(state, 749, { x: 30 });
    expect(state.phase).toBe("tracking");
    expect(sample(state, 750, { x: 30 }).phase).toBe("ready");
});

test.each([1, 2, 4, 8, 16, 3])("held buttons=%s cancel dwell and remain held through unknown polls until release", buttons => {
    let state = sample(initialHoverIntent(), 0, { buttons: 0 });
    state = sample(state, 300, { buttons });
    for (let at = 350; at <= 1000; at += 50) {
        state = sample(state, at);
        expect(state.phase).toBe("tracking");
        expect(state.buttons).toBe(buttons);
    }
    state = sample(state, 1050, { buttons: 0 });
    expect(sample(state, 1399).phase).toBe("tracking");
    expect(sample(state, 1400).phase).toBe("ready");
});

test("leaving discards dwell and button observations; re-entry needs a new full rest", () => {
    let state = sample(initialHoverIntent(), 0, { buttons: 1 });
    state = sample(state, 300, { inside: false });
    expect(state).toEqual(initialHoverIntent());
    state = sample(state, 400);
    expect(sample(state, 749).phase).toBe("tracking");
    expect(sample(state, 750).phase).toBe("ready");
});

test("dismissal suppresses reopening until leave/re-enter; transitions do not mutate their input", () => {
    const original = sample(initialHoverIntent(), 0);
    const saved = structuredClone(original);
    let state = suppressHoverIntent(sample(original, 350));
    expect(sample(state, 2000).phase).toBe("suppressed");
    state = sample(state, 2050, { inside: false });
    state = sample(state, 2100);
    expect(sample(state, 2450).phase).toBe("ready");
    expect(original).toEqual(saved);
});

test("same-time events do not erase motion, and irregular samples clip path length at the window edge", () => {
    let state = sample(initialHoverIntent(), 0);
    state = sample(state, 0, { x: 20 });
    expect(state.slowSince).toBeUndefined();
    state = sample(state, 60, { x: 40 });
    state = sample(state, 150, { x: 40 });
    expect(state.slowSince).toBe(150); // only 10/60 of the moving segment remains
    expect(state.samples).toHaveLength(3);
    state = sample(state, 200, { x: 40 });
    expect(state.samples[0]!.at).toBe(60);
});
