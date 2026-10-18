import type { BubblePosition } from "@aimspan/protocol";

export type Point = { x: number; y: number };
export type Rect = Point & { width: number; height: number };
export type BubbleDisplay = { bounds: Rect; workArea?: Rect; primary?: boolean };
export const DIAMETER = 56;
export const RADIUS = DIAMETER / 2;
export const COMPACT_WIDTH = 340;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(n, Math.max(min, max)));
const workArea = (display: BubbleDisplay) => display.workArea ?? display.bounds;
const edge = (area: Rect, side: "left" | "right") => side === "left" ? area.x : area.x + area.width;
// Dock insets move the snap point, but never turn an inter-display seam into an outer edge.
const outer = (display: BubbleDisplay, side: "left" | "right", displays: readonly BubbleDisplay[]) =>
    edge(display.bounds, side) === (side === "left" ? Math.min : Math.max)(...displays.map(d => edge(d.bounds, side)));
export function contains(rect: Rect, p: Point): boolean {
    return p.x >= rect.x && p.x < rect.x + rect.width && p.y >= rect.y && p.y < rect.y + rect.height;
}
function primary(displays: readonly BubbleDisplay[]): BubbleDisplay {
    const display = displays.find(d => d.primary) ?? displays[0];
    if (!display) throw new Error("desktop.errorNoDisplayAvailable");
    return display;
}
export function nearestDisplay(point: Point, displays: readonly BubbleDisplay[]): BubbleDisplay {
    const distance = ({ bounds: r }: BubbleDisplay) => Math.hypot(point.x - clamp(point.x, r.x, r.x + r.width), point.y - clamp(point.y, r.y, r.y + r.height));
    return [...displays].sort((a, b) => distance(a) - distance(b))[0] ?? primary(displays);
}
function fit(point: Point, display: BubbleDisplay): Point {
    const area = workArea(display);
    return { x: Math.round(clamp(point.x, area.x, area.x + area.width - DIAMETER)), y: Math.round(clamp(point.y, area.y, area.y + area.height - DIAMETER)) };
}
/** dropPoint is the circle's top-left. Outer displays snap at their work-area edges. */
export function snap(dropPoint: Point, displays: readonly BubbleDisplay[]): BubblePosition {
    for (const side of ["left", "right"] as const) {
        const display = displays.find(d => outer(d, side, displays) &&
            Math.abs((side === "left" ? dropPoint.x : dropPoint.x + DIAMETER) - edge(workArea(d), side)) <= 24 &&
            dropPoint.y + RADIUS >= d.bounds.y && dropPoint.y + RADIUS < d.bounds.y + d.bounds.height);
        if (display) return { x: edge(workArea(display), side) - RADIUS, y: fit(dropPoint, display).y, side };
    }
    return { ...fit(dropPoint, nearestDisplay({ x: dropPoint.x + RADIUS, y: dropPoint.y + RADIUS }, displays)), side: "free" };
}
/** A saved snapped position is reachable when its revealed circle fits on that display. */
export function restore(saved: BubblePosition | undefined, displays: readonly BubbleDisplay[]): BubblePosition {
    if (saved) for (const d of displays) {
        const snapEdge = edge(workArea(d), saved.side === "left" ? "left" : "right");
        const x = saved.side === "free" ? saved.x : saved.side === "left" ? snapEdge : snapEdge - DIAMETER;
        const fitted = fit({ x, y: saved.y }, d);
        // Positions persisted by the 44px bubble retain their edge and height.
        const legacyEdge = saved.side !== "free" && saved.x === snapEdge - 22;
        const onEdge = saved.x === snapEdge - RADIUS || legacyEdge;
        const area = workArea(d);
        const reachableY = fitted.y === saved.y || legacyEdge && saved.y >= area.y && saved.y + 44 <= area.y + area.height;
        if ((saved.side === "free" || outer(d, saved.side, displays) && onEdge) && fitted.x === x && reachableY)
            return { ...saved, x: saved.side === "free" ? saved.x : snapEdge - RADIUS, y: fitted.y };
    }
    const display = primary(displays), area = workArea(display);
    return { x: edge(area, "right") - RADIUS, y: fit({ x: area.x, y: area.y + area.height / 2 - RADIUS }, display).y, side: "right" };
}
/**
 * Use a 112x56 fully on-screen transparent window, rather than trusting macOS to
 * accept off-screen setPosition. CSS clips the circle at +/-28px of the edge.
 * Hover slides only the circle; the native window never moves or takes focus.
 */
export function bubbleFrame(position: BubblePosition, displays: readonly BubbleDisplay[], revealed: boolean): { bounds: Rect; circleX: number } {
    const display = nearestDisplay({ x: position.x + RADIUS + (position.side === "right" ? -1 : 0), y: position.y + RADIUS }, displays);
    const area = workArea(display), fitted = fit(position, display);
    const width = Math.min(DIAMETER * 2, area.width);
    const x = Math.round(clamp(position.x - RADIUS, area.x, area.x + area.width - width));
    const circleX = position.side === "left" ? (revealed ? 0 : -RADIUS) : position.side === "right" ? width - (revealed ? DIAMETER : RADIUS) : fitted.x - x;
    return { bounds: { x, y: fitted.y, width, height: DIAMETER }, circleX };
}
export function compactBounds(position: BubblePosition, displays: readonly BubbleDisplay[], rows: number): Rect {
    return bubbleAnchoredBounds(position, displays, { width: COMPACT_WIDTH, height: 74 + Math.max(1, Math.min(8, rows)) * 62 });
}
/**
 * bubble is the revealed circle's screen rect, not its transparent native window.
 * Free bubbles use the roomier side (right on a tie); the vertical midpoint
 * belongs to the bottom half. Clamp last, prioritizing visibility over the gap
 * if the requested size cannot fit beside the bubble.
 */
export function popoverBounds(bubble: Rect & { side: BubblePosition["side"] }, size: { width: number; height: number }, area: Rect): Rect {
    const width = Math.min(size.width, area.width), height = Math.min(size.height, area.height);
    const leftRoom = bubble.x - area.x, rightRoom = area.x + area.width - (bubble.x + bubble.width);
    const toLeft = bubble.side === "right" || (bubble.side === "free" && leftRoom > rightRoom);
    const x = toLeft ? bubble.x - width - 6 : bubble.x + bubble.width + 6;
    const y = bubble.y + bubble.height / 2 < area.y + area.height / 2 ? bubble.y : bubble.y + bubble.height - height;
    return { x: Math.round(clamp(x, area.x, area.x + area.width - width)), y: Math.round(clamp(y, area.y, area.y + area.height - height)), width, height };
}
/** Place either surface beside the revealed circle on the bubble's display. */
export function bubbleAnchoredBounds(position: BubblePosition, displays: readonly BubbleDisplay[], size: { width: number; height: number }): Rect {
    const { bounds, circleX } = bubbleFrame(position, displays, true);
    const display = nearestDisplay({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, displays);
    return popoverBounds({ x: bounds.x + circleX, y: bounds.y, width: DIAMETER, height: DIAMETER, side: position.side }, size, workArea(display));
}
export function bubbleOpacity(side: BubblePosition["side"], hovered: boolean, dnd = false): number { return dnd ? 0.45 : hovered ? 1 : side === "free" ? 0.35 : 0.7; }
export function isDrag(start: Point, end: Point): boolean { return Math.hypot(end.x - start.x, end.y - start.y) >= 4; }
