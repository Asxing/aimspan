import type { Point } from "./bubble-geometry";

export const HOVER_DWELL_MS = 350;
export const HOVER_SPEED_WINDOW_MS = 100;
export const HOVER_MAX_SPEED = 0.1; // screen pixels per millisecond, strictly below

export type PointerSample = Point & { at: number; inside: boolean; buttons: number | null };
type TimedPoint = Point & { at: number };
export type HoverIntent = {
    phase: "outside" | "tracking" | "ready" | "suppressed";
    samples: readonly TimedPoint[];
    buttons: number | null;
    slowSince: number | undefined;
};
export const initialHoverIntent = (): HoverIntent => ({ phase: "outside", samples: [], buttons: null, slowSince: undefined });

/** Pure transition: caller supplies time, coordinates and observed button state.
 * null is an unavailable button observation, not a release. A known held button
 * stays held for this visit until a renderer event reports its release.
 */
export function sampleHoverIntent(state: HoverIntent, sample: PointerSample): HoverIntent {
    if (!sample.inside) return initialHoverIntent();
    if (state.phase === "suppressed") return state;
    const previous = state.samples.at(-1);
    if (previous && sample.at < previous.at) state = initialHoverIntent();
    const buttons = sample.buttons ?? state.buttons;
    const samples = [...state.samples, { x: sample.x, y: sample.y, at: sample.at }];
    const cutoff = sample.at - HOVER_SPEED_WINDOW_MS;
    // Retain the point before the window boundary so its crossing segment can
    // be interpolated. Sum path length, not displacement (jitter can return home).
    while (samples.length > 2 && samples[1]!.at <= cutoff) samples.shift();
    let distance = 0;
    for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1]!, b = samples[i]!;
        const fraction = b.at === a.at ? 1 : (b.at - Math.max(a.at, cutoff)) / (b.at - a.at);
        distance += Math.hypot(b.x - a.x, b.y - a.y) * fraction;
    }
    const elapsed = sample.at - Math.max(samples[0]!.at, cutoff);
    const speed = elapsed > 0 ? distance / elapsed : distance === 0 ? 0 : Infinity;
    const slowSince = (buttons === null || buttons === 0) && speed < HOVER_MAX_SPEED ? state.slowSince ?? sample.at : undefined;
    return { phase: slowSince !== undefined && sample.at - slowSince >= HOVER_DWELL_MS ? "ready" : "tracking", samples, buttons, slowSince };
}

/** Explicit dismissal must not reopen under a stationary pointer. */
export function suppressHoverIntent(state: HoverIntent): HoverIntent {
    return state.phase === "outside" ? state : { ...state, phase: "suppressed", slowSince: undefined };
}
