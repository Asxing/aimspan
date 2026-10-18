import { messageRef, messageResult } from "../shared/i18n/messages";
import { errorMessage } from "../shared/i18n/errors";
import { trayMenuTemplate } from "./tray-menu";
import { translator } from "../shared/i18n";
import { app, BrowserWindow, ipcMain, dialog, Tray, Menu, shell, clipboard, screen, nativeTheme } from "electron";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { lstatSync, mkdirSync, chmodSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import type { PanelTarget, Workspace } from "@aimspan/protocol";
import { validRendererRequest, validNewSessionRequest, text } from "@aimspan/protocol";
import { CoreClient } from "./core-client";
import { installShutdown } from "./shutdown";
import { BringBack, allowedLink, openSession } from "./bring-back";
import { NEW_SESSION_ENTRIES, newSessionHint, openNewSession } from "./session-entry";
import { PanelPlacement, trayTitle, type PanelAnchor } from "./panel";
import { runLifecycleSmoke, testCursor } from "./lifecycle-smoke";
import { resolveSourceRoots } from "./source-roots";
import { CaptureWindow } from "./capture";
import { BubbleWindow } from "./bubble";
import { SessionNotifications } from "./notifications";
const require = createRequire(__filename);
let window: BrowserWindow, core: CoreClient, tray: Tray | undefined, capture: CaptureWindow | undefined, bubble: BubbleWindow | undefined, notifications: SessionNotifications | undefined;
const shutdown = installShutdown({ app, ipc: ipcMain, getWindows: () => [window?.webContents, capture?.window.webContents], getCore: () => core,
    onQuit: () => { clearTimeout(blurTimer); capture?.stop(); bubble?.stop(); notifications?.stop(); } });
const panelWorkspace = (w: Workspace): Workspace => ({ ...w, ...(capture?.shortcutError ? { captureShortcutError: capture.shortcutError } : {}),
    ...(bubble?.shortcutError ? { bubbleShortcutError: bubble.shortcutError } : {}) });
const t = translator(() => core?.snapshot()?.settings.language ?? "en");
let pinned = false;
let dialogOpen = false;
let blurTimer: ReturnType<typeof setTimeout> | undefined;
const panelPlacement = new PanelPlacement();
async function withPanelDialog<T>(show: () => Promise<T>): Promise<T> {
    dialogOpen = true;
    try { return await show(); } finally { dialogOpen = false; }
}
function anchorPanel() {
    if (pinned || !window || window.isDestroyed()) return;
    const current = window.getBounds();
    const primary = screen.getPrimaryDisplay().id;
    const displays = screen.getAllDisplays().map(d => ({ bounds: d.bounds, workArea: d.workArea, primary: d.id === primary }));
    const next = panelPlacement.bounds(current, pinned, displays, tray && !tray.isDestroyed() ? tray.getBounds() : undefined);
    // Electron's minimum size must permit the work-area clamp on small displays.
    window.setMinimumSize(Math.min(420, next.width), Math.min(360, next.height));
    if (current.x !== next.x || current.y !== next.y || current.width !== next.width || current.height !== next.height) window.setBounds(next);
}
function showPanelAt(anchor: PanelAnchor) { panelPlacement.select(anchor); showPanel(); }
function showPanel() { if (!window) return; clearTimeout(blurTimer); anchorPanel(); window.show(); window.focus(); }
function openPanel(target?: PanelTarget, anchor: PanelAnchor = { kind: "tray" }) {
    showPanelAt(anchor);
    if (process.platform === "darwin") app.focus({ steal: true });
    if (target) window.webContents.send("panel:open", target);
}
function togglePanel() { clearTimeout(blurTimer); if (window.isVisible()) window.hide(); else showPanelAt({ kind: "tray" }); }
app.setName("aimspan");
if (process.env.AIMSPAN_TEST_PROFILE)
    app.setPath("userData", resolve(process.env.AIMSPAN_TEST_PROFILE));
if (!app.requestSingleInstanceLock()) {
    app.quit();
}
else {
    app.on("second-instance", showPanel);
    app.whenReady().then(async () => {
        nativeTheme.themeSource = "system";
        app.dock?.hide();
        const profile = app.getPath("userData");
        mkdirSync(profile, { recursive: true, mode: 0o700 });
        const stat = lstatSync(profile);
        if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new Error(t("errorUnsafeAppDirectory"));
        chmodSync(profile, 0o700);
        const entry = require.resolve("@aimspan/core").replace(/index\.js$/, "worker.js");
        core = new CoreClient(entry, { directory: join(profile, "state"), ...resolveSourceRoots(homedir(), process.env) });
        window = new BrowserWindow({ width: 420, height: 640, minWidth: 420, maxWidth: 420, minHeight: 360, frame: false, movable: false, resizable: true, skipTaskbar: true, title: t("appTitle"), show: false, webPreferences: { preload: join(__dirname, "../preload/index.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
        window.on("close", e => { if (!shutdown.complete()) {
            e.preventDefault();
            window.hide();
        } });
        // A tray click can blur before its click event; allow that event to toggle the visible panel.
        window.on("blur", () => { clearTimeout(blurTimer); blurTimer = setTimeout(() => { if (!pinned && !dialogOpen && tray && !window.isDestroyed() && !window.isFocused()) window.hide(); }, 150); });
        window.on("focus", () => clearTimeout(blurTimer));
        window.on("resize", anchorPanel);
        screen.on("display-metrics-changed", anchorPanel);
        screen.on("display-removed", anchorPanel);
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-navigate", (e, url) => { if (url !== window.webContents.getURL())
            e.preventDefault(); });
        const valid = (e: Electron.IpcMainInvokeEvent) => { if (e.sender !== window.webContents || e.senderFrame !== window.webContents.mainFrame)
            throw new Error(t("errorUntrustedWindow")); };
        ipcMain.handle("panel:hide", e => { valid(e); clearTimeout(blurTimer); window.hide(); });
        ipcMain.handle("companion:call", async (e, r: unknown) => { valid(e); if (!validRendererRequest(r))
            throw new Error(t("errorInvalidOperation")); if (r.method === "settings.save") {
            const allowed = new Set(core.snapshot()?.settings.roots ?? []);
            if (r.settings.roots.some(p => !allowed.has(p)))
                throw new Error(t("errorChooseADirectoryUsingTheSystemPicker"));
        } const result = await core.call(r); return r.method === "workspace" ? panelWorkspace(result as Workspace) : result; });
        const exportPaths = new Map<string, string>();
        ipcMain.handle("companion:export", async (e, operationId: unknown) => {
            valid(e);
            if (!text(operationId, 160) || !operationId) throw new Error(t("errorInvalidExportOperation"));
            let path = exportPaths.get(operationId);
            if (!path) {
                const result = await withPanelDialog(() => dialog.showSaveDialog(window, { title: t("exportTitle"), defaultPath: "aimspan-legacy.json", filters: [{ name: t("jsonFormat"), extensions: ["json"] }] }));
                if (result.canceled || !result.filePath) return null;
                path = result.filePath;
                if (exportPaths.size >= 256) throw new Error(t("errorTooManyExportOperationsReopenAimspan"));
                exportPaths.set(operationId, path);
            }
            return core.call({ method: "legacy.export", path, operationId });
        });
        ipcMain.handle("companion:root", async (e) => { valid(e); const result = await withPanelDialog(() => dialog.showOpenDialog(window, { title: t("chooseProject"), properties: ["openDirectory"] })); if (result.canceled)
            return; const selectedPath = result.filePaths[0];const path=selectedPath?realpathSync(selectedPath):undefined; if (!path)
            return; const current = core.snapshot(); if (!current)
            return; await core.call({ method: "settings.save", settings: { ...current.settings, roots: [...new Set([...current.settings.roots, path])] } }); await core.call({ method: "scan" }); });
        const smoke = !!process.env.AIMSPAN_TEST_PROFILE && !!process.env.AIMSPAN_TEST_REPORT;
        const nativeRequests: string[] = [];
        const openNative = async (session: Workspace["sessions"][number]) => {
            if (smoke) {
                nativeRequests.push(session.agent === "codex" ? `codex://threads/${encodeURIComponent(session.nativeId)}` : "/Applications/Claude.app");
                return messageResult(core.snapshot()?.settings.language ?? "en", messageRef("syntheticSessionOpened"));
            }
            return openSession(session, shell, core.snapshot()?.settings.language ?? "en");
        };
        const bringBack = new BringBack({ language: () => core.snapshot()?.settings.language ?? "en", call: request => core.call(request), writeText: value => clipboard.writeText(value), open: openNative,
            openNewSession: async target => {
                if (smoke) { nativeRequests.push(NEW_SESSION_ENTRIES[target]); return newSessionHint(target, core.snapshot()?.settings.language ?? "en"); }
                return openNewSession(target, shell, undefined, core.snapshot()?.settings.language ?? "en");
            } });
        ipcMain.handle("panel:bring-back", (e, request: unknown) => { valid(e); return bringBack.bringBack(request); });
        ipcMain.handle("panel:new-session", (e, request: unknown) => {
            valid(e);
            if (!validNewSessionRequest(request) || request.kind !== "inbox") throw new Error(t("errorInvalidInboxNewSession"));
            return bringBack.newSession(request);
        });
        ipcMain.handle("panel:undo-bring-back", (e, token: unknown) => { valid(e); return bringBack.undo(token); });
        ipcMain.handle("panel:open-link", async (e, url: unknown) => {
            valid(e);
            if (!allowedLink(url)) throw new Error(t("unsupportedLink"));
            await shell.openExternal(url);
        });
        ipcMain.handle("companion:reveal", async (e, id: unknown) => {
            valid(e);
            const session = core.snapshot()?.sessions.find(s => s.id === id);
            if (!session) throw new Error(t("sessionUnavailableRefresh"));
            return openNative(session);
        });
        await core.ready;
        const dev = process.env.AIMSPAN_VITE_DEV_SERVER_URL;
        capture = new CaptureWindow(core, () => !window.isDestroyed() && window.isVisible(), shutdown.complete, dev,
            () => { if (!window.isDestroyed()) window.showInactive(); }, () => bubble?.reshowInactive(), request => bringBack.newSession(request));
        await capture.ready;
        if (dev)
            await window.loadURL(dev);
        else
            await window.loadFile(join(__dirname, "../renderer/index.html"));
        bubble = new BubbleWindow(core, { panel: openPanel, capture: id => capture!.openForTarget(id), newSession: () => capture!.openForNewSession(), quitting: shutdown.complete }, dev,
            // The lifecycle harness simulates hover; a fixed off-screen pointer keeps the real mouse out of it.
            smoke ? () => ({ ...testCursor }) : undefined);
        await bubble.ready;
        const trayActions = {
            open: () => showPanelAt({ kind: "tray" }),
            capture: () => { void capture?.shortcutHandler().catch(() => showPanel()); },
            showBubble: (enabled: boolean) => { void bubble?.setEnabled(enabled); },
            settings: () => openPanel({ kind: "settings" }),
            quit: () => app.quit(),
        };
        let trayMenu: Electron.Menu | undefined;
        try {
            tray = new Tray(join(__dirname, "../brand/trayTemplate.png"));
            tray.setToolTip(t("trayTooltip"));
            tray.on("click", togglePanel);
            tray.on("right-click", () => { if (trayMenu) tray?.popUpContextMenu(trayMenu); });
        } catch { showPanel(); }
        notifications = new SessionNotifications(core, openPanel);
        const publish = (w: Workspace) => {
            capture?.publish(w);
            window.setTitle(t("appTitle"));
            tray?.setToolTip(t("trayTooltip"));
            trayMenu = Menu.buildFromTemplate(trayMenuTemplate(w.settings, trayActions));
            bubble?.publish(w);
            void notifications?.publish(w);
            if (window.webContents.isDestroyed()) return;
            window.webContents.send("companion:workspace", panelWorkspace(w));
            if (pinned !== w.settings.pinned) {
                pinned = w.settings.pinned;
                window.setAlwaysOnTop(pinned);
                window.setMovable(pinned);
                window.setSkipTaskbar(!pinned);
                window.setMaximumSize(pinned ? 1200 : 420, 1800);
                if (pinned) showPanel(); else anchorPanel();
            }
            tray?.setTitle(trayTitle(w.sessions));
        };
        core.onWorkspace(publish);
        const initial = core.snapshot();
        if (initial) publish(initial);
        if (smoke) {
            showPanel();
            void runLifecycleSmoke(window, core, nativeRequests, capture, bubble).then(() => {
                if (process.env.AIMSPAN_TEST_EXIT) app.quit();
            }).catch(error => { console.error("Local lifecycle smoke:", error); app.exit(1); });
        }
    }).catch(error => { console.error("AimSpan startup:", error instanceof Error ? error.message : "failed"); dialog.showErrorBox(t("startupTitle"), errorMessage(error, core?.snapshot()?.settings.language ?? "en")); app.quit(); });
}
app.on("activate", showPanel);
