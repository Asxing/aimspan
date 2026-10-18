import type { SourceDiagnostic } from "@aimspan/protocol";
import { readdir, lstat, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Settings } from "@aimspan/protocol";
import { object } from "@aimspan/protocol";
import type { Observation } from "./store.js";
import { Store } from "./store.js";
import { digest, inside, noLinks, readSource, redact } from "./security.js";
import { claudeRecords, foldClaudeSubagents, parseClaudeRecords, readClaudeRegistry, withClaudeRegistry } from "./claude.js";
import type { ClaudeObservation, ClaudeReadOptions } from "./claude.js";
import { CodexSource, parseCodexRecords } from "./codex.js";
import type { CodexObservation, CodexReadOptions } from "./codex.js";
import type { ClaudeRegistryCache } from "./claude.js";
import { DiscoveryLoop, dirtyPath } from "./discovery-loop.js";
import type { DiscoveryLoopOptions } from "./discovery-loop.js";
import { readClaudeTranscript } from "./claude-transcript.js";

// Only bounded, redacted child facts are retained between scans (never file bodies).
function childFacts(value: unknown, depth = 0): unknown {
    if (typeof value === "string") return redact(value, 20000);
    if (depth >= 12) return null;
    if (Array.isArray(value)) return value.slice(0, 1000).map(v => childFacts(v, depth + 1));
    if (object(value)) return Object.fromEntries(Object.entries(value).slice(0, 1000).map(([k, v]) => [redact(k, 256), childFacts(v, depth + 1)]));
    return value;
}
export function parseRecords(agent: "claude-code", values: unknown[], fallback: { nativeId: string; mtime: string }): ClaudeObservation;
export function parseRecords(agent: "codex", values: unknown[], fallback: { nativeId: string; mtime: string }): CodexObservation;
export function parseRecords(agent: Observation["agent"], values: unknown[], fallback: { nativeId: string; mtime: string }): ClaudeObservation | CodexObservation;
export function parseRecords(agent: Observation["agent"], values: unknown[], fallback: { nativeId: string; mtime: string }): ClaudeObservation | CodexObservation {
    return agent === "claude-code" ? parseClaudeRecords(values, fallback) : parseCodexRecords(values, fallback);
}
export class Discovery {
    private active: Promise<void> | undefined;
    private codexSource: CodexSource;
    private claudeCache = new Map<string, { stamp: string; observation: ClaudeObservation; unreadable?: boolean }>();
    private claudeRegistryFallbacks = new Map<string, ClaudeObservation>();
    private registryCache: ClaudeRegistryCache = new Map();
    private childCache = new Map<string, { stamp: string; records: unknown[]; mtime: string; unreadable?: boolean }>();
    private loop: DiscoveryLoop | undefined;
    private sourceErrors: SourceDiagnostic[] = [];
    constructor(private store: Store, private roots: {
        codex: string;
        claude: string;
    }, private claudeOptions: ClaudeReadOptions = {}, codexOptions: CodexReadOptions = {}, private loopOptions: DiscoveryLoopOptions = {}) {
        this.codexSource = new CodexSource(roots.codex, { now: () => Date.parse(store.now()), ...codexOptions });
    }
    scan(dirty?: ReadonlySet<string>): Promise<void> {
        if (this.active) return this.active.then(() => this.scan(dirty));
        return this.active = this.run(dirty).finally(() => { this.active = undefined; });
    }
    start(changed: () => void) {
        if (this.loop) return;
        const home = basename(this.roots.codex) === "sessions" ? dirname(this.roots.codex) : this.roots.codex;
        const publish = () => { this.store.diagnostics = [...this.sourceErrors, ...(this.loop?.diagnostics ?? [])]; changed(); };
        this.loop = new DiscoveryLoop([
            { path: join(this.roots.claude, "sessions"), recursive: false },
            { path: join(this.roots.claude, "projects"), recursive: true },
            { path: join(home, "sessions"), recursive: true },
            { path: join(home, "session_index.jsonl"), recursive: false, file: true },
        ], paths => this.scan(paths), publish, this.loopOptions);
        this.loop.start(); publish();
        // The initial scan runs before the loop exists; continue its unfinished large reads now.
        if (this.codexSource.hasBacklog) this.loop.requestRerun();
    }
    async stop() { await this.loop?.stop(); this.loop = undefined; await this.active; }
    private async scanClaude(settings: Settings, errors: SourceDiagnostic[], seenSessions: Set<string>, dirty?: ReadonlySet<string>) {
        const registry = await readClaudeRegistry(this.roots.claude, this.claudeOptions, this.registryCache, dirty);
        errors.push(...registry.diagnostics);
        const read = this.claudeOptions.read ?? readSource;
        const candidates = new Map<string, { observation: ClaudeObservation; path?: string }>();
        const seenPaths = new Set<string>();
        const seenChildren = new Set<string>();
        const projects = join(this.roots.claude, "projects");
        let entries = 0, files = 0;
        const uncertain = () => { if (!errors.some(d => d.code === "claude.source.uncertain")) errors.push({ code: "claude.source.uncertain" }); };
        const limit = () => { if (!errors.some(d => d.code === "claude.source.limit")) errors.push({ code: "claude.source.limit" }); };
        const addCandidate = (nativeId: string, candidate: { observation: ClaudeObservation; path?: string }) => {
            if (!candidates.has(nativeId) && candidates.size >= 5000) { limit(); return; }
            candidates.set(nativeId, candidate);
        };
        const subagents = async (directory: string, parent: ClaudeObservation) => {
            const children: { records: unknown[]; mtime: string }[] = [];
            try {
                noLinks(directory);
                let childFiles = 0;
                for (const file of await readdir(directory, { withFileTypes: true })) {
                    if (++entries > 20000) { limit(); break; }
                    if (!file.isFile() || !/^agent-.+\.jsonl$/.test(file.name)) continue;
                    if (childFiles >= 20 || files >= 5000) { limit(); break; }
                    childFiles++; files++;
                    const path = join(directory, file.name);
                    seenChildren.add(path);
                    try {
                        let cached = this.childCache.get(path);
                        if (dirtyPath(dirty, path)) {
                            const stat = await lstat(path), stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
                            if (cached?.stamp !== stamp || cached.unreadable) {
                                const tail = read(path, 256 * 1024, true);
                                const records = [...(tail.size > 256 * 1024 ? [{ type: "aimspan_read_gap" }] : []), ...claudeRecords(tail.body)].map(raw => childFacts(raw));
                                if (!records.some(raw => object(raw) && raw.type !== "aimspan_read_gap" && raw.type !== "aimspan_activity_gap")) { uncertain(); continue; }
                                cached = { stamp, records, mtime: new Date(tail.mtime).toISOString() };
                                if (!this.childCache.has(path) && this.childCache.size >= 5000) this.childCache.delete(this.childCache.keys().next().value!);
                                this.childCache.set(path, cached);
                            }
                        }
                        if (cached?.unreadable) throw new Error("core.errorUnreadableChild");
                        if (cached) children.push(cached);
                    } catch { const cached = this.childCache.get(path); if (cached) cached.unreadable = true; uncertain(); }
                }
            } catch (error) {
                if (!object(error) || error.code !== "ENOENT") uncertain();
            }
            const observation = children.length ? foldClaudeSubagents(parent, children) : parent;
            return { ...observation, sourceChangedAt: children.reduce((at, child) => child.mtime > at ? child.mtime : at, parent.sourceChangedAt ?? parent.at) };
        };
        try {
            noLinks(projects);
            for (const slug of await readdir(projects, { withFileTypes: true })) {
                if (++entries > 20000) { limit(); break; }
                if (!slug.isDirectory() || slug.isSymbolicLink()) continue;
                const directory = join(projects, slug.name);
                try {
                    noLinks(directory);
                    for (const file of await readdir(directory, { withFileTypes: true })) {
                        if (++entries > 20000) { limit(); break; }
                        // Parent files create sessions. Nested subagent files are
                        // read only in the context of that parent.
                        if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
                        if (files >= 5000) { limit(); break; }
                        files++;
                        const path = join(directory, file.name);
                        seenPaths.add(path);
                        let cached = this.claudeCache.get(path);
                        let unreadable = cached?.unreadable ?? false;
                        try {
                            if (dirtyPath(dirty, path)) {
                                const stat = await lstat(path);
                                const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
                                if (cached?.stamp !== stamp || cached.unreadable) {
                                    const source = readClaudeTranscript(path, this.claudeOptions), { records } = source;
                                    if (source.identity !== digest(`${stat.dev}:${stat.ino}`) || source.size !== stat.size || source.mtime !== stat.mtimeMs) throw new Error("core.errorSourceReplaced");
                                    if (!records.some(raw => object(raw) && raw.isSidechain !== true && ["user", "assistant", "system"].includes(String(raw.type)))) {
                                        if (records.some(raw => object(raw) && raw.isSidechain === true)) continue;
                                        throw new Error("core.errorNoCompleteMainThreadRecords");
                                    }
                                    const observation = parseClaudeRecords(records, { nativeId: file.name.slice(0, -6), mtime: new Date(source.mtime).toISOString() });
                                    observation.sourceChangedAt = new Date(source.mtime).toISOString();
                                    cached = { stamp, observation };
                                    if (!this.claudeCache.has(path) && this.claudeCache.size >= 5000) this.claudeCache.delete(this.claudeCache.keys().next().value!);
                                    this.claudeCache.set(path, cached);
                                    unreadable = false;
                                }
                            }
                        } catch { if (cached) cached.unreadable = true; unreadable = true; }
                        if (unreadable) uncertain();
                        if (cached) {
                            const observation = await subagents(join(directory, file.name.slice(0, -6), "subagents"), cached.observation);
                            if (unreadable) { observation.sourceUncertain = true; observation.subagentRunning = false; }
                            addCandidate(observation.nativeId, { observation, path });
                        }
                    }
                } catch { uncertain(); }
            }
        } catch (error) {
            if (!object(error) || error.code !== "ENOENT") errors.push({ code: "claude.source.unreadable" });
        }
        for (const path of this.claudeCache.keys()) if (!seenPaths.has(path)) this.claudeCache.delete(path);
        for (const path of this.childCache.keys()) if (!seenChildren.has(path)) this.childCache.delete(path);
        for (const live of registry.sessions.values()) {
            if (!candidates.has(live.nativeId)) {
                const observation = this.claudeRegistryFallbacks.get(live.nativeId) ?? parseClaudeRecords([], { nativeId: live.nativeId, mtime: live.registry.statusUpdatedAt ?? this.store.now() });
                addCandidate(live.nativeId, { observation: { ...observation, project: live.project } });
            }
        }
        const currentIds = new Set(candidates.keys());
        // Missing sources can downgrade to unknown once, within the same budget.
        // Persisted sessions remain in Store; historical observations are evicted.
        for (const [nativeId, previous] of this.claudeRegistryFallbacks) {
            if (currentIds.has(nativeId) || registry.sessions.has(nativeId)) continue;
            const observation: ClaudeObservation = { ...previous, registry: { live: false }, sourceUncertain: true, state: "unknown", confidence: "unknown", subagentRunning: false, human: false, version: digest({ previous: previous.version, missing: true }) };
            addCandidate(nativeId, { observation });
        }
        const retained = new Map<string, ClaudeObservation>();
        for (const [nativeId, candidate] of candidates) {
            const observation = { ...withClaudeRegistry(candidate.observation, registry.sessions.get(nativeId)) };
            const project = await realpath(observation.project).catch(() => observation.project);
            if (!project || settings.observeAll === false && !settings.roots.some(root => inside(root, project))) continue;
            observation.project = redact(project, 4096);
            observation.version = digest({ ...observation, version: "" });
            observation.sampledAt = this.store.now();
            const session = this.store.observe(observation);
            seenSessions.add(session.id);
            if (currentIds.has(nativeId)) retained.set(nativeId, candidate.observation);
            if (candidate.path) this.store.setMeta(`source:${session.id}`, redact(candidate.path, 4096));
        }
        this.claudeRegistryFallbacks = retained;
    }
    private async run(dirty?: ReadonlySet<string>) {
        const settings = this.store.settings();
        if (!settings.roots.length && settings.observeAll===false)
            return;
        const errors: SourceDiagnostic[] = [];
        const seenSessions = new Set<string>();
        const codex = await this.codexSource.scan(dirty);
        errors.push(...codex.diagnostics);
        this.store.hideCodexChildren(codex.children);
        // Large first reads continue on the next pass; schedule it now so long sessions leave
        // the uncertain state within seconds of startup rather than at the next file event.
        if (this.codexSource.hasBacklog) this.loop?.requestRerun();
        for (const candidate of codex.sessions) {
            const observation = { ...candidate.observation };
            const project = await realpath(observation.project).catch(() => observation.project);
            if (!project || settings.observeAll === false && !settings.roots.some(root => inside(root, project))) continue;
            observation.project = redact(project, 4096);
            observation.sampledAt = this.store.now();
            const session = this.store.observe(observation);
            seenSessions.add(session.id);
            this.store.setMeta(`source:${session.id}`, redact(candidate.path, 4096));
        }
        await this.scanClaude(settings, errors, seenSessions, dirty);
        this.store.missingSources(seenSessions);
        this.sourceErrors = errors.slice(0, 10000).map(error => ({ ...error, ...(error.path ? { path: redact(error.path, 4096) } : {}) }));
        this.store.diagnostics = [...this.sourceErrors, ...(this.loop?.diagnostics ?? [])];
    }
}
