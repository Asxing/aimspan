import { translator } from "../shared/i18n";
import { app, BrowserWindow, globalShortcut, ipcMain, screen } from "electron";
import { join } from "node:path";
import { CAPTURE_STALE_OPEN, DEFAULT_SETTINGS, CAPTURE_DRAFT_KEY, NEW_SESSION_TARGETS, isIdeaTargetSession, object, validNewSessionRequest, validRequest, type BringBackResult, type CaptureNewSessionRequest, type CaptureContext, type CoreRequest, type Workspace } from "@aimspan/protocol";

type Rect = { x: number; y: number; width: number; height: number };
export function captureBounds(area: Rect): Rect {
    const width = Math.min(560, area.width), height = Math.min(210, area.height);
    return { width, height, x: Math.round(area.x + (area.width - width) / 2),
        y: Math.round(area.y + Math.min(area.height * 0.2, area.height - height)) };
}
export function captureContext(workspace: Workspace, openId: number): CaptureContext {
    const sessions = workspace.sessions.filter(isIdeaTargetSession).map(({ id, nativeId, agent, title, project, state, lastPromptAt, lastTurnEndAt, lastActivityAt, observedAt, pendingIdeaCount, hasNewResult, active, archived }) =>
        ({ id, nativeId, agent, title, project, state, lastPromptAt, lastTurnEndAt, lastActivityAt, observedAt, pendingIdeaCount, hasNewResult, active, archived }));
    const draft = workspace.drafts[CAPTURE_DRAFT_KEY];
    return { language: workspace.settings.language, openId, sessions, inboxIdeaCount: workspace.inboxIdeaCount, drafts: draft ? { [CAPTURE_DRAFT_KEY]: draft } : {} };
}

export class CaptureWindow {
    private readonly t = translator(() => this.core.snapshot()?.settings.language ?? "en");
    readonly window: BrowserWindow;
    readonly ready: Promise<void>;
    private openId = 0;
    private preselectedTarget: string | null | undefined;
    private handoffOpenId: number | undefined;
    private shortcut: string | undefined;
    private registeredShortcut: string | undefined;
    private stopped = false;
    private shortcutErrorKey: "captureShortcutUnavailable" | "captureShortcutInvalid" | undefined;
    get shortcutError() { return this.shortcutErrorKey ? this.t(this.shortcutErrorKey) : undefined; }

    constructor(private readonly core: { call(request: CoreRequest): Promise<unknown>; snapshot(): Workspace | undefined }, private readonly panelVisible: () => boolean,
        private readonly quitting: () => boolean, dev?: string, private readonly reshowPanel: () => void = () => {},
        private readonly reshowCompanions: () => void = () => {},
        private readonly newSession: (request: CaptureNewSessionRequest) => Promise<BringBackResult> = async () => { throw new Error(this.t("newSessionUnavailable")); }) {
        this.window = new BrowserWindow({ width: 560, height: 210, frame: false, resizable: false, maximizable: false, minimizable: false,
            fullscreenable: false, alwaysOnTop: true, skipTaskbar: true, show: false, title: this.t("captureTitle"),
            // Native material and window corners/shadow work with the floating frameless window.
            // Keep the page background translucent; transparent:true is unnecessary for vibrancy.
            roundedCorners: true, hasShadow: true, backgroundColor: "#00000000", vibrancy: "popover", visualEffectState: "active",
            webPreferences: { preload: join(__dirname, "../preload/capture.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
        this.window.setAlwaysOnTop(true, "floating");
        this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        // Native opening transfers focus immediately; keep the receipt visible until its close timer.
        this.window.on("blur", () => { if (this.handoffOpenId !== this.openId) this.hide(); });
        this.window.on("close", event => { if (!this.quitting()) { event.preventDefault(); this.hide(); } });
        this.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        this.window.webContents.on("will-navigate", (event, url) => { if (url !== this.window.webContents.getURL()) event.preventDefault(); });
        const valid = (event: Electron.IpcMainInvokeEvent) => {
            if (event.sender !== this.window.webContents || event.senderFrame !== this.window.webContents.mainFrame) throw new Error(this.t("errorUntrustedCaptureWindow"));
        };
        const destination = (id: unknown) => {
            if (id === null) return;
            const session = this.core.snapshot()?.sessions.find(s => s.id === id);
            if (!session || !isIdeaTargetSession(session)) throw new Error(this.t("chooseInteractiveSession"));
        };
        ipcMain.handle("capture:context", async event => {
            valid(event);
            const workspace = await this.core.call({ method: "workspace" }) as Workspace;
            return { ...captureContext(workspace, this.openId), ...(this.preselectedTarget === undefined ? {} : { preselectedTarget: this.preselectedTarget }) };
        });
        ipcMain.handle("capture:idea", (event, value: unknown, openId: unknown) => {
            valid(event);
            // A save racing a reopen must not land on the previous target.
            if (openId !== this.openId) throw new Error(CAPTURE_STALE_OPEN);
            if (!object(value)) throw new Error(this.t("errorInvalidCaptureIdea"));
            const request = { method: "idea.save", sessionId: value.sessionId, body: value.body, operationId: value.operationId, expectedRevision: value.expectedRevision };
            if (!validRequest(request) || request.method !== "idea.save" || request.expectedRevision !== 0 || !request.body.trim() || value.id !== undefined) throw new Error(this.t("errorInvalidCaptureIdea"));
            destination(request.sessionId);
            return this.core.call(request);
        });
        ipcMain.handle("capture:draft", (event, value: unknown) => {
            valid(event);
            if (!validRequest(value) || value.method !== "draft.save" || value.target !== "capture") throw new Error(this.t("errorInvalidCaptureDraft"));
            return this.core.call({ method: "draft.save", target: "capture", body: value.body, expectedRevision: value.expectedRevision, operationId: value.operationId });
        });
        ipcMain.handle("capture:new-session", (event, value: unknown, openId: unknown) => {
            valid(event);
            if (openId !== this.openId) throw new Error(CAPTURE_STALE_OPEN);
            if (!validNewSessionRequest(value) || value.kind !== "capture") throw new Error(this.t("errorInvalidCaptureNewSession"));
            const generation = this.openId;
            this.handoffOpenId = generation;
            return this.newSession(value).catch(error => {
                if (this.handoffOpenId === generation) this.handoffOpenId = undefined;
                throw error;
            });
        });
        ipcMain.handle("capture:close", (event, openId: unknown) => { valid(event); if (openId === this.openId) this.hide(); });
        this.ready = dev ? this.window.loadURL(new URL("capture.html", dev).toString()) : this.window.loadFile(join(__dirname, "../renderer/capture.html"));
    }

    /** Also called directly by the opt-in lifecycle harness; no synthetic OS shortcut. */
    readonly shortcutHandler = () => this.open();
    /** Explicit target selection for the compact list; no synthetic shortcut/keys. */
    openForTarget(sessionId: string | null) {
        if (sessionId !== null && !this.core.snapshot()?.sessions.some(s => s.id === sessionId && isIdeaTargetSession(s)))
            return Promise.reject(new Error(this.t("chooseInteractiveSession")));
        return this.open(sessionId);
    }
    openForNewSession() {
        return this.open(NEW_SESSION_TARGETS[this.core.snapshot()?.settings.lastNewSessionApp ?? "codex"]);
    }
    private async open(target?: string | null) {
        await this.ready;
        if (this.stopped || this.window.isDestroyed()) return;
        if (!this.window.isVisible() || target !== undefined) { this.openId++; this.preselectedTarget = target; this.handoffOpenId = undefined; }
        this.window.setBounds(captureBounds(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea));
        // Announce the open before the window can receive focus or keys, so the page blocks
        // saving until the new context (and target) has loaded.
        this.window.webContents.send("capture:opened", this.openId);
        this.window.show();
        // A global shortcut fires while another app is frontmost; take focus so typing lands here.
        if (process.platform === "darwin") app.focus({ steal: true });
        this.window.focus();
    }
    publish(workspace: Workspace) {
        this.window.setTitle(this.t("captureTitle"));
        this.window.webContents.send("capture:language", workspace.settings.language);
        this.register(workspace.settings.captureShortcut);
    }
    register(preference: string | undefined) {
        const shortcut = preference ?? DEFAULT_SETTINGS.captureShortcut!;
        if (this.stopped || shortcut === this.shortcut) return;
        if (this.registeredShortcut) globalShortcut.unregister(this.registeredShortcut);
        this.registeredShortcut = undefined;
        this.shortcut = shortcut;
        this.shortcutErrorKey = undefined;
        try {
            if (!shortcut || !globalShortcut.register(shortcut, () => { void this.shortcutHandler().catch(() => {}); }))
                this.shortcutErrorKey = "captureShortcutUnavailable";
            else this.registeredShortcut = shortcut;
        } catch { this.shortcutErrorKey = "captureShortcutInvalid"; }
    }
    hide() {
        if (this.window.isDestroyed() || !this.window.isVisible()) return;
        this.window.hide();
        // The newly opened app already owns focus. app.hide() would restore the previous app instead.
        if (this.handoffOpenId === this.openId) return;
        if (process.platform !== "darwin") return;
        // Hiding the app hands focus back to the previously active app; a visible
        // (pinned) panel is then shown again without taking focus.
        const keepPanel = this.panelVisible();
        app.hide();
        if (keepPanel) this.reshowPanel();
        this.reshowCompanions();
    }
    stop() { this.stopped = true; if (this.registeredShortcut) globalShortcut.unregister(this.registeredShortcut); this.registeredShortcut = undefined; }
}
