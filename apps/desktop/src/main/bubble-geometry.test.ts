// @vitest-environment node
import { expect, test } from "vitest";
import { bubbleAnchoredBounds, bubbleFrame, bubbleOpacity, compactBounds, isDrag, popoverBounds, restore, snap, type BubbleDisplay } from "./bubble-geometry";
const primary: BubbleDisplay = { bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 24, width: 1440, height: 876 }, primary: true };
const left: BubbleDisplay = { bounds: { x: -1280, y: 0, width: 1280, height: 800 } };
test("single display snaps only within 24px and hides precisely half of the 56px circle", () => {
    expect(snap({ x: 24, y: 100 }, [primary])).toEqual({ x: -28, y: 100, side: "left" });
    expect(snap({ x: 25, y: 100 }, [primary]).side).toBe("free");
    expect(snap({ x: 1360, y: 100 }, [primary])).toEqual({ x: 1412, y: 100, side: "right" });
    expect(snap({ x: 1359, y: 100 }, [primary]).side).toBe("free");
    expect(snap({ x: 400, y: -300 }, [primary])).toEqual({ x: 400, y: 24, side: "free" });
});
test("side-by-side displays never snap at their shared edge, including negative coordinates", () => {
    expect(snap({ x: -56, y: 100 }, [primary, left]).side).toBe("free");
    expect(snap({ x: 0, y: 100 }, [primary, left]).side).toBe("free");
    expect(snap({ x: -1270, y: 100 }, [primary, left])).toEqual({ x: -1308, y: 100, side: "left" });
    expect(snap({ x: 1384, y: 100 }, [primary, left]).side).toBe("right");
});
test("vertical stacks snap at the array's side edges, never their top/bottom seam or an inset side", () => {
    const upper: BubbleDisplay = { bounds: { x: 0, y: -900, width: 1440, height: 900 } };
    expect(snap({ x: 0, y: -500 }, [primary, upper])).toEqual({ x: -28, y: -500, side: "left" });
    expect(snap({ x: 400, y: -56 }, [primary, upper]).side).toBe("free");
    const inset: BubbleDisplay = { bounds: { x: 100, y: -900, width: 1000, height: 900 } };
    expect(snap({ x: 1044, y: -500 }, [primary, inset]).side).toBe("free");
});
test("restore keeps reachable free/snapped positions, and falls back on removal or partly unreachable free positions", () => {
    const saved = { x: -1308, y: 120, side: "left" as const };
    expect(restore(saved, [primary, left])).toEqual(saved);
    expect(restore(saved, [primary])).toEqual(restore(undefined, [primary]));
    expect(restore({ x: 1412, y: 120, side: "right" }, [primary])).toEqual({ x: 1412, y: 120, side: "right" });
    expect(restore({ x: 400, y: 120, side: "free" }, [primary])).toEqual({ x: 400, y: 120, side: "free" });
    for (const p of [{ x: 1430, y: 120 }, { x: 200, y: -1 }, { x: 4000, y: 200 }]) expect(restore({ ...p, side: "free" }, [primary])).toEqual(restore(undefined, [primary]));
    expect(restore({ x: -28, y: 120, side: "left" }, [primary, left])).toEqual(restore(undefined, [primary, left]));
});
test("half-hide uses a fully in-screen native frame and changes only the circle offset on hover", () => {
    for (const side of ["left", "right"] as const) {
        const position = { x: side === "left" ? -28 : 1412, y: 100, side };
        const hidden = bubbleFrame(position, [primary], false), shown = bubbleFrame(position, [primary], true);
        expect(hidden.bounds).toEqual(shown.bounds);
        expect(hidden.bounds.x).toBeGreaterThanOrEqual(0);
        expect(hidden.bounds.x + hidden.bounds.width).toBeLessThanOrEqual(1440);
        expect(Math.abs(hidden.circleX - shown.circleX)).toBe(28);
        expect(side === "left" ? hidden.circleX + 56 : hidden.bounds.width - hidden.circleX).toBe(28);
        expect(shown.circleX).toBeGreaterThanOrEqual(0);
        expect(shown.circleX + 56).toBeLessThanOrEqual(shown.bounds.width);
    }
    expect(bubbleOpacity("right", false)).toBe(0.7);
    expect(bubbleOpacity("free", false)).toBe(0.35);
    expect(bubbleOpacity("left", true)).toBe(1);
});
test("list opens toward the display interior, caps eight rows, and clamps to the work area", () => {
    const right = compactBounds({ x: 1412, y: 850, side: "right" }, [primary], 30);
    expect(right).toEqual({ x: 1038, y: 330, width: 340, height: 570 });
    const leftList = compactBounds({ x: -28, y: 100, side: "left" }, [primary], 1);
    expect(leftList).toEqual({ x: 62, y: 100, width: 340, height: 136 });
});
test.each([
    { side: "left" as const, x: 0, expectedX: 62 },
    { side: "right" as const, x: 1384, expectedX: 1038 },
    { side: "free" as const, x: 400, expectedX: 462 },
    // Both sides fit; choose the roomier left side, not the first side that fits.
    { side: "free" as const, x: 800, expectedX: 454 },
])("popover beside $side bubble at x=$x aligns to the top or bottom by its center", ({ side, x, expectedX }) => {
    for (const [y, expectedY] of [[120, 120], [700, 556]] as const) {
        expect(popoverBounds({ x, y, width: 56, height: 56, side }, { width: 340, height: 200 }, primary.workArea!))
            .toEqual({ x: expectedX, y: expectedY, width: 340, height: 200 });
    }
});
test("popover ties go right and up; the center and midpoint are relative to the work area", () => {
    const area = { x: -1200, y: -176, width: 1200, height: 726 };
    const bubble = { x: -628, y: 158, width: 56, height: 56, side: "free" as const };
    expect(popoverBounds(bubble, { width: 340, height: 200 }, area)).toEqual({ x: -566, y: 158, width: 340, height: 200 });
    // Center y=187 is exactly the work-area midpoint, even though the top is above it.
    expect(popoverBounds({ ...bubble, y: 159 }, { width: 340, height: 200 }, area)).toEqual({ x: -566, y: 15, width: 340, height: 200 });
});
test("tall popovers clamp after choosing the vertical direction and oversized popovers remain fully visible", () => {
    const bubble = { x: 1384, y: 433, width: 56, height: 56, side: "right" as const };
    // 800px is taller than the available space in either vertical direction.
    expect(popoverBounds(bubble, { width: 420, height: 800 }, primary.workArea!)).toEqual({ x: 958, y: 100, width: 420, height: 800 });
    expect(popoverBounds({ ...bubble, y: 434 }, { width: 420, height: 800 }, primary.workArea!)).toEqual({ x: 958, y: 24, width: 420, height: 800 });
    expect(popoverBounds(bubble, { width: 2000, height: 2000 }, primary.workArea!)).toEqual(primary.workArea);
    const area = { x: 0, y: 24, width: 500, height: 876 };
    expect(popoverBounds({ ...bubble, x: 222, side: "free" }, { width: 340, height: 200 }, area)).toEqual({ x: 160, y: 433, width: 340, height: 200 });
});
test.each([
    { dock: "left", area: { x: 80, y: 24, width: 1360, height: 876 } },
    { dock: "right", area: { x: 0, y: 24, width: 1360, height: 876 } },
    { dock: "bottom", area: { x: 0, y: 24, width: 1440, height: 796 } },
])("compact and panel placement use the $dock Dock work area in both halves", ({ area }) => {
    const display = { ...primary, workArea: area };
    for (const y of [100, 700]) {
        for (const side of ["left", "right"] as const) {
            const position = { x: (side === "left" ? area.x : area.x + area.width) - 28, y, side };
            const compactX = side === "left" ? area.x + 62 : area.x + area.width - 402;
            const panelX = side === "left" ? area.x + 62 : area.x + area.width - 482;
            expect(compactBounds(position, [display], 1)).toEqual({ x: compactX, y: y === 100 ? 100 : 620, width: 340, height: 136 });
            expect(bubbleAnchoredBounds(position, [display], { width: 420, height: 300 }))
                .toEqual({ x: panelX, y: y === 100 ? 100 : 456, width: 420, height: 300 });
        }
    }
});
test("two displays use their own work-area midpoint and room even next to the seam", () => {
    const secondary = { bounds: { x: -1280, y: -200, width: 1280, height: 800 }, workArea: { x: -1200, y: -176, width: 1200, height: 726 } };
    const displays = [primary, secondary];
    // y=200 is below the secondary midpoint but above the primary midpoint.
    expect(compactBounds({ x: -1228, y: 200, side: "left" }, displays, 1)).toEqual({ x: -1138, y: 120, width: 340, height: 136 });
    expect(compactBounds({ x: 1412, y: 200, side: "right" }, displays, 1)).toEqual({ x: 1038, y: 200, width: 340, height: 136 });
    expect(compactBounds({ x: -56, y: 200, side: "free" }, displays, 1)).toEqual({ x: -402, y: 120, width: 340, height: 136 });
    expect(compactBounds({ x: 0, y: 200, side: "free" }, displays, 1)).toEqual({ x: 62, y: 200, width: 340, height: 136 });
});
test("drag threshold uses distance, includes exactly four pixels, and tolerates a small click jitter", () => {
    expect(isDrag({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe(false);
    expect(isDrag({ x: 0, y: 0 }, { x: 4, y: 0 })).toBe(true);
    expect(isDrag({ x: -100, y: 0 }, { x: -103, y: 3 })).toBe(true);
});
test("T13 R1 left Dock uses the work-area edge for snap, restore, half-hide and reveal", () => {
    const withDock = { ...primary, workArea: { x: 80, y: 24, width: 1360, height: 876 } };
    const saved = snap({ x: 80, y: 200 }, [withDock]);
    expect(saved).toEqual({ x: 52, y: 200, side: "left" });
    expect(restore(saved, [withDock])).toEqual(saved);
    expect(bubbleFrame(saved, [withDock], false)).toEqual({ bounds: { x: 80, y: 200, width: 112, height: 56 }, circleX: -28 });
    expect(bubbleFrame(saved, [withDock], true)).toEqual({ bounds: { x: 80, y: 200, width: 112, height: 56 }, circleX: 0 });
    expect(compactBounds(saved, [withDock], 1)).toEqual({ x: 142, y: 200, width: 340, height: 136 });
    expect(bubbleAnchoredBounds(saved, [withDock], { width: 420, height: 640 })).toEqual({ x: 142, y: 200, width: 420, height: 640 });
});
test("T13 R1 right Dock keeps both bubble frames and anchored surfaces inside the work area", () => {
    const display = { bounds: { x: 0, y: 0, width: 2304, height: 1296 }, workArea: { x: 0, y: 30, width: 2214, height: 1266 }, primary: true };
    const saved = snap({ x: 2158, y: 200 }, [display]);
    expect(saved).toEqual({ x: 2186, y: 200, side: "right" });
    expect(restore(saved, [display])).toEqual(saved);
    expect(bubbleFrame(saved, [display], false)).toEqual({ bounds: { x: 2102, y: 200, width: 112, height: 56 }, circleX: 84 });
    expect(bubbleFrame(saved, [display], true)).toEqual({ bounds: { x: 2102, y: 200, width: 112, height: 56 }, circleX: 56 });
    expect(compactBounds(saved, [display], 1)).toEqual({ x: 1812, y: 200, width: 340, height: 136 });
    expect(bubbleAnchoredBounds(saved, [display], { width: 420, height: 640 })).toEqual({ x: 1732, y: 200, width: 420, height: 640 });
    expect(restore({ x: 2276, y: 200, side: "right" }, [display])).toEqual(restore(undefined, [display]));
    expect(restore(undefined, [display])).toEqual({ x: 2186, y: 635, side: "right" });
    expect(snap({ x: 2134, y: 200 }, [display]).side).toBe("right");
    expect(snap({ x: 2133, y: 200 }, [display]).side).toBe("free");
});
test("T13 R1 bottom Dock and menu bar clamp free bubbles, snaps and anchored surfaces", () => {
    const display = { ...primary, workArea: { x: 0, y: 30, width: 1440, height: 790 } };
    expect(snap({ x: 400, y: 850 }, [display])).toEqual({ x: 400, y: 764, side: "free" });
    expect(snap({ x: 400, y: 0 }, [display])).toEqual({ x: 400, y: 30, side: "free" });
    const saved = snap({ x: 1384, y: 850 }, [display]);
    expect(saved).toEqual({ x: 1412, y: 764, side: "right" });
    expect(bubbleFrame(saved, [display], false).bounds).toEqual({ x: 1328, y: 764, width: 112, height: 56 });
    expect(compactBounds(saved, [display], 1)).toEqual({ x: 1038, y: 684, width: 340, height: 136 });
    expect(bubbleAnchoredBounds(saved, [display], { width: 420, height: 640 })).toEqual({ x: 958, y: 180, width: 420, height: 640 });
    expect(restore({ x: 400, y: 850, side: "free" }, [display])).toEqual(restore(undefined, [display]));
});
test("T13 R1 multi-display Dock edges snap only on the outside of the display array", () => {
    const dockLeft = { ...left, workArea: { x: -1200, y: 24, width: 1200, height: 776 } };
    const dockRight = { ...primary, workArea: { x: 0, y: 24, width: 1360, height: 876 } };
    const displays = [dockRight, dockLeft];
    const saved = snap({ x: -1200, y: 200 }, displays);
    expect(saved).toEqual({ x: -1228, y: 200, side: "left" });
    expect(restore(saved, displays)).toEqual(saved);
    expect(bubbleFrame(saved, displays, true)).toEqual({ bounds: { x: -1200, y: 200, width: 112, height: 56 }, circleX: 0 });
    expect(compactBounds(saved, displays, 1)).toEqual({ x: -1138, y: 200, width: 340, height: 136 });
    expect(snap({ x: 1304, y: 200 }, displays)).toEqual({ x: 1332, y: 200, side: "right" });
    expect(snap({ x: -56, y: 200 }, displays).side).toBe("free");
    expect(snap({ x: 0, y: 200 }, displays).side).toBe("free");
    const dockAtSeam = { ...primary, workArea: { x: 80, y: 24, width: 1360, height: 876 } };
    expect(snap({ x: 80, y: 200 }, [dockAtSeam, left])).toEqual({ x: 80, y: 200, side: "free" });
    expect(restore(saved, [dockRight])).toEqual(restore(undefined, [dockRight]));
});
test("T13 R1 work-area changes restore unreachable positions and keep a free dragged circle out of the Dock", () => {
    const display = { ...primary, workArea: { x: 80, y: 30, width: 1280, height: 790 } };
    for (const saved of [
        { x: -28, y: 200, side: "left" as const }, { x: 1412, y: 200, side: "right" as const },
        { x: 0, y: 200, side: "free" as const }, { x: 1340, y: 200, side: "free" as const },
    ]) expect(restore(saved, [display])).toEqual({ x: 1332, y: 397, side: "right" });
    const valid = { x: 80, y: 30, side: "free" as const };
    expect(restore(valid, [display])).toEqual(valid);
    for (const position of [{ x: 0, y: 0 }, { x: 1420, y: 850 }]) {
        const frame = bubbleFrame({ ...position, side: "free" }, [display], true);
        expect(frame.bounds.x + frame.circleX).toBeGreaterThanOrEqual(80);
        expect(frame.bounds.x + frame.circleX + 56).toBeLessThanOrEqual(1360);
        expect(frame.bounds.y).toBeGreaterThanOrEqual(30);
        expect(frame.bounds.y + 56).toBeLessThanOrEqual(820);
    }
});
test("T13 R1 stacked displays keep outer-edge eligibility while each Dock offsets its local snap point", () => {
    const upper = { bounds: { x: 0, y: -900, width: 1440, height: 900 } };
    const withDock = { ...primary, workArea: { x: 0, y: 24, width: 1360, height: 876 } };
    const saved = snap({ x: 1304, y: 200 }, [upper, withDock]);
    expect(saved).toEqual({ x: 1332, y: 200, side: "right" });
    expect(restore(saved, [upper, withDock])).toEqual(saved);
    expect(bubbleFrame(saved, [upper, withDock], false).bounds).toEqual({ x: 1248, y: 200, width: 112, height: 56 });
    expect(snap({ x: 1384, y: -500 }, [withDock, upper])).toEqual({ x: 1412, y: -500, side: "right" });
});

test("T24 old 44px snapped positions retain their edge and fit the larger circle above the Dock", () => {
    const display = { ...primary, workArea: { x: 80, y: 30, width: 1280, height: 790 } };
    expect(restore({ x: 58, y: 200, side: "left" }, [display])).toEqual({ x: 52, y: 200, side: "left" });
    expect(restore({ x: 1338, y: 200, side: "right" }, [display])).toEqual({ x: 1332, y: 200, side: "right" });
    for (const side of ["left", "right"] as const) {
        const position = restore({ x: side === "left" ? 58 : 1338, y: 776, side }, [display]);
        expect(position).toEqual({ x: side === "left" ? 52 : 1332, y: 764, side });
        const frame = bubbleFrame(position, [display], true);
        expect(frame.bounds.y + frame.bounds.height).toBe(820);
        expect(frame.bounds.x + frame.circleX).toBe(side === "left" ? 80 : 1304);
    }
    // A moved Dock or removed display still follows the existing fallback rule.
    expect(restore({ x: -22, y: 200, side: "left" }, [display])).toEqual({ x: 1332, y: 397, side: "right" });
});

test.each(["left", "right", "free"] as const)("T24 DND keeps the %s bubble at 45 percent even when revealed", side => {
    expect(bubbleOpacity(side, false, true)).toBe(0.45);
    expect(bubbleOpacity(side, true, true)).toBe(0.45);
    expect(bubbleOpacity(side, true, false)).toBe(1);
    expect(bubbleOpacity(side, false, false)).toBe(side === "free" ? 0.35 : 0.7);
});
