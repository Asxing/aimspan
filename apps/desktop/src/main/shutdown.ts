import { randomUUID } from "node:crypto";
import type { App, IpcMain, IpcMainEvent, WebContents } from "electron";

type FlushWindow = Pick<WebContents, "send" | "isDestroyed" | "mainFrame">;
interface ShutdownOptions {
    app: Pick<App, "on" | "quit" | "exit">;
    ipc: Pick<IpcMain, "on" | "removeListener">;
    getWindows: () => (FlushWindow | undefined)[];
    getCore: () => { stop(): Promise<void> } | undefined;
    onQuit: () => void;
}

function requestDraftFlush(ipc: ShutdownOptions["ipc"], window: FlushWindow | undefined): Promise<void> {
    if (!window || window.isDestroyed()) return Promise.resolve();
    return new Promise(resolve => {
        const id = randomUUID();
        const finish = () => { clearTimeout(timer); ipc.removeListener("companion:drafts-flushed", acknowledged); resolve(); };
        const acknowledged = (event: IpcMainEvent, token: unknown) => {
            if (event.sender === window && event.senderFrame === window.mainFrame && token === id) finish();
        };
        const timer = setTimeout(finish, 1000);
        ipc.on("companion:drafts-flushed", acknowledged);
        try { window.send("companion:flush-drafts", id); } catch { finish(); }
    });
}

/** Keep the window alive through flush, including repeated quit attempts. */
export function installShutdown({ app, ipc, getWindows, getCore, onQuit }: ShutdownOptions) {
    let quitting = false, complete = false;
    app.on("before-quit", event => {
        if (complete) return;
        event.preventDefault();
        if (quitting) return;
        quitting = true;
        onQuit();
        const core = getCore();
        if (!core) { complete = true; app.exit(0); return; }
        void Promise.all(getWindows().map(window => requestDraftFlush(ipc, window))).then(() => core.stop()).catch(() => {}).finally(() => {
            complete = true;
            app.quit();
        });
    });
    return { complete: () => complete };
}
