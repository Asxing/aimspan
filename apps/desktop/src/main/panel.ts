import type { BubblePosition, Session } from "@aimspan/protocol";
import { attentionCounts } from "./attention-counts";
import { attentionTitle } from "../status-symbols";
import { bubbleAnchoredBounds, nearestDisplay, restore, type BubbleDisplay, type Rect } from "./bubble-geometry";

/** `avoid` is a pinned compact list that stays open; the panel opens beside it instead of under it. */
export type PanelAnchor = { kind: "tray" } | { kind: "bubble"; position: BubblePosition; avoid?: Rect };

/** Main retains the explicit opening source for subsequent resize/display events. */
export class PanelPlacement {
    private anchor: PanelAnchor = { kind: "tray" };
    select(anchor: PanelAnchor) { this.anchor = anchor; }
    bounds(current: Rect, pinned: boolean, displays: readonly BubbleDisplay[], tray?: Rect): Rect {
        if (pinned) return current;
        if (this.anchor.kind === "bubble") {
            const bounds = bubbleAnchoredBounds(restore(this.anchor.position, displays), displays, { width: 420, height: current.height });
            return this.anchor.avoid ? beside(bounds, this.anchor.avoid, displays) : bounds;
        }
        if (!tray) return current;
        const display = nearestDisplay({ x: tray.x + tray.width / 2, y: tray.y + tray.height / 2 }, displays);
        return anchoredBounds(tray, display.workArea ?? display.bounds, current.height);
    }
}

function overlaps(a: Rect, b: Rect) { return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height; }

/** Move the panel to the outer side of an open pinned list, clamped to the same work area. */
export function beside(panel: Rect, list: Rect, displays: readonly BubbleDisplay[]): Rect {
    if (!overlaps(panel, list)) return panel;
    const display = nearestDisplay({ x: list.x + list.width / 2, y: list.y + list.height / 2 }, displays);
    const area = display.workArea ?? display.bounds, gap = 6;
    const leftX = list.x - gap - panel.width, rightX = list.x + list.width + gap;
    // Keep growing away from the bubble: the list sits between the bubble and the panel.
    const preferLeft = panel.x + panel.width / 2 <= list.x + list.width / 2;
    const fitsLeft = leftX >= area.x, fitsRight = rightX + panel.width <= area.x + area.width;
    const x = preferLeft ? (fitsLeft ? leftX : fitsRight ? rightX : leftX) : (fitsRight ? rightX : fitsLeft ? leftX : rightX);
    return { ...panel, x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - panel.width))) };
}

export function trayTitle(sessions: readonly Session[]): string {
    return attentionTitle(attentionCounts(sessions));
}

export function anchoredBounds(tray: Rect, area: Rect, height: number): Rect {
    const width = Math.min(420, area.width);
    height = Math.min(height, area.height);
    return {
        x: Math.round(Math.max(area.x, Math.min(tray.x + tray.width / 2 - width / 2, area.x + area.width - width))),
        y: Math.max(area.y, Math.min(tray.y + tray.height, area.y + area.height - height)),
        width, height,
    };
}
