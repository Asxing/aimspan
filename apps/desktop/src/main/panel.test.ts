// @vitest-environment node
import { expect, test } from "vitest";
import { session } from "../../test/panel-fixtures";
import { anchoredBounds, beside, PanelPlacement, trayTitle } from "./panel";
import type { BubbleDisplay } from "./bubble-geometry";

test("tray title omits zero parts and counts only active interactive roots", () => {
    expect(trayTitle([])).toBe("");
    expect(trayTitle([session("a", { state: "running" })])).toBe("🟢1");
    expect(trayTitle([session()])).toBe("🟠1");
    expect(trayTitle([session(), session("b", { state: "running" }), session("c", { state: "running" }),
        session("child", { parentNativeId: "a" }), session("orphan", { isChild: true, state: "running" }), session("auto", { interactive: false }), session("exec", { entrypoint: "codex_exec" }),
        session("archived", { archived: true }), session("removed", { active: false }), session("idle", { state: "idle" })])).toBe("🟢2 🟠1");
});
test("panel anchors below the tray and stays within the tray's display work area", () => {
    expect(anchoredBounds({ x: 900, y: 0, width: 22, height: 24 }, { x: 0, y: 24, width: 1440, height: 876 }, 640)).toEqual({ x: 701, y: 24, width: 420, height: 640 });
    expect(anchoredBounds({ x: -15, y: 0, width: 22, height: 24 }, { x: -1024, y: 24, width: 1024, height: 576 }, 640)).toEqual({ x: -420, y: 24, width: 420, height: 576 });
});

const primary: BubbleDisplay = { bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 24, width: 1440, height: 876 }, primary: true };
const current = { x: 500, y: 24, width: 420, height: 640 };
const tray = { x: 900, y: 0, width: 22, height: 24 };
test.each([
    [{ x: 1412, y: 120, side: "right" as const }, 958],
    [{ x: -28, y: 120, side: "left" as const }, 62],
    [{ x: 400, y: 120, side: "free" as const }, 462],
    [{ x: 800, y: 120, side: "free" as const }, 374],
    [{ x: 1100, y: 120, side: "free" as const }, 674],
])("panel opens beside the revealed bubble %j and aligns by its work-area half", (position, x) => {
    const placement = new PanelPlacement();
    placement.select({ kind: "bubble", position });
    expect(placement.bounds(current, false, [primary], tray)).toEqual({ x, y: 120, width: 420, height: 640 });
    placement.select({ kind: "bubble", position: { ...position, y: 700 } });
    expect(placement.bounds(current, false, [primary], tray)).toEqual({ x, y: 116, width: 420, height: 640 });
});
test("bubble placement survives resizing; a tray open resets the source, and pinning preserves the window's own bounds", () => {
    const placement = new PanelPlacement();
    placement.select({ kind: "bubble", position: { x: 1412, y: 700, side: "right" } });
    const next = placement.bounds(current, false, [primary], tray);
    expect(next).toEqual({ x: 958, y: 116, width: 420, height: 640 });
    expect(placement.bounds({ ...next, height: 800 }, false, [primary], tray)).toEqual({ x: 958, y: 24, width: 420, height: 800 });
    expect(placement.bounds({ ...next, height: 300 }, false, [primary], tray)).toEqual({ x: 958, y: 456, width: 420, height: 300 });
    const pinned = { x: 200, y: 300, width: 800, height: 500 };
    expect(placement.bounds(pinned, true, [primary], tray)).toEqual(pinned);
    placement.select({ kind: "tray" });
    expect(placement.bounds(pinned, true, [primary], tray)).toEqual(pinned);
    expect(placement.bounds(current, false, [primary], tray)).toEqual(anchoredBounds(tray, primary.workArea!, 640));
});
test("bubble selects its own negative-coordinate display independently of the tray; work area and side Dock clamp it", () => {
    const left: BubbleDisplay = { bounds: { x: -1280, y: -200, width: 1280, height: 800 }, workArea: { x: -1200, y: -176, width: 1200, height: 726 } };
    const placement = new PanelPlacement();
    placement.select({ kind: "bubble", position: { x: -1228, y: -176, side: "left" } });
    expect(placement.bounds(current, false, [primary, left], tray)).toEqual({ x: -1138, y: -176, width: 420, height: 640 });
    placement.select({ kind: "bubble", position: { x: -1228, y: 494, side: "left" } });
    expect(placement.bounds(current, false, [primary, left], tray)).toEqual({ x: -1138, y: -90, width: 420, height: 640 });
    // Disconnecting the anchor display follows the bubble's restore-to-primary rule.
    expect(placement.bounds(current, false, [primary], tray)).toEqual({ x: 958, y: 24, width: 420, height: 640 });
});
test("vertical displays and small work areas clamp both panel dimensions without falling back to the tray", () => {
    const upper: BubbleDisplay = { bounds: { x: 0, y: -900, width: 1440, height: 900 }, workArea: { x: 0, y: -876, width: 1440, height: 876 } };
    const placement = new PanelPlacement();
    placement.select({ kind: "bubble", position: { x: 1412, y: -800, side: "right" } });
    expect(placement.bounds(current, false, [primary, upper], tray)).toEqual({ x: 958, y: -800, width: 420, height: 640 });
    const small: BubbleDisplay = { bounds: { x: 0, y: 0, width: 360, height: 300 }, workArea: { x: 0, y: 24, width: 360, height: 276 } };
    placement.select({ kind: "bubble", position: { x: 332, y: 100, side: "right" } });
    expect(placement.bounds(current, false, [small])).toEqual({ x: 0, y: 24, width: 360, height: 276 });
});

test("T21 review: a panel opened from a pinned list moves beside the list instead of under it", () => {
    const displays = [{ bounds: { x: 0, y: 0, width: 2304, height: 1296 }, workArea: { x: 0, y: 30, width: 2214, height: 1266 } }];
    const list = { x: 1844, y: 98, width: 320, height: 570 };
    const panel = { x: 1744, y: 98, width: 420, height: 640 };
    const moved = beside(panel, list, displays);
    expect(moved.x + moved.width).toBeLessThanOrEqual(list.x);
    expect(moved.y).toBe(panel.y);
    const clear = { x: 100, y: 98, width: 420, height: 640 };
    expect(beside(clear, list, displays)).toEqual(clear);
});
