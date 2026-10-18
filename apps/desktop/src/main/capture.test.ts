// @vitest-environment node
import { EventEmitter } from "node:events";
import { beforeEach, expect, test, vi } from "vitest";
import type { CoreRequest } from "@aimspan/protocol";
import { CAPTURE_DRAFT_KEY, CAPTURE_STALE_OPEN, NEW_SESSION_TARGETS, captureDraftKey } from "@aimspan/protocol";
import { session, workspace } from "../../test/panel-fixtures";

vi.mock("electron", async () => {
    const { EventEmitter } = await import("node:events");
    class Window extends EventEmitter {
        visible = false;
        webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler: vi.fn(), send: vi.fn(), getURL: () => "file:///capture.html" });
        constructor(readonly options: unknown) { super(); }
        isVisible = () => this.visible;
        isDestroyed = () => false;
        show = vi.fn(() => { this.visible = true; });
        hide = vi.fn(() => { this.visible = false; });
        focus = vi.fn();
        setTitle = vi.fn();
        setBounds = vi.fn();
        setAlwaysOnTop = vi.fn();
        setVisibleOnAllWorkspaces = vi.fn();
        loadFile = vi.fn(async () => {});
        loadURL = vi.fn(async () => {});
    }
    return { BrowserWindow: Window, app: { hide: vi.fn(), focus: vi.fn() }, ipcMain: { handle: vi.fn() },
        globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
        screen: { getCursorScreenPoint: () => ({ x: -500, y: 100 }), getDisplayNearestPoint: vi.fn(() => ({ workArea: { x: -1440, y: 24, width: 1440, height: 876 } })) } };
});
import { app, globalShortcut, ipcMain, screen } from "electron";
import { CaptureWindow, captureBounds, captureContext } from "./capture";

beforeEach(() => { vi.clearAllMocks(); vi.mocked(globalShortcut.register).mockReturnValue(true); });
function fixture() {
    const w = workspace([session("a", { state: "running" }), session("child", { parentNativeId: "a" }), session("auto", { interactive: false }), session("exec", { entrypoint: "codex_exec" })]);
    w.settings.language = "zh";
    const core = { snapshot: () => w, call: vi.fn(async (request: CoreRequest): Promise<unknown> => request.method === "workspace" ? w : null) };
    const panelVisible = vi.fn(() => false);
    const reshowPanel = vi.fn();
    const newSession = vi.fn(async () => ({ message: "已复制", brought: 1 }));
    const capture = new CaptureWindow(core, panelVisible, () => false, undefined, reshowPanel, undefined, newSession);
    const trusted = { sender: capture.window.webContents, senderFrame: capture.window.webContents.mainFrame };
    // Saves carry the open the page shows; default to the current one.
    const invoke = (channel: string, value?: unknown, event = trusted, openId: unknown = Reflect.get(capture, "openId")) => {
        const handler = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)![1];
        return handler(event as Electron.IpcMainInvokeEvent, value, openId);
    };
    return { capture, core, newSession, panelVisible, reshowPanel, trusted, invoke };
}
test("capture window is isolated, fixed size, above full-screen spaces and positioned on the cursor display", async () => {
    const { capture } = fixture();
    expect(Reflect.get(capture.window, "options")).toMatchObject({ width: 560, height: 210, frame: false, resizable: false, alwaysOnTop: true, show: false,
        roundedCorners: true, hasShadow: true, backgroundColor: "#00000000", vibrancy: "popover", visualEffectState: "active",
        webPreferences: { preload: expect.stringMatching(/capture\.cjs$/), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    expect(capture.window.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { visibleOnFullScreen: true });
    await capture.shortcutHandler();
    expect(screen.getDisplayNearestPoint).toHaveBeenCalledWith({ x: -500, y: 100 });
    expect(capture.window.setBounds).toHaveBeenCalledWith({ x: -1000, y: 199, width: 560, height: 210 });
    expect(captureBounds({ x: 0, y: 0, width: 400, height: 120 })).toEqual({ x: 0, y: 0, width: 400, height: 120 });
    expect(capture.window.focus).toHaveBeenCalledOnce();
});
test("registration follows settings, diagnoses false/throw and cleans up at quit", async () => {
    const { capture } = fixture();
    capture.register(undefined);
    expect(globalShortcut.register).toHaveBeenCalledWith("CommandOrControl+Shift+Space", expect.any(Function));
    capture.register(undefined);
    expect(globalShortcut.register).toHaveBeenCalledOnce();
    vi.mocked(globalShortcut.register).mockReturnValueOnce(false);
    capture.register("CommandOrControl+Shift+I");
    expect(globalShortcut.unregister).toHaveBeenCalledWith("CommandOrControl+Shift+Space");
    expect(capture.shortcutError).toMatch(/注册失败/);
    vi.mocked(globalShortcut.register).mockImplementationOnce(() => { throw new Error("bad accelerator"); });
    expect(() => capture.register("invalid")).not.toThrow();
    expect(capture.shortcutError).toMatch(/格式无效/);
    capture.register("CommandOrControl+Shift+J");
    expect(globalShortcut.unregister).not.toHaveBeenCalledWith("invalid");
    expect(globalShortcut.unregister).not.toHaveBeenCalledWith("CommandOrControl+Shift+I");
    expect(capture.shortcutError).toBeUndefined();
    capture.stop(); await capture.shortcutHandler();
    expect(globalShortcut.unregister).toHaveBeenCalledWith("CommandOrControl+Shift+J");
    expect(capture.window.show).not.toHaveBeenCalled();
});
test("blur and close hide before macOS app.hide, preserving a visible panel and ignoring an old close timer", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    try {
        const { capture, panelVisible, reshowPanel, invoke } = fixture();
        await capture.shortcutHandler();
        const old = (await invoke("capture:context")).openId;
        (capture.window as unknown as EventEmitter).emit("blur");
        expect(capture.window.hide).toHaveBeenCalledOnce();
        expect(app.hide).toHaveBeenCalledOnce();
        expect(vi.mocked(capture.window.hide).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(app.hide).mock.invocationCallOrder[0]!);
        panelVisible.mockReturnValue(true);
        await capture.shortcutHandler();
        invoke("capture:close", old);
        expect(capture.window.isVisible()).toBe(true);
        invoke("capture:close", (await invoke("capture:context")).openId);
        expect(capture.window.isVisible()).toBe(false);
        // A pinned panel: the app still hides (focus returns to the previous app), then the panel reappears without focus.
        expect(app.hide).toHaveBeenCalledTimes(2);
        expect(reshowPanel).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
});
test("capture ideas exclude child/automation targets; shared drafts and both mutations reject unrelated IPC authority", async () => {
    const { core, invoke, trusted } = fixture();
    expect((await invoke("capture:context")).sessions.map((s: { id: string }) => s.id)).toEqual(["a"]);
    const request = { sessionId: "a", body: "  中文😀  ", expectedRevision: 0, operationId: "op" };
    for (const sessionId of ["child", "auto", "exec", "missing"]) {
        expect(() => invoke("capture:idea", { ...request, sessionId })).toThrow();
        expect(() => invoke("capture:draft", { ...request, method: "draft.save", target: "capture", sessionId })).toThrow();
    }
    expect(() => invoke("capture:idea", { ...request, id: "existing" })).toThrow();
    expect(() => invoke("capture:idea", { ...request, expectedRevision: 1 })).toThrow();
    expect(() => invoke("capture:idea", { ...request, body: " " })).toThrow();
    expect(() => invoke("capture:draft", { ...request, method: "draft.save", target: "inbox" })).toThrow();
    expect(() => invoke("capture:draft", { method: "settings.save" })).toThrow();
    for (const channel of ["capture:context", "capture:idea", "capture:draft", "capture:new-session", "capture:close"]) {
        await expect(Promise.resolve().then(() => invoke(channel, request, { ...trusted, senderFrame: {} as Electron.WebFrameMain }))).rejects.toThrow(/未通过验证/);
        await expect(Promise.resolve().then(() => invoke(channel, request, { ...trusted, sender: {} as Electron.WebContents }))).rejects.toThrow(/未通过验证/);
    }
    await invoke("capture:idea", request);
    await invoke("capture:idea", { ...request, sessionId: null });
    expect(core.call).toHaveBeenCalledWith({ method: "idea.save", ...request });
    expect(core.call).toHaveBeenCalledWith({ method: "idea.save", ...request, sessionId: null });
    const draft = { method: "draft.save", target: "capture", body: "共享草稿", expectedRevision: 2, operationId: "draft" };
    await invoke("capture:draft", draft);
    expect(core.call).toHaveBeenCalledWith(draft);
    for (const sessionId of ["a", null]) expect(() => invoke("capture:draft", { ...draft, sessionId })).toThrow();
    expect(() => invoke("capture:draft", { ...draft, target: CAPTURE_DRAFT_KEY })).toThrow();
});
test("context exposes only the shared draft, pending counts and safe target row/time fields", () => {
    const w = workspace();
    w.inboxIdeaCount = 3;
    w.sessions[0]!.pendingIdeaCount = 2;
    w.sessions[0]!.lastTurnEndAt = "2026-10-16T08:00:00Z";
    for (const key of ["inbox", "a", "capture", CAPTURE_DRAFT_KEY, captureDraftKey("a"), captureDraftKey("missing"), captureDraftKey(null)])
        w.drafts[key] = { target: key, body: "draft", revision: 1, updatedAt: "2026-10-16" };
    const context = captureContext(w, 2);
    expect(Object.keys(context.drafts)).toEqual([CAPTURE_DRAFT_KEY]);
    expect(context.inboxIdeaCount).toBe(3);
    expect(context.sessions[0]).toEqual({ id: "a", nativeId: "a", agent: "codex", title: "会话 a", project: "/__aimspan_fixture__/project", state: "waiting",
        lastPromptAt: undefined, lastTurnEndAt: "2026-10-16T08:00:00Z", lastActivityAt: "2026-10-16T08:00:00Z", observedAt: "2026-10-16T08:00:00Z",
        pendingIdeaCount: 2, hasNewResult: true, active: true, archived: false });
    expect(context).not.toHaveProperty("ideas");
    expect(context.sessions[0]).not.toHaveProperty("references");
});

test("opening announces the new open ID to the page and takes app focus on macOS", async () => {
    const { capture } = fixture();
    await capture.shortcutHandler();
    const send = capture.window.webContents.send as unknown as ReturnType<typeof vi.fn>;
    expect(send).toHaveBeenCalledWith("capture:opened", 1);
    if (process.platform === "darwin") expect(app.focus).toHaveBeenCalledWith({ steal: true });
    // The page must learn about the new open before it can receive focus or keys.
    const show = capture.window.show as unknown as ReturnType<typeof vi.fn>;
    const focus = capture.window.focus as unknown as ReturnType<typeof vi.fn>;
    expect(send.mock.invocationCallOrder[0]!).toBeLessThan(show.mock.invocationCallOrder[0]!);
    expect(send.mock.invocationCallOrder[0]!).toBeLessThan(focus.mock.invocationCallOrder[0]!);
});
test("explicit compact targets override the default, advance an already visible open, and reject automation", async () => {
    const { capture, invoke } = fixture();
    await capture.shortcutHandler();
    expect(await invoke("capture:context")).not.toHaveProperty("preselectedTarget");
    await capture.openForTarget("a");
    expect(await invoke("capture:context")).toMatchObject({ openId: 2, preselectedTarget: "a" });
    await capture.openForTarget(null);
    expect(await invoke("capture:context")).toMatchObject({ openId: 3, preselectedTarget: null });
    invoke("capture:close", 2); expect(capture.window.isVisible()).toBe(true);
    for (const id of ["child", "auto", "exec", "missing"]) await expect(capture.openForTarget(id)).rejects.toThrow();
    invoke("capture:close", 3);
    await capture.shortcutHandler();
    expect(await invoke("capture:context")).not.toHaveProperty("preselectedTarget");
});

test("a save from a superseded open is rejected so it never lands on the previous target", async () => {
    const { capture, core, invoke } = fixture();
    await capture.shortcutHandler();
    const stale = Reflect.get(capture, "openId") as number;
    await capture.openForTarget(null);
    const request = { sessionId: "a", body: "旧目标", expectedRevision: 0, operationId: "stale" };
    expect(() => invoke("capture:idea", request, undefined, stale)).toThrow(CAPTURE_STALE_OPEN);
    expect(core.call).not.toHaveBeenCalledWith(expect.objectContaining({ method: "idea.save", operationId: "stale" }));
});

test("T18 compact new-session preselects Codex by default and the persisted last-used app thereafter", async () => {
    const { capture, core, invoke } = fixture();
    await capture.openForNewSession();
    expect(await invoke("capture:context")).toMatchObject({ openId: 1, preselectedTarget: NEW_SESSION_TARGETS.codex });
    core.snapshot().settings.lastNewSessionApp = "claude";
    await capture.openForNewSession();
    expect(await invoke("capture:context")).toMatchObject({ openId: 2, preselectedTarget: NEW_SESSION_TARGETS.claude });
});
test("T18 handoff ignores native blur and closes only the capture window, never app.hide", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    try {
        const { capture, invoke, newSession } = fixture();
        await capture.openForNewSession();
        const request = { kind: "capture", app: "codex", body: "原文", expectedRevision: 0, operationId: "new" };
        let release: () => void = () => {};
        newSession.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ message: "已复制", brought: 1 }); }));
        const pending = invoke("capture:new-session", request);
        (capture.window as unknown as EventEmitter).emit("blur");
        expect(capture.window.isVisible()).toBe(true); expect(app.hide).not.toHaveBeenCalled();
        release(); await pending;
        invoke("capture:close", 1);
        expect(capture.window.isVisible()).toBe(false); expect(app.hide).not.toHaveBeenCalled();
        await capture.shortcutHandler();
        (capture.window as unknown as EventEmitter).emit("blur");
        expect(app.hide).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
});
test("T18 stale or invalid new-session requests have no side effects; old close cannot hide a reopened capture", async () => {
    const { capture, invoke, newSession } = fixture();
    await capture.openForNewSession();
    const request = { kind: "capture", app: "claude", body: "原文", expectedRevision: 0, operationId: "new" };
    for (const bad of [{ ...request, app: "other" }, { ...request, expectedRevision: 1 }, { ...request, body: " " }, { ...request, kind: "inbox", idea: { id: "a", revision: 1 } }])
        expect(() => invoke("capture:new-session", bad)).toThrow();
    await capture.openForTarget(null);
    expect(() => invoke("capture:new-session", request, undefined, 1)).toThrow(CAPTURE_STALE_OPEN);
    expect(newSession).not.toHaveBeenCalled();
    await invoke("capture:new-session", request);
    expect(newSession).toHaveBeenCalledExactlyOnceWith(request);
    await capture.openForTarget("a");
    invoke("capture:close", 2);
    expect(capture.window.isVisible()).toBe(true);
});

test("T23 capture publishes language immediately and translates its existing shortcut error", async () => {
    const { capture, core, invoke } = fixture();
    await capture.ready;
    await capture.openForTarget("a");
    const before = await invoke("capture:context");
    vi.mocked(globalShortcut.register).mockReturnValueOnce(false);
    capture.register("invalid-conflicting-shortcut");
    core.snapshot().settings.language = "en";
    capture.publish(core.snapshot());
    expect(capture.window.setTitle).toHaveBeenCalledWith("AimSpan Quick capture");
    expect(capture.window.webContents.send).toHaveBeenCalledWith("capture:language", "en");
    const next = await invoke("capture:context");
    expect(next).toMatchObject({ language: "en", openId: before.openId, preselectedTarget: "a" });
    capture.stop();
});
