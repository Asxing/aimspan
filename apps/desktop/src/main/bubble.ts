import { translator } from "../shared/i18n";
import { BrowserWindow, globalShortcut, ipcMain, Menu, screen } from "electron";
import { join } from "node:path";
import { isAttentionSession, isIdeaTargetSession, notificationsEnabled, object, validRequest, type BubblePosition, type BubbleState, type CompactState, type CoreRequest, type PanelTarget, type Settings, type Workspace } from "@aimspan/protocol";
import { DIAMETER, RADIUS, COMPACT_WIDTH, bubbleFrame, bubbleOpacity, compactBounds, contains, isDrag, restore, snap, type BubbleDisplay, type Point } from "./bubble-geometry";
import { BubbleInteraction, visualState } from "./bubble-state";
import { compactSessions } from "../renderer/session-list";
import type { PanelAnchor } from "./panel";

type Core = { snapshot(): Workspace | undefined; call(request: CoreRequest): Promise<unknown> };
type Actions = { panel(target?: PanelTarget, anchor?: PanelAnchor): void; capture(target: string | null): Promise<void>; newSession(): Promise<void>; quitting(): boolean };
const validPoint = (p: unknown): p is Point => object(p) && [p.x, p.y].every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1_000_000);

export class BubbleWindow {
    private readonly t = translator(() => this.core.snapshot()?.settings.language ?? "en");
    readonly window: BrowserWindow;
    readonly list: BrowserWindow;
    readonly ready: Promise<void>;
    readonly interaction: BubbleInteraction;
    private shortcutErrorKey: "bubbleShortcutUnavailable" | "bubbleShortcutInvalid" | undefined;
    get shortcutError() { return this.shortcutErrorKey ? this.t(this.shortcutErrorKey) : undefined; }
    private position: BubblePosition;
    private workspace: Workspace | undefined;
    private lastEnd: number | undefined;
    private pulse = 0;
    private pulseTimer: ReturnType<typeof setTimeout> | undefined;
    private wakeTimer: ReturnType<typeof setTimeout> | undefined;
    private poll: ReturnType<typeof setInterval> | undefined;
    private drag: { start: Point; origin: Point; moved: boolean } | undefined;
    private shortcut: string | undefined;
    private registeredShortcut: string | undefined;
    private loaded = false;
    private stopped = false;
    private menuOpen = false;
    private settingsQueue: Promise<unknown> = Promise.resolve();
    private lastSettingsPosition = "";

    /** The cursor source is injectable so the lifecycle harness never depends on the real pointer. */
    constructor(private readonly core: Core, private readonly actions: Actions, dev?: string, private readonly cursor: () => Electron.Point = () => screen.getCursorScreenPoint()) {
        this.workspace = core.snapshot();
        this.position = restore(this.workspace?.settings.bubblePosition, this.displays());
        const options = { frame: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
            movable: false, skipTaskbar: true, alwaysOnTop: true, show: false, acceptFirstMouse: true };
        const preferences = (name: string) => ({ preload: join(__dirname, `../preload/${name}.cjs`), contextIsolation: true, nodeIntegration: false, sandbox: true });
        this.window = new BrowserWindow({ ...options, width: DIAMETER * 2, height: DIAMETER, transparent: true, hasShadow: false, focusable: false,
            backgroundColor: "#00000000", title: this.t("bubbleTitle"), webPreferences: preferences("bubble") });
        this.list = new BrowserWindow({ ...options, width: COMPACT_WIDTH, height: 104, focusable: true,
            backgroundColor: "#00000000", title: this.t("compactTitle"), webPreferences: preferences("compact") });
        this.interaction = new BubbleInteraction(() => this.render());
        for (const win of [this.window, this.list]) {
            win.setAlwaysOnTop(true, "screen-saver");
            win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
            win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
            win.webContents.on("will-navigate", (event, url) => { if (url !== win.webContents.getURL()) event.preventDefault(); });
            win.on("close", event => { if (!actions.quitting()) { event.preventDefault(); this.interaction.close(); } });
        }
        // Showing/pinning never activates the list. It remains focusable for a
        // user's direct click, after which its local Escape key can dismiss it.
        // App switches/blur do not change the pinned state.
        this.list.webContents.on("before-input-event", (event, input) => {
            if (input.key === "Escape" && !input.isComposing && this.list.isFocused()) { event.preventDefault(); this.interaction.close(); }
        });
        const handle = (win: BrowserWindow, channel: string, fn: (value: unknown, extra: unknown) => unknown) => {
            ipcMain.handle(channel, (event, value: unknown, extra: unknown) => {
                if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error(this.t("errorUntrustedBubbleWindow"));
                if (this.stopped) return;
                return fn(value, extra);
            });
        };
        handle(this.window, "bubble:state", () => this.state());
        handle(this.list, "compact:state", () => this.compactState());
        for (const [surface, win] of [["bubble", this.window], ["list", this.list]] as const) {
            handle(win, surface === "bubble" ? "bubble:hover" : "compact:hover", inside => {
                if (typeof inside !== "boolean") throw new Error(this.t("errorInvalidHover"));
                if (!this.drag && !this.menuOpen) {
                    if (surface === "bubble") this.pollCursor();
                    else this.interaction.hover("list", inside);
                }
            });
        }
        handle(this.window, "bubble:pointer", (phase, point) => {
            if (!["down", "move", "up", "cancel"].includes(String(phase)) || !validPoint(point)) throw new Error(this.t("errorInvalidPointer"));
            const buttons = "buttons" in point ? point.buttons : undefined;
            if (buttons !== undefined && (typeof buttons !== "number" || !Number.isInteger(buttons) || buttons < 0 || buttons > 65535)) throw new Error(this.t("errorInvalidPointerButtons"));
            if (phase !== "cancel") this.sampleCursor(point, buttons ?? (phase === "down" ? 1 : phase === "up" ? 0 : null));
            this.pointer(String(phase), point);
        });
        handle(this.window, "bubble:toggle", () => this.toggle());
        handle(this.window, "bubble:menu", () => this.menu());
        handle(this.list, "compact:close", () => this.interaction.close());
        handle(this.list, "compact:pin", () => this.interaction.togglePinned());
        const session = (id: unknown) => {
            const target = this.core.snapshot()?.sessions.find(s => s.id === id && isAttentionSession(s));
            if (!target) throw new Error(this.t("sessionNoLongerActive"));
            return target;
        };
        handle(this.list, "compact:session", id => { const target = session(id); actions.panel({ kind: "session", sessionId: target.id }, { kind: "bubble", position: { ...this.position }, ...(this.interaction.pinned && this.list.isVisible() ? { avoid: this.list.getBounds() } : {}) }); this.interaction.actionCompleted(); });
        handle(this.list, "compact:capture", async id => { const target = id === null ? null : session(id).id; await actions.capture(target); this.interaction.actionCompleted(); });
        handle(this.list, "compact:new-session", async () => { await actions.newSession(); this.interaction.actionCompleted(); });
        const mutate = async (value: unknown, pin: boolean) => {
            if (!object(value) || pin && typeof value.pinned !== "boolean") throw new Error(this.t("errorInvalidCompactAction"));
            const request = { method: pin ? value.pinned ? "session.pin" : "session.unpin" : "session.handled",
                sessionId: value.sessionId, expectedRevision: value.expectedRevision, operationId: value.operationId };
            if (!validRequest(request)) throw new Error(this.t("errorInvalidCompactAction"));
            // A replay may arrive after handled/unpin removed the row. Core owns
            // idempotency and revision checks; do not gate it on the new state.
            const target = core.snapshot()?.sessions.find(s => s.id === value.sessionId && isIdeaTargetSession(s));
            if (!target) throw new Error(this.t("sessionUnavailable"));
            await core.call(request);
        };
        handle(this.list, "compact:pin-session", value => mutate(value, true));
        handle(this.list, "compact:handled", value => mutate(value, false));
        screen.on("display-added", this.restoreDisplay);
        screen.on("display-removed", this.restoreDisplay);
        screen.on("display-metrics-changed", this.restoreDisplay);
        const load = (win: BrowserWindow, page: string) => dev ? win.loadURL(new URL(`${page}.html`, dev).toString()) : win.loadFile(join(__dirname, `../renderer/${page}.html`));
        this.ready = Promise.all([load(this.window, "bubble"), load(this.list, "compact")]).then(() => {
            if (this.stopped) return;
            this.loaded = true;
            this.poll = setInterval(() => this.pollCursor(), 50);
            const workspace = this.core.snapshot();
            if (workspace) this.publish(workspace);
        });
    }
    private displays(): BubbleDisplay[] {
        const primaryId = screen.getPrimaryDisplay().id;
        return screen.getAllDisplays().map(d => ({ bounds: d.bounds, workArea: d.workArea, primary: d.id === primaryId }));
    }
    private visible() {
        return !this.stopped && this.workspace?.settings.bubbleEnabled !== false && (this.workspace?.settings.bubbleHiddenUntil ?? 0) <= Date.now();
    }
    private state(): BubbleState {
        const visual = visualState(this.workspace?.sessions ?? [], this.lastEnd);
        const revealed = !!this.drag || this.interaction.bubble || this.interaction.open;
        return { language: this.workspace?.settings.language ?? "en", waiting: visual.waiting, running: visual.running, pulse: this.pulse, side: this.position.side,
            circleX: bubbleFrame(this.position, this.displays(), revealed).circleX, revealed, open: this.interaction.open, pinned: this.interaction.pinned };
    }
    private compactState(): CompactState {
        return { language: this.workspace?.settings.language ?? "en", pinned: this.interaction.pinned, sessions: compactSessions(this.workspace?.sessions ?? [])
            .map(({ id, nativeId, title, agent, surface, entrypoint, interactive, pinned, revision, state, lastPromptAt, lastTurnEndAt, lastActivityAt, observedAt, pendingIdeaCount, hasNewResult }) =>
                ({ id, nativeId, title, agent, surface, entrypoint, interactive, pinned, revision, state, lastPromptAt, lastTurnEndAt, lastActivityAt, observedAt, pendingIdeaCount, hasNewResult })) };
    }
    publish(workspace: Workspace) {
        if (this.stopped) return;
        this.workspace = workspace;
        this.window.setTitle(this.t("bubbleTitle"));
        this.list.setTitle(this.t("compactTitle"));
        const positionKey = JSON.stringify(workspace.settings.bubblePosition);
        if (positionKey !== this.lastSettingsPosition) {
            this.lastSettingsPosition = positionKey;
            if (!this.drag) this.position = restore(workspace.settings.bubblePosition, this.displays());
        }
        const visual = visualState(workspace.sessions, this.lastEnd);
        this.lastEnd = visual.lastEnd;
        if (visual.pulse && this.visible() && (workspace.settings.dndUntil ?? 0) <= Date.now()) {
            this.pulse = visual.lastEnd;
            clearTimeout(this.pulseTimer);
            this.pulseTimer = setTimeout(() => { this.pulse = 0; this.render(); }, 1500);
        }
        this.register(workspace.settings.bubbleShortcut ?? "");
        clearTimeout(this.wakeTimer);
        const deadlines = [workspace.settings.bubbleHiddenUntil, workspace.settings.dndUntil]
            .map(until => (until ?? 0) - Date.now()).filter(remaining => remaining > 0);
        if (deadlines.length) this.wakeTimer = setTimeout(() => this.publish(this.core.snapshot() ?? workspace), Math.min(...deadlines, 2_147_483_647));
        if (!this.visible()) { this.drag = undefined; this.interaction.reset(); }
        this.render();
    }
    private render() {
        if (!this.loaded || this.stopped || this.window.isDestroyed() || this.list.isDestroyed()) return;
        if (!this.visible()) { this.window.webContents.send("bubble:state", this.state()); this.list.webContents.send("compact:state", this.compactState()); this.window.hide(); this.list.hide(); return; }
        const state = this.state(), frame = bubbleFrame(this.position, this.displays(), state.revealed);
        const previous = this.window.getBounds();
        if (previous.width !== frame.bounds.width || previous.height !== frame.bounds.height) {
            this.window.setBounds(frame.bounds);
        } else if (previous.x !== frame.bounds.x || previous.y !== frame.bounds.y) {
            this.window.setPosition(frame.bounds.x, frame.bounds.y);
        }
        if (!this.drag) this.window.setIgnoreMouseEvents(!this.onBubble(this.cursor()), { forward: true });
        this.window.setOpacity(bubbleOpacity(this.position.side, state.revealed, (this.workspace?.settings.dndUntil ?? 0) > Date.now()));
        this.window.webContents.send("bubble:state", state);
        if (!this.window.isVisible()) this.window.showInactive();
        const compact = this.compactState();
        this.list.webContents.send("compact:state", compact);
        if (this.interaction.open) {
            this.list.setBounds(compactBounds(this.position, this.displays(), compact.sessions.length));
            if (!this.list.isVisible()) this.list.showInactive();
        } else this.list.hide();
    }
    /** Also used after Capture's app.hide(), without activating either surface. */
    reshowInactive() { this.render(); if (this.visible() && this.loaded) { this.window.showInactive(); if (this.interaction.open) this.list.showInactive(); } }
    /** Tray and shortcut share the existing serialized settings path. */
    setEnabled(enabled: boolean) { return this.save({ bubbleEnabled: enabled, bubbleHiddenUntil: 0 }); }
    private onBubble(point: Point) {
        const bounds = this.window.getBounds(), state = this.state();
        const restingX = bubbleFrame(this.position, this.displays(), false).circleX;
        // Keep the old half's hit area during the slide so a stationary pointer
        // near its arc cannot trigger a reveal/hide oscillation.
        return contains(bounds, point) && [state.circleX, ...(state.revealed ? [restingX] : [])]
            .some(x => Math.hypot(point.x - (bounds.x + x + RADIUS), point.y - (bounds.y + RADIUS)) <= RADIUS);
    }
    private pollCursor() {
        // A hidden bubble (or DND hide) must not touch the native cursor 20 times a second.
        if (!this.visible() || this.drag || this.menuOpen) return;
        this.sampleCursor(this.cursor(), null);
    }
    private sampleCursor(point: Point, buttons: number | null) {
        if (!this.visible() || this.drag || this.menuOpen) return;
        const bubble = this.onBubble(point);
        // Empty transparent padding must not intercept clicks in the underlying app.
        this.window.setIgnoreMouseEvents(!bubble, { forward: true });
        this.interaction.sample({ ...point, at: Date.now(), inside: bubble, buttons });
        this.interaction.hover("list", this.list.isVisible() && contains(this.list.getBounds(), point));
    }
    private toggle() {
        if (!this.visible()) return;
        // The state change renders via showInactive(), including first-time pinning.
        this.interaction.toggle();
    }
    private pointer(phase: string, point: Point) {
        if (!this.visible()) return;
        if (phase === "down") {
            const { bounds, circleX } = bubbleFrame(this.position, this.displays(), true);
            this.drag = { start: point, origin: { x: bounds.x + circleX, y: bounds.y }, moved: false };
            this.window.setIgnoreMouseEvents(false);
            return;
        }
        const drag = this.drag;
        if (!drag) return;
        if (phase === "cancel") { this.drag = undefined; this.interaction.reset(); this.restoreDisplay(); return; }
        if (isDrag(drag.start, point)) drag.moved = true;
        if (drag.moved) {
            this.position = { x: Math.round(drag.origin.x + point.x - drag.start.x), y: Math.round(drag.origin.y + point.y - drag.start.y), side: "free" };
            this.interaction.close();
            this.render();
        }
        if (phase !== "up") return;
        this.drag = undefined;
        if (drag.moved) {
            this.position = snap(this.position, this.displays());
            this.interaction.reset(); this.render();
            this.save({ bubblePosition: this.position });
        } else this.toggle();
    }
    private readonly restoreDisplay = () => {
        this.drag = undefined;
        this.position = restore(this.position, this.displays());
        this.render();
        this.save({ bubblePosition: this.position });
    };
    private save(patch: Partial<Settings>) {
        this.settingsQueue = this.settingsQueue.then(async () => {
            if (this.stopped) return;
            const current = this.core.snapshot();
            if (current) {
                const settings = { ...current.settings, ...patch };
                await this.core.call({ method: "settings.save", settings: { ...settings, notifications: notificationsEnabled(settings) } });
            }
        }).catch(error => console.error("Bubble settings:", error instanceof Error ? error.message : "save failed"));
        return this.settingsQueue;
    }
    private menu() {
        this.menuOpen = true;
        this.interaction.close();
        Menu.buildFromTemplate([
            { label: this.t("dndHour"), click: () => { this.save({ dndUntil: Date.now() + 3_600_000 }); } },
            { label: this.t("hideBubble"), click: () => { this.save({ bubbleEnabled: false }); } },
            { label: this.t("hideHour"), click: () => { this.save({ bubbleHiddenUntil: Date.now() + 3_600_000 }); } },
            { label: this.t("openPanel"), click: () => this.actions.panel(undefined, { kind: "bubble", position: { ...this.position } }) },
            { label: this.t("settings"), click: () => this.actions.panel({ kind: "settings" }, { kind: "bubble", position: { ...this.position } }) },
        ]).popup({ window: this.window, callback: () => { this.menuOpen = false; this.pollCursor(); } });
    }
    private register(shortcut: string) {
        if (shortcut === this.shortcut) return;
        if (this.registeredShortcut) globalShortcut.unregister(this.registeredShortcut);
        this.registeredShortcut = undefined; this.shortcut = shortcut; this.shortcutErrorKey = undefined;
        if (!shortcut) return;
        try {
            if (globalShortcut.register(shortcut, () => { this.setEnabled(!this.visible()); })) this.registeredShortcut = shortcut;
            else this.shortcutErrorKey = "bubbleShortcutUnavailable";
        } catch { this.shortcutErrorKey = "bubbleShortcutInvalid"; }
    }
    stop() {
        this.stopped = true; this.interaction.stop();
        clearInterval(this.poll); clearTimeout(this.wakeTimer); clearTimeout(this.pulseTimer);
        if (this.registeredShortcut) globalShortcut.unregister(this.registeredShortcut);
        screen.removeListener("display-added", this.restoreDisplay);
        screen.removeListener("display-removed", this.restoreDisplay);
        screen.removeListener("display-metrics-changed", this.restoreDisplay);
    }
}
