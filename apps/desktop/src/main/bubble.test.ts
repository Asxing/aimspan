// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CoreRequest } from "@aimspan/protocol";
import { session, workspace } from "../../test/panel-fixtures";
vi.mock("electron", async () => {
    const { EventEmitter } = await import("node:events");
    class Window extends EventEmitter {
        visible = false;
        bounds = { x: 0, y: 0, width: 112, height: 56 };
        webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler: vi.fn(), send: vi.fn(), getURL: () => "file:///bubble.html" });
        constructor(readonly options: { width: number; height: number }) { super(); this.bounds.width = options.width; this.bounds.height = options.height; }
        isVisible = () => this.visible;
        isFocused = vi.fn(() => false);
        isDestroyed = () => false;
        show = vi.fn(() => { this.visible = true; });
        showInactive = vi.fn(() => { this.visible = true; });
        hide = vi.fn(() => { this.visible = false; });
        focus = vi.fn();
        getBounds = () => ({ ...this.bounds });
        setPosition = vi.fn((x: number, y: number) => { Object.assign(this.bounds, { x, y }); });
        setTitle = vi.fn();
        setBounds = vi.fn((bounds: typeof this.bounds) => { this.bounds = bounds; });
        setOpacity = vi.fn();
        setIgnoreMouseEvents = vi.fn();
        setAlwaysOnTop = vi.fn();
        setVisibleOnAllWorkspaces = vi.fn();
        loadFile = vi.fn(async () => {});
        loadURL = vi.fn(async () => {});
    }
    const primary = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 24, width: 1440, height: 876 } };
    return { BrowserWindow: Window, app: { focus: vi.fn() }, ipcMain: { handle: vi.fn() }, Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
        globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
        screen: Object.assign(new EventEmitter(), { getCursorScreenPoint: vi.fn(() => ({ x: 100, y: 100 })), getPrimaryDisplay: () => primary, getAllDisplays: vi.fn(() => [primary]) }) };
});
import { app, globalShortcut, ipcMain, Menu, screen } from "electron";
import { BubbleWindow } from "./bubble";
const instances: BubbleWindow[] = [];
beforeEach(() => {
    vi.clearAllMocks(); vi.useFakeTimers();
    vi.mocked(globalShortcut.register).mockReturnValue(true);
    vi.mocked(screen.getCursorScreenPoint).mockReturnValue({ x: 100, y: 100 });
    vi.mocked(screen.getAllDisplays).mockReturnValue([screen.getPrimaryDisplay()]);
});
afterEach(() => { instances.forEach(instance => instance.stop()); instances.length = 0; vi.useRealTimers(); });
async function fixture(cursor?: () => Electron.Point) {
    const w = workspace([session("a"), session("b", { state: "running" }), session("auto", { interactive: false })]);
    w.settings.language = "zh";
    const actions = { panel: vi.fn(), capture: vi.fn(async () => {}), newSession: vi.fn(async () => {}), quitting: () => false };
    const core = { snapshot: () => w, call: vi.fn(async (r: CoreRequest) => { if (r.method === "settings.save") { w.settings = r.settings; bubble.publish(w); } return w; }) };
    const bubble = new BubbleWindow(core, actions, undefined, cursor); instances.push(bubble); await bubble.ready;
    const invoke = (channel: string, value?: unknown, extra?: unknown, override?: object) => {
        const win = channel.startsWith("compact:") ? bubble.list : bubble.window;
        const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame, ...override };
        return vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)![1](event as Electron.IpcMainInvokeEvent, value, extra);
    };
    return { bubble, w, core, actions, invoke };
}
test("bubble never activates on construction/hover, both windows have isolated preloads and full-screen visibility", async () => {
    const { bubble, invoke } = await fixture();
    expect(Reflect.get(bubble.window, "options")).toMatchObject({ width: 112, height: 56, focusable: false, frame: false, transparent: true, hasShadow: false, skipTaskbar: true,
        webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, preload: expect.stringMatching(/bubble\.cjs$/) } });
    expect(Reflect.get(bubble.list, "options").webPreferences.preload).toMatch(/compact\.cjs$/);
    for (const win of [bubble.window, bubble.list]) {
        expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
        expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { visibleOnFullScreen: true });
    }
    const bounds = bubble.window.getBounds();
    vi.mocked(screen.getCursorScreenPoint).mockReturnValue({ x: bounds.x + 102, y: bounds.y + 28 });
    invoke("bubble:hover", true); vi.advanceTimersByTime(349);
    expect(bubble.list.isVisible()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(bubble.list.isVisible()).toBe(true);
    expect(bubble.window.show).not.toHaveBeenCalled(); expect(bubble.window.focus).not.toHaveBeenCalled();
    expect(bubble.list.show).not.toHaveBeenCalled(); expect(bubble.list.focus).not.toHaveBeenCalled();
    expect(invoke("bubble:state")).toMatchObject({ waiting: 1, running: 1, pinned: false, revealed: true });
});
test("row and plus route explicit targets; IPC rejects child frames, other surfaces and invalid sessions", async () => {
    const { bubble, actions, invoke } = await fixture();
    invoke("compact:session", "a"); expect(actions.panel).toHaveBeenCalledWith({ kind: "session", sessionId: "a" }, { kind: "bubble", position: { x: 1412, y: 434, side: "right" } });
    await invoke("compact:new-session"); expect(actions.newSession).toHaveBeenCalledOnce();
    await invoke("compact:capture", "b"); await invoke("compact:capture", null);
    expect(actions.capture.mock.calls).toEqual([["b"], [null]]);
    for (const id of ["auto", "missing", {}, null]) expect(() => invoke("compact:session", id)).toThrow();
    for (const channel of ["bubble:state", "bubble:hover", "bubble:pointer", "bubble:toggle", "bubble:menu", "compact:state", "compact:hover", "compact:session", "compact:capture", "compact:new-session", "compact:pin", "compact:pin-session", "compact:handled", "compact:close"]) {
        expect(() => invoke(channel, true, {}, { senderFrame: {} })).toThrow(/未通过验证/);
        expect(() => invoke(channel, true, {}, { sender: {} })).toThrow(/未通过验证/);
    }
    expect(() => invoke("bubble:pointer", "down", { x: NaN, y: 0 })).toThrow(/无效/);
    for (const buttons of [-1, 0.5, 65536, NaN, "0", null]) expect(() => invoke("bubble:pointer", "move", { x: 0, y: 0, buttons })).toThrow(/无效/);
    expect(() => invoke("bubble:hover", "true")).toThrow(/无效/);
    expect(invoke("compact:state").sessions.map((s: { id: string }) => s.id)).toEqual(["a", "b"]);
    expect(invoke("compact:state").sessions[0]).not.toHaveProperty("references");
    expect(bubble.window.focus).not.toHaveBeenCalled();
});
test("compact exposes surface and revision metadata for pinned idle/unknown sessions without transcripts", async () => {
    const { bubble, w, invoke } = await fixture();
    w.sessions.push(session("idle-pin", { pinned: true, state: "idle", agent: "claude-code", surface: "vscode", revision: 9 }),
        session("unknown-pin", { pinned: true, state: "unknown", entrypoint: "openclaw" }), session("idle", { state: "idle" }));
    bubble.publish(w);
    const compact = invoke("compact:state");
    expect(compact.sessions.map((s: { id: string }) => s.id)).toEqual(["idle-pin", "unknown-pin", "a", "b"]);
    expect(compact.sessions[0]).toMatchObject({ agent: "claude-code", surface: "vscode", pinned: true, revision: 9 });
    expect(compact.sessions[1]).toMatchObject({ entrypoint: "openclaw" });
    expect(compact.sessions[0]).not.toHaveProperty("activity");
    expect(compact.sessions[0]).not.toHaveProperty("references");
    invoke("compact:session", "idle-pin");
    await invoke("compact:capture", "unknown-pin");
});
test.each([false, true])("T22 navigation closes unless header-pinned=%s; in-place mutations stay open", async pinned => {
    const { bubble, core, invoke } = await fixture(() => ({ x: -100000, y: -100000 }));
    if (pinned) invoke("compact:pin");
    const mutation = { sessionId: "a", expectedRevision: 1, operationId: "fixture-operation" };
    for (const [channel, value] of [["compact:session", "a"], ["compact:capture", "a"], ["compact:capture", null], ["compact:new-session", undefined],
        ["compact:handled", mutation], ["compact:pin-session", { ...mutation, pinned: true, operationId: "fixture-pin" }], ["compact:pin-session", { ...mutation, pinned: false, operationId: "fixture-unpin" }]] as const) {
        if (!bubble.interaction.open) invoke("bubble:toggle");
        await invoke(channel, value);
        expect(bubble.list.isVisible(), channel).toBe(pinned || channel === "compact:handled" || channel === "compact:pin-session");
    }
    expect(core.call).toHaveBeenCalledWith({ ...mutation, method: "session.handled" });
    expect(core.call).toHaveBeenCalledWith({ ...mutation, method: "session.pin", operationId: "fixture-pin" });
    expect(core.call).toHaveBeenCalledWith({ ...mutation, method: "session.unpin", operationId: "fixture-unpin" });
    expect(core.call).not.toHaveBeenCalledWith(expect.objectContaining({ method: "settings.save" }));
    expect(app.focus).not.toHaveBeenCalled(); expect(bubble.list.focus).not.toHaveBeenCalled();
});
test("async action closes only on success; rejected and malformed mutations keep the list open", async () => {
    const { bubble, core, actions, invoke } = await fixture();
    invoke("bubble:toggle");
    let finish!: () => void;
    actions.capture.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = invoke("compact:capture", "a");
    expect(bubble.list.isVisible()).toBe(true);
    finish(); await pending; expect(bubble.list.isVisible()).toBe(false);
    invoke("bubble:toggle");
    core.call.mockRejectedValueOnce(new Error("revision conflict"));
    const mutation = { sessionId: "a", expectedRevision: 1, operationId: "fixture-operation" };
    await expect(invoke("compact:handled", mutation)).rejects.toThrow("revision conflict");
    expect(bubble.list.isVisible()).toBe(true);
    for (const bad of [null, {}, { ...mutation, operationId: "" }, { ...mutation, expectedRevision: -1 }, { ...mutation, sessionId: "auto" }, { ...mutation, sessionId: "missing" }]) {
        await expect(invoke("compact:handled", bad)).rejects.toThrow();
    }
    await expect(invoke("compact:pin-session", { ...mutation, pinned: "true" })).rejects.toThrow();
    expect(core.call).toHaveBeenCalledOnce(); expect(bubble.list.isVisible()).toBe(true);
});
test("versioned compact mutation replays reach Core even after the row leaves waiting/active", async () => {
    const { bubble, core, w, invoke } = await fixture();
    const mutation = { sessionId: "a", expectedRevision: 1, operationId: "fixture-replay" };
    await invoke("compact:handled", mutation);
    w.sessions[0] = { ...w.sessions[0]!, state: "idle", active: false, revision: 2 };
    bubble.publish(w);
    await invoke("compact:handled", mutation);
    expect(core.call.mock.calls).toEqual([[{ ...mutation, method: "session.handled" }], [{ ...mutation, method: "session.handled" }]]);
    core.call.mockClear();
    const unpin = { ...mutation, pinned: false, operationId: "fixture-unpin" };
    await invoke("compact:pin-session", unpin); await invoke("compact:pin-session", unpin);
    expect(core.call.mock.calls).toEqual([[{ ...mutation, operationId: "fixture-unpin", method: "session.unpin" }], [{ ...mutation, operationId: "fixture-unpin", method: "session.unpin" }]]);
});
test("click-open polling uses testCursor for first entry, crossing and 1s auto-close without focus", async () => {
    const testCursor = { x: -100000, y: -100000 };
    const { bubble, invoke } = await fixture(() => ({ ...testCursor }));
    invoke("bubble:toggle"); vi.advanceTimersByTime(5000); expect(bubble.list.isVisible()).toBe(true);
    const list = bubble.list.getBounds();
    Object.assign(testCursor, { x: list.x + 20, y: list.y + 20 }); vi.advanceTimersByTime(50);
    Object.assign(testCursor, { x: -100000, y: -100000 }); vi.advanceTimersByTime(50);
    vi.advanceTimersByTime(950); expect(bubble.list.isVisible()).toBe(true);
    vi.advanceTimersByTime(50); expect(bubble.list.isVisible()).toBe(false);
    expect(screen.getCursorScreenPoint).not.toHaveBeenCalled(); expect(bubble.list.focus).not.toHaveBeenCalled();
});
test("panel and settings opened from the bubble menu retain its placement anchor", async () => {
    const { bubble, w, actions, invoke } = await fixture();
    w.settings.bubblePosition = { x: 1412, y: 700, side: "right" }; bubble.publish(w);
    invoke("bubble:menu");
    const menu = vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)![0];
    for (const label of ["打开主面板", "设置"]) {
        menu.find(item => item.label === label)!.click!({} as Electron.MenuItem, bubble.window, {} as Electron.KeyboardEvent);
    }
    const anchor = { kind: "bubble", position: { x: 1412, y: 700, side: "right" } };
    expect(actions.panel.mock.calls).toEqual([[undefined, anchor], [{ kind: "settings" }, anchor]]);
});
test.each([100, 700])("open compact list recomputes placement for every content change at bubble y=%s", async y => {
    const { bubble, w, invoke } = await fixture(() => ({ x: -100000, y: -100000 }));
    w.settings.bubblePosition = { x: 1412, y, side: "right" }; bubble.publish(w);
    invoke("bubble:toggle");
    const frame = bubble.window.getBounds();
    for (const [rows, height] of [[0, 136], [1, 136], [4, 322], [8, 570], [12, 570], [2, 198], [0, 136]] as const) {
        w.sessions = Array.from({ length: rows }, (_, n) => session(`row-${n}`));
        bubble.publish(w);
        expect(bubble.list.isVisible()).toBe(true);
        expect(bubble.list.getBounds()).toEqual({ x: 1038, y: y === 100 ? 100 : 756 - height, width: 340, height });
        expect(bubble.window.getBounds()).toEqual(frame);
    }
    expect(bubble.list.focus).not.toHaveBeenCalled();
    expect(screen.getCursorScreenPoint).not.toHaveBeenCalled();
});
test("header pin never steals focus or unpins on blur/app switch; explicit close remembers the pin", async () => {
    const { bubble, w, invoke } = await fixture();
    invoke("bubble:toggle");
    expect(invoke("bubble:state")).toMatchObject({ open: true, pinned: false });
    invoke("compact:pin");
    expect(invoke("bubble:state").pinned).toBe(true);
    expect(bubble.list.isVisible()).toBe(true);
    expect(bubble.list.showInactive).toHaveBeenCalledOnce();
    invoke("compact:hover", true); invoke("compact:hover", false);
    (bubble.list as unknown as EventEmitter).emit("blur");
    vi.advanceTimersByTime(1000);
    bubble.publish(w); bubble.reshowInactive();
    expect(invoke("bubble:state").pinned).toBe(true);
    expect(bubble.list.isVisible()).toBe(true);
    expect(app.focus).not.toHaveBeenCalled();
    for (const win of [bubble.window, bubble.list]) {
        expect(win.show).not.toHaveBeenCalled(); expect(win.focus).not.toHaveBeenCalled();
    }
    invoke("bubble:toggle");
    expect(invoke("bubble:state").pinned).toBe(true); expect(bubble.list.isVisible()).toBe(false);
    invoke("bubble:toggle"); invoke("compact:close");
    expect(invoke("bubble:state").pinned).toBe(true); expect(bubble.list.isVisible()).toBe(false);
});
test("Escape dismisses the pinned list only after the user focuses it directly", async () => {
    const { bubble, invoke } = await fixture();
    invoke("bubble:toggle"); invoke("compact:pin");
    const prevented = vi.fn();
    const escape = () => (bubble.list.webContents as unknown as EventEmitter).emit("before-input-event", { preventDefault: prevented }, { key: "Escape" });
    escape();
    expect(prevented).not.toHaveBeenCalled(); expect(invoke("bubble:state").pinned).toBe(true);
    // Native focus resulting from a click inside the list, not a focus() call by Main.
    vi.mocked(bubble.list.isFocused).mockReturnValue(true);
    (bubble.list.webContents as unknown as EventEmitter).emit("before-input-event", { preventDefault: prevented }, { key: "Escape", isComposing: true });
    expect(prevented).not.toHaveBeenCalled(); expect(bubble.list.isVisible()).toBe(true);
    escape();
    expect(prevented).toHaveBeenCalledOnce(); expect(bubble.list.isVisible()).toBe(false);
    expect(invoke("bubble:state")).toMatchObject({ open: false, pinned: true });
    expect(app.focus).not.toHaveBeenCalled(); expect(bubble.list.focus).not.toHaveBeenCalled();
});
test("pointer jitter click-opens without activation; drag beyond threshold moves and persists without toggling", async () => {
    const { bubble, core, invoke } = await fixture();
    invoke("bubble:pointer", "down", { x: 1425, y: 460 });
    invoke("bubble:pointer", "up", { x: 1427, y: 460 });
    expect(invoke("bubble:state")).toMatchObject({ open: true, pinned: false });
    expect(bubble.list.focus).not.toHaveBeenCalled(); expect(app.focus).not.toHaveBeenCalled();
    invoke("bubble:toggle");
    expect(bubble.list.isVisible()).toBe(false);
    invoke("bubble:pointer", "down", { x: 1425, y: 460 });
    invoke("bubble:pointer", "move", { x: 825, y: 410 });
    invoke("bubble:pointer", "up", { x: 825, y: 410 });
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke("bubble:state").pinned).toBe(false);
    expect(core.call).toHaveBeenCalledWith(expect.objectContaining({ method: "settings.save", settings: expect.objectContaining({ bubblePosition: expect.objectContaining({ side: "free" }) }) }));
    expect(bubble.window.setPosition).toHaveBeenCalled(); expect(bubble.window.focus).not.toHaveBeenCalled();
});
test("cursor polling opens without renderer focus and empty window padding passes mouse events through", async () => {
    const { bubble } = await fixture();
    const bounds = bubble.window.getBounds();
    vi.mocked(screen.getCursorScreenPoint).mockReturnValue({ x: bounds.x + 102, y: bounds.y + 28 });
    vi.advanceTimersByTime(400);
    expect(bubble.list.isVisible()).toBe(true);
    vi.mocked(screen.getCursorScreenPoint).mockReturnValue({ x: 100, y: 100 });
    vi.advanceTimersByTime(600);
    expect(bubble.list.isVisible()).toBe(false);
    expect(bubble.window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
});
test.each(["none", "left", "right", "bottom"].flatMap(dock => [200, 700].map(y => ({ dock, y }))))("stationary testCursor opens with $dock Dock at y=$y and explicit close requires re-entry", async ({ dock, y }) => {
    const display = { ...screen.getPrimaryDisplay(), workArea: { x: dock === "left" ? 80 : 0, y: 24,
        width: dock === "left" || dock === "right" ? 1360 : 1440, height: dock === "bottom" ? 796 : 876 } };
    vi.mocked(screen.getAllDisplays).mockReturnValue([display]);
    const testCursor = { x: -100000, y: -100000 };
    const { bubble, w, invoke } = await fixture(() => ({ ...testCursor }));
    w.settings.bubblePosition = dock === "left" ? { x: 52, y, side: "left" } : { x: display.workArea.width - 28, y, side: "right" };
    bubble.publish(w);
    vi.advanceTimersByTime(700);
    const bounds = bubble.window.getBounds();
    expect(bounds.x).toBeGreaterThanOrEqual(display.workArea.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(display.workArea.x + display.workArea.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(display.workArea.y + display.workArea.height);
    const circleX = invoke("bubble:state").circleX;
    const point = { x: bounds.x + (Math.max(0, circleX) + Math.min(bounds.width, circleX + 56)) / 2, y: bounds.y + 28 };
    Object.assign(testCursor, point);
    invoke("bubble:hover", false); invoke("bubble:hover", true);
    vi.advanceTimersByTime(349); expect(bubble.list.isVisible()).toBe(false);
    vi.advanceTimersByTime(1); expect(bubble.list.isVisible()).toBe(true);
    expect(bubble.window.getBounds()).toEqual(bounds);
    expect(bubble.list.getBounds()).toEqual({ x: dock === "left" ? 142 : display.workArea.width - 402, y: y === 200 ? 200 : 558, width: 340, height: 198 });
    invoke("compact:close");
    vi.advanceTimersByTime(1000); expect(bubble.list.isVisible()).toBe(false);
    Object.assign(testCursor, { x: -100000, y: -100000 });
    vi.advanceTimersByTime(700);
    Object.assign(testCursor, point);
    vi.advanceTimersByTime(400); expect(bubble.list.isVisible()).toBe(true);
    expect(screen.getCursorScreenPoint).not.toHaveBeenCalled();
});
test("external held-button events block stationary polls, release starts a fresh rest, and fast unknown motion never opens", async () => {
    const testCursor = { x: -100000, y: -100000 };
    const { bubble, invoke } = await fixture(() => ({ ...testCursor }));
    const bounds = bubble.window.getBounds();
    Object.assign(testCursor, { x: bounds.x + 98, y: bounds.y + 28 });
    invoke("bubble:pointer", "move", { ...testCursor, buttons: 1 });
    vi.advanceTimersByTime(1000); expect(bubble.list.isVisible()).toBe(false);
    invoke("bubble:pointer", "move", { ...testCursor, buttons: 0 });
    vi.advanceTimersByTime(349); expect(bubble.list.isVisible()).toBe(false);
    vi.advanceTimersByTime(1); expect(bubble.list.isVisible()).toBe(true);
    Object.assign(testCursor, { x: -100000, y: -100000 });
    vi.advanceTimersByTime(600); expect(bubble.list.isVisible()).toBe(false);
    testCursor.y = bounds.y + 28;
    for (let n = 0; n < 20; n++) {
        testCursor.x = bounds.x + (n % 2 ? 64 : 102);
        vi.advanceTimersByTime(50); expect(bubble.list.isVisible()).toBe(false);
    }
});
test("pressing the bubble during dwell cannot open the list while dragging or holding", async () => {
    const { bubble, invoke } = await fixture();
    const bounds = bubble.window.getBounds(), point = { x: bounds.x + 98, y: bounds.y + 28 };
    vi.mocked(screen.getCursorScreenPoint).mockReturnValue(point);
    invoke("bubble:hover", true); vi.advanceTimersByTime(300);
    invoke("bubble:pointer", "down", { ...point, buttons: 1 });
    vi.advanceTimersByTime(1000); expect(bubble.list.isVisible()).toBe(false);
    invoke("bubble:pointer", "move", { x: point.x - 200, y: point.y, buttons: 1 });
    vi.advanceTimersByTime(1000); expect(bubble.list.isVisible()).toBe(false);
});
test("one-hour hiding auto-restores, toggling works while hidden, DND suppresses pulses, and stop cleans timers", async () => {
    const { bubble, w, invoke } = await fixture();
    w.settings.bubbleShortcut = "CommandOrControl+Shift+B"; bubble.publish(w);
    invoke("bubble:menu");
    const menu = vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)![0];
    const click = (label: string) => menu.find(item => item.label === label)!.click!({} as Electron.MenuItem, bubble.window, {} as Electron.KeyboardEvent);
    click("隐藏 1 小时"); await vi.advanceTimersByTimeAsync(0);
    expect(bubble.window.isVisible()).toBe(false);
    // Hidden cursor polls are synchronous; avoid yielding for each of 72,000 ticks.
    vi.advanceTimersByTime(3_599_999); expect(bubble.window.isVisible()).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(bubble.window.isVisible()).toBe(true);
    click("免打扰 1 小时"); await vi.advanceTimersByTimeAsync(0);
    w.sessions[0]!.lastTurnEndAt = new Date().toISOString(); bubble.publish(w);
    expect(invoke("bubble:state").pulse).toBe(0);
    w.settings.dndUntil = 0; w.sessions[0]!.lastTurnEndAt = new Date(Date.now() + 1).toISOString(); bubble.publish(w);
    expect(invoke("bubble:state").pulse).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(1500); expect(invoke("bubble:state").pulse).toBe(0);
    click("隐藏气泡"); await vi.advanceTimersByTimeAsync(0); expect(bubble.window.isVisible()).toBe(false);
    vi.mocked(globalShortcut.register).mock.calls.at(-1)![1](); await vi.advanceTimersByTimeAsync(0);
    expect(bubble.window.isVisible()).toBe(true);
    bubble.stop(); expect(globalShortcut.unregister).toHaveBeenCalledWith("CommandOrControl+Shift+B"); expect(vi.getTimerCount()).toBe(0);
});
test("shortcut conflicts are reported, empty defaults register nothing, and display removal restores to primary", async () => {
    const { bubble, w } = await fixture();
    expect(globalShortcut.register).not.toHaveBeenCalled();
    vi.mocked(globalShortcut.register).mockReturnValueOnce(false);
    w.settings.bubbleShortcut = "CommandOrControl+Shift+B"; bubble.publish(w);
    expect(bubble.shortcutError).toMatch(/注册失败/);
    w.settings.bubblePosition = { x: -1000, y: 100, side: "free" }; bubble.publish(w);
    (screen as unknown as EventEmitter).emit("display-removed"); await vi.advanceTimersByTimeAsync(0);
    expect(w.settings.bubblePosition?.side).toBe("right");
    w.settings.bubbleShortcut = ""; bubble.publish(w); expect(bubble.shortcutError).toBeUndefined();
});

test.each([true, false])("bubble menu and shortcut preserve explicit notifications=%s and save the shared DND field", async notifications => {
    const { bubble, w, core, invoke } = await fixture();
    w.settings = { ...w.settings, notifications, notificationsExplicit: true, bubbleShortcut: "CommandOrControl+Shift+B" };
    bubble.publish(w); invoke("bubble:menu");
    const menu = vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)![0];
    const click = (label: string) => menu.find(item => item.label === label)!.click!({} as Electron.MenuItem, bubble.window, {} as Electron.KeyboardEvent);
    click("免打扰 1 小时"); await vi.advanceTimersByTimeAsync(0);
    expect(w.settings.dndUntil).toBe(Date.now() + 3_600_000);
    expect(core.call).toHaveBeenLastCalledWith({ method: "settings.save", settings: expect.objectContaining({ dndUntil: Date.now() + 3_600_000 }) });
    click("隐藏气泡"); await vi.advanceTimersByTimeAsync(0);
    expect(w.settings).toMatchObject({ bubbleEnabled: false, notifications, notificationsExplicit: true });
    vi.mocked(globalShortcut.register).mock.calls.at(-1)![1](); await vi.advanceTimersByTimeAsync(0);
    expect(w.settings).toMatchObject({ bubbleEnabled: true, notifications, notificationsExplicit: true });
});
test("T13 review: a hidden bubble never reads the native cursor while polling", async () => {
    const cursor = vi.fn(() => ({ x: 100, y: 100 }));
    const { bubble, w } = await fixture(cursor);
    w.settings = { ...w.settings, bubbleEnabled: false }; bubble.publish(w);
    cursor.mockClear();
    vi.advanceTimersByTime(1000);
    expect(cursor).not.toHaveBeenCalled();
});

test("T23 language changes republish open bubble/compact state and native titles/menus", async () => {
    const { bubble, core, invoke } = await fixture();
    await bubble.ready;
    const english = { ...core.snapshot(), settings: { ...core.snapshot().settings, language: "en" as const } };
    bubble.publish(english);
    expect(invoke("bubble:state").language).toBe("en");
    expect(invoke("compact:state").language).toBe("en");
    expect(bubble.window.webContents.send).toHaveBeenCalledWith("bubble:state", expect.objectContaining({ language: "en" }));
    expect(bubble.list.webContents.send).toHaveBeenCalledWith("compact:state", expect.objectContaining({ language: "en" }));
    // Native actions consult the current settings, as the real Core snapshot does.
    Object.assign(core.snapshot().settings, english.settings);
    bubble.publish(core.snapshot());
    expect(bubble.window.setTitle).toHaveBeenLastCalledWith("AimSpan bubble");
    expect(bubble.list.setTitle).toHaveBeenLastCalledWith("AimSpan compact list");
    invoke("bubble:menu");
    expect(vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)![0].map(item => item.label)).toContain("Settings");
    core.snapshot().settings.language = "zh";
    bubble.publish(core.snapshot());
    invoke("bubble:menu");
    expect(vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)![0].map(item => item.label)).toContain("设置");
    bubble.stop();
});

test("T24 DND dims the native bubble and expires without a workspace update or focus change", async () => {
    const { bubble, w, invoke, core } = await fixture(() => ({ x: -100000, y: -100000 }));
    expect(bubble.window.setOpacity).toHaveBeenLastCalledWith(0.7);
    w.settings.dndUntil = Date.now() + 1000;
    bubble.publish(w);
    expect(bubble.window.setOpacity).toHaveBeenLastCalledWith(0.45);
    invoke("bubble:toggle");
    expect(bubble.window.setOpacity).toHaveBeenLastCalledWith(0.45);
    expect(bubble.list.isVisible()).toBe(true);
    vi.advanceTimersByTime(999);
    expect(bubble.window.setOpacity).toHaveBeenLastCalledWith(0.45);
    vi.advanceTimersByTime(1);
    expect(bubble.window.setOpacity).toHaveBeenLastCalledWith(1);
    invoke("compact:close");
    expect(bubble.window.setOpacity).toHaveBeenLastCalledWith(0.7);
    expect(core.call).not.toHaveBeenCalled();
    expect(bubble.window.focus).not.toHaveBeenCalled();
    expect(bubble.list.focus).not.toHaveBeenCalled();
    expect(app.focus).not.toHaveBeenCalled();
});

test.each([1000, 3000])("T24 hidden-until and DND deadlines both expire when DND lasts %i ms", async duration => {
    const { bubble, w } = await fixture(() => ({ x: -100000, y: -100000 }));
    w.settings.bubbleHiddenUntil = Date.now() + 2000;
    w.settings.dndUntil = Date.now() + duration;
    bubble.publish(w);
    vi.advanceTimersByTime(1999);
    expect(bubble.window.isVisible()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(bubble.window.isVisible()).toBe(true);
    expect(bubble.window.setOpacity).toHaveBeenLastCalledWith(duration > 2000 ? 0.45 : 0.7);
    vi.advanceTimersByTime(1000);
    expect(bubble.window.setOpacity).toHaveBeenLastCalledWith(0.7);
    bubble.stop();
    expect(vi.getTimerCount()).toBe(0);
});

test.each([true, false])("T24 tray toggle clears temporary hiding and preserves explicit notifications=%s", async notifications => {
    const { bubble, w, invoke } = await fixture();
    w.settings = { ...w.settings, notifications, notificationsExplicit: true, pinned: true, bubbleHiddenUntil: Date.now() + 3_600_000 };
    bubble.publish(w);
    expect(bubble.window.isVisible()).toBe(false);
    await bubble.setEnabled(true);
    expect(w.settings).toMatchObject({ bubbleEnabled: true, bubbleHiddenUntil: 0, notifications, notificationsExplicit: true, pinned: true });
    expect(bubble.window.isVisible()).toBe(true);
    await bubble.setEnabled(false);
    expect(w.settings).toMatchObject({ bubbleEnabled: false, bubbleHiddenUntil: 0, notifications, notificationsExplicit: true, pinned: true });
    expect(bubble.window.isVisible()).toBe(false);
    expect(invoke("bubble:state")).toMatchObject({ waiting: 1, running: 1 });
});

test("T24 tray toggle keeps the existing automatic notification policy", async () => {
    const { bubble, w } = await fixture();
    w.settings.notificationsExplicit = false;
    await bubble.setEnabled(false);
    expect(w.settings.notifications).toBe(true);
    await bubble.setEnabled(true);
    expect(w.settings.notifications).toBe(false);
});
