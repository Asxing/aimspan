import { translator } from "../shared/i18n";
import { utilityProcess, type UtilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import type { CoreRequest, Workspace } from "@aimspan/protocol";
export class CoreClient {
    private readonly t = translator(() => this.current?.settings.language ?? "en");
    private child: UtilityProcess;
    private pending = new Map<string, {
        resolve: (v: unknown) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    private stopping = false;
    private shutdown: Promise<void> | undefined;
    private current: Workspace | undefined;
    private listeners = new Set<(w: Workspace) => void>();
    readonly ready: Promise<void>;
    constructor(entry: string, paths: {
        directory: string;
        codex: string;
        claude: string;
    }) {
        this.child = utilityProcess.fork(entry, [], { serviceName: "AimSpan TS Core", env: { LANG: process.env.LANG ?? "en_US.UTF-8", TZ: process.env.TZ ?? "Asia/Shanghai" }, stdio: "pipe" });
        this.ready = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(this.t("errorTsCoreStartupTimedOut"))), 30000); this.child.on("message", m => { if (m.type === "ready") {
            clearTimeout(timer);
            resolve();
        } if (m.type === "workspace") {
            this.current = m.workspace;
            for (const listener of this.listeners)
                listener(m.workspace);
        } if (m.type === "response" && m.error && !m.id) {
            clearTimeout(timer);
            reject(new Error(m.error));
        } if (m.type === "response") {
            const p = this.pending.get(m.id);
            if (p) {
                clearTimeout(p.timer);
                this.pending.delete(m.id);
                m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
            }
        } }); this.child.on("exit", () => { clearTimeout(timer); reject(new Error(this.t("errorTsCoreExited"))); for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(new Error(this.t("errorBackgroundDisconnectedSavedRecordsRemainOnDisk")));
        } this.pending.clear(); }); });
        this.child.postMessage({ type: "init", ...paths });
    }
    async call<T = unknown>(request: CoreRequest): Promise<T> { if (this.stopping) throw new Error(this.t("errorCoreIsStopping")); await this.ready; const id = randomUUID(); return new Promise<T>((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(this.t("errorBackgroundOperationTimedOutRefreshBeforeRetrying"))); }, 30000); this.pending.set(id, { resolve: v => resolve(v as T), reject, timer }); this.child.postMessage({ type: "call", id, request }); }); }
    snapshot() { return this.current; }
    onWorkspace(fn: (w: Workspace) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    stop(): Promise<void> {
        if (this.shutdown) return this.shutdown;
        this.stopping = true;
        this.shutdown = new Promise<void>(resolve => {
            let finished = false;
            const finish = () => { finished = true; clearTimeout(timer); this.child.removeListener("message", listener); resolve(); };
            const listener = (m: {type?: string}) => { if (m.type === "stopped") finish(); };
            const timer = setTimeout(finish, 5000);
            this.child.on("message", listener);
            // Calls accepted before shutdown registered their ready continuations first.
            // They must enter the worker queue ahead of stop, even during startup.
            void this.ready.then(() => { if (!finished) this.child.postMessage({ type: "stop" }); }).catch(finish);
        }).then(() => { this.child.kill(); });
        return this.shutdown;
    }
}
