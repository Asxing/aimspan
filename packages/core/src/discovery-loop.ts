import type { SourceDiagnostic } from "@aimspan/protocol";
import { watch } from "node:fs";
import { join, resolve } from "node:path";
import { inside, noLinks, redact } from "./security.js";

export interface WatchHandle { close(): void; on(event: "error", callback: () => void): unknown }
export interface DiscoveryLoopOptions {
    watch?: (path: string, recursive: boolean, changed: (filename?: string) => void) => WatchHandle;
    setTimeout?: typeof setTimeout;
    clearTimeout?: typeof clearTimeout;
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
}
const nativeWatch: NonNullable<DiscoveryLoopOptions["watch"]> = (path, recursive, changed) => {
    noLinks(path);
    return watch(path, { recursive }, (_event, filename) => changed(filename?.toString()));
};

/** One bounded dirty set; events during a scan become the next pass. */
export class DiscoveryLoop {
    private handles = new Map<string, WatchHandle>();
    private errors = new Map<string, SourceDiagnostic>();
    private dirty = new Set<string>();
    private full = false;
    private stopped = false;
    private pending: Promise<void> | undefined;
    private debounce: ReturnType<typeof setTimeout> | undefined;
    private maxWait: ReturnType<typeof setTimeout> | undefined;
    private interval: ReturnType<typeof setInterval> | undefined;
    private rerun = false;
    private rerunTimer: ReturnType<typeof setTimeout> | undefined;
    constructor(private targets: { path: string; recursive: boolean; file?: boolean }[], private scan: (dirty?: ReadonlySet<string>) => Promise<void>, private changed: () => void, private options: DiscoveryLoopOptions = {}) {}
    get diagnostics() { return [...this.errors.values()]; }
    /** A scan left budget-limited work (e.g. a large first read); continue soon instead of waiting for the next file event. */
    requestRerun() {
        if (this.stopped) return;
        // During a scan the flag is consumed when it finishes; otherwise schedule directly.
        if (this.pending) { this.rerun = true; return; }
        if (this.rerunTimer === undefined) this.rerunTimer = (this.options.setTimeout ?? setTimeout)(() => { this.rerunTimer = undefined; void this.flush(); }, 100);
    }
    start() {
        this.connect();
        this.interval = (this.options.setInterval ?? setInterval)(() => {
            this.full = true; this.connect(); void this.flush();
        }, 60000);
    }
    private connect() {
        for (const target of this.targets) {
            if (this.handles.has(target.path)) continue;
            const fail = () => {
                this.handles.get(target.path)?.close(); this.handles.delete(target.path);
                this.errors.set(target.path, { code: "watch-fallback", path: redact(target.path, 4096) });
                this.changed();
            };
            try {
                const handle = (this.options.watch ?? nativeWatch)(target.path, target.recursive, filename => {
                    if (this.stopped) return;
                    // Renames/deletes of a watched file invalidate its inode watch.
                    if (target.file) { this.handles.get(target.path)?.close(); this.handles.delete(target.path); }
                    const path = target.file ? target.path : filename ? resolve(join(target.path, filename)) : undefined;
                    if (!path || !inside(target.path, path) || this.dirty.size >= 10000) this.full = true;
                    else if (!path.endsWith(".key")) this.dirty.add(path);
                    if (this.debounce !== undefined) (this.options.clearTimeout ?? clearTimeout)(this.debounce);
                    this.debounce = (this.options.setTimeout ?? setTimeout)(() => { this.debounce = undefined; void this.flush(); }, 500);
                    this.maxWait ??= (this.options.setTimeout ?? setTimeout)(() => { this.maxWait = undefined; void this.flush(); }, 2000);
                });
                handle.on("error", fail); this.handles.set(target.path, handle); this.errors.delete(target.path);
            } catch { fail(); }
        }
    }
    private async flush() {
        if (this.stopped || this.pending) return;
        this.clearPendingTimers();
        const paths = this.full ? undefined : new Set(this.dirty);
        this.dirty.clear(); this.full = false;
        this.pending = this.scan(paths).then(() => { this.errors.delete("scan"); }, () => { this.errors.set("scan", { code: "discovery.read" }); }).finally(() => {
            this.pending = undefined;
            if (!this.stopped) {
                this.changed(); this.connect();
                if (this.full || this.dirty.size) void this.flush();
                else if (this.rerun) {
                    this.rerun = false;
                    this.rerunTimer = (this.options.setTimeout ?? setTimeout)(() => { this.rerunTimer = undefined; void this.flush(); }, 100);
                }
            }
        });
        await this.pending;
    }
    async stop() {
        this.stopped = true;
        this.clearPendingTimers();
        if (this.interval) (this.options.clearInterval ?? clearInterval)(this.interval);
        for (const handle of this.handles.values()) handle.close();
        this.handles.clear(); this.dirty.clear();
        await this.pending;
    }
    private clearPendingTimers() {
        if (this.debounce !== undefined) (this.options.clearTimeout ?? clearTimeout)(this.debounce);
        if (this.maxWait !== undefined) (this.options.clearTimeout ?? clearTimeout)(this.maxWait);
        if (this.rerunTimer !== undefined) (this.options.clearTimeout ?? clearTimeout)(this.rerunTimer);
        this.debounce = undefined; this.maxWait = undefined; this.rerunTimer = undefined;
    }
}

export function dirtyPath(paths: ReadonlySet<string> | undefined, path: string): boolean {
    if (!paths) return true;
    for (const dirty of paths) if (inside(dirty, path) || inside(path, dirty)) return true;
    return false;
}
