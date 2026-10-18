import type { SourceDiagnostic } from "@aimspan/protocol";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CLAUDE_REGISTRY_STATES, object, type ActivityEntry } from "@aimspan/protocol";
export { CLAUDE_REGISTRY_STATES } from "@aimspan/protocol";
import type { Observation } from "./store.js";
import { digest, noLinks, readSource, readSourceBytes, redact } from "./security.js";
import { boundedAgentMessage, type SourceTurn } from "./source.js";
import { dirtyPath } from "./discovery-loop.js";
import { activityEntry, addActivity } from "./activity.js";

export type ClaudeTurn = SourceTurn;

export interface ClaudeRegistryInfo {
    live: boolean;
    status?: string;
    statusUpdatedAt?: string;
}

export interface ClaudeObservation extends Observation {
    agent: "claude-code";
    entrypoint?: string;
    registry: ClaudeRegistryInfo;
    lastPromptAt?: string;
    lastMainRecordAt?: string;
    turns: ClaudeTurn[];
    subagentRunning: boolean;
    activity: ActivityEntry[];
    activityIncomplete: boolean;
}

export interface ClaudeLiveSession {
    nativeId: string;
    project: string;
    entrypoint?: string;
    registry: ClaudeRegistryInfo;
}

export interface ClaudeReadOptions {
    read?: typeof readSource;
    readBytes?: typeof readSourceBytes;
    isPidAlive?: (pid: number) => boolean;
}

function timestamp(value: unknown): string | undefined {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const numeric = typeof value === "number" ? value : /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : undefined;
    const time = numeric === undefined ? Date.parse(String(value)) : Math.abs(numeric) < 1e11 ? numeric * 1000 : numeric;
    return Number.isFinite(time) && Math.abs(time) <= 8.64e15 ? new Date(time).toISOString() : undefined;
}

function text(value: unknown): string {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return "";
    return value.flatMap(block => object(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
}

function interruption(body: string): boolean {
    return /^\s*\[Request interrupted by user(?: for tool use)?\]\s*$/.test(body);
}

function realPrompt(raw: Record<string, unknown>, body: string): boolean {
    return raw.type === "user" && !interruption(body) && !raw.isMeta && !raw.isInjected && !raw.injected && raw.toolUseResult === undefined && !!body.trim()
        && !/^\s*<(?:command-|local-command|system(?:-reminder)?\b|environment\b|turn_aborted\b|user_instructions\b|permissions\b)/i.test(body);
}

/** The backwards reader uses exactly the parser's main-thread prompt gate. */
export function isClaudePrompt(raw: unknown): boolean {
    if (!object(raw) || raw.isSidechain === true) return false;
    const message = object(raw.message) ? raw.message : {};
    return realPrompt(raw, text(message.content ?? raw.content));
}

function failed(result: Record<string, unknown>): boolean {
    return result.is_error === true || result.interrupted === true || result.isInterrupted === true || result.status === "interrupted"
        || result.status === "failed" || [result.exit_code, result.exitCode].some(code => typeof code === "number" && Number.isFinite(code) && code !== 0);
}

function assistantActivity(raw: Record<string, unknown>): boolean {
    const message = object(raw.message) ? raw.message : {};
    return raw.type === "assistant" && (!!text(message.content) || typeof message.stop_reason === "string" || Array.isArray(message.content) && message.content.length > 0);
}

function toolActivity(raw: Record<string, unknown>): boolean {
    const message = object(raw.message) ? raw.message : {};
    return raw.type === "user" && (raw.toolUseResult !== undefined || Array.isArray(message.content) && message.content.some(block => object(block) && block.type === "tool_result"));
}

type ChildProgress = { at: string; terminal: boolean };
function childProgress(raw: Record<string, unknown>, when: string, previous?: ChildProgress): ChildProgress | undefined {
    if (previous && when < previous.at) return previous;
    const message = object(raw.message) ? raw.message : {};
    const body = text(message.content ?? raw.content);
    if (raw.type === "assistant" && message.stop_reason === "end_turn" || raw.type === "result" || raw.type === "user" && interruption(body)) return { at: when, terminal: true };
    if (assistantActivity(raw) || realPrompt(raw, body) || toolActivity(raw) && !previous?.terminal) return { at: when, terminal: false };
    return previous;
}

function apiErrorText(raw: Record<string, unknown>): string {
    const message = object(raw.message) ? raw.message : {};
    const error = object(raw.error) ? text(raw.error.message) : text(raw.error);
    return error || text(raw.message) || text(raw.content) || text(message.content) || "Claude API error";
}

function foldApiError(raw: Record<string, unknown>, turn: ClaudeTurn) {
    if (raw.type === "system" && raw.subtype === "api_error" && turn.errors.length < 50) turn.errors.push(redact(apiErrorText(raw), 500));
}

type Commands = Map<string, { command?: string; turn: ClaudeTurn | undefined; entry: ActivityEntry }>;

function foldToolFacts(raw: Record<string, unknown>, turn: ClaudeTurn | undefined, commands: Commands, namespace: string, activity: ActivityEntry[], when: string) {
    const message = object(raw.message) ? raw.message : {};
    const blocks = Array.isArray(message.content) ? message.content : [];
    const commandKey = (id: string) => `${namespace}:${id}`;
    for (const block of blocks) {
        if (!object(block)) continue;
        if (raw.type === "assistant" && block.type === "tool_use" && object(block.input)) {
            if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(String(block.name)) && typeof block.input.file_path === "string") {
                const path = redact(block.input.file_path, 4096);
                if (turn) { const at = turn.changedFiles.indexOf(path); if (at >= 0) turn.changedFiles.splice(at, 1); if (turn.changedFiles.length < 200) turn.changedFiles.push(path); }
                const entry = activityEntry(when, "file", path);
                addActivity(activity, entry);
                if (typeof block.id === "string" && commands.size < 1000) commands.set(commandKey(block.id), { turn, entry });
            }
            if (block.name === "Bash" && typeof block.input.command === "string") {
                const entry = activityEntry(when, "command", block.input.command);
                addActivity(activity, entry);
                if (typeof block.id === "string" && commands.size < 1000) commands.set(commandKey(block.id), { command: redact(block.input.command, 300), turn, entry });
            }
        }
    }
    if (raw.type !== "user") return;
    const results = blocks.filter(block => object(block) && block.type === "tool_result");
    if (object(raw.toolUseResult)) {
        const result = raw.toolUseResult;
        const ids = results.flatMap(block => object(block) && typeof block.tool_use_id === "string" ? [block.tool_use_id] : []);
        const directId = result.tool_use_id ?? raw.tool_use_id ?? raw.toolUseID;
        if (typeof directId === "string") ids.push(directId);
        for (const tool_use_id of new Set(ids)) results.push({ ...result, tool_use_id });
    }
    const outcomes = new Map<string, boolean>();
    for (const result of results) {
        if (!object(result) || typeof result.tool_use_id !== "string") continue;
        outcomes.set(result.tool_use_id, (outcomes.get(result.tool_use_id) ?? false) || failed(result));
    }
    for (const [id, isFailure] of outcomes) {
        const command = commands.get(commandKey(id));
        if (isFailure && command?.command && command.turn && command.turn.failedCommands.length < 50) command.turn.failedCommands.push(command.command);
        // Keep the invocation timestamp so an appended result updates the same entry in Store.
        if (command) addActivity(activity, { ...command.entry, failed: isFailure });
        commands.delete(commandKey(id));
    }
}

/** Child tails have no authority to change parent identity, prompts or replies. */
export function foldClaudeSubagents(base: ClaudeObservation, children: { records: unknown[]; mtime: string }[]): ClaudeObservation {
    const observation: ClaudeObservation = { ...base, activity: [...base.activity], turns: base.turns.map(turn => ({ ...turn, errors: [...turn.errors], changedFiles: [...turn.changedFiles], failedCommands: [...turn.failedCommands] })) };
    // Child work may continue past the parent's end_turn, but cannot belong to
    // a later prompt or to an interval omitted by a bounded read.
    const turnAt = (when: string): ClaudeTurn | undefined => {
        for (let i = observation.turns.length - 1; i >= 0; i--) {
            const turn = observation.turns[i]!, next = observation.turns[i + 1];
            if (when >= turn.promptAt && (!next || when < next.promptAt) && (!turn.factsThrough || when <= turn.factsThrough)) return turn;
        }
        return undefined;
    };
    for (const child of children) {
        const commands: Commands = new Map();
        let progress: ChildProgress | undefined, previousTurn: ClaudeTurn | undefined;
        for (const raw of child.records) {
            if (!object(raw)) continue;
            if (raw.type === "aimspan_read_gap" || raw.type === "aimspan_activity_gap") { observation.activityIncomplete = true; commands.clear(); continue; }
            const recordedAt = timestamp(raw.timestamp ?? raw.created_at);
            const when = recordedAt ?? child.mtime;
            progress = childProgress(raw, when, progress);
            if (when > observation.at) observation.at = when;
            const turn = recordedAt ? turnAt(recordedAt) : undefined;
            if (turn !== previousTurn) commands.clear();
            if (turn) {
                foldToolFacts(raw, turn, commands, "child", observation.activity, when); foldApiError(raw, turn);
                foldActivity(raw, observation.activity, when);
            }
            previousTurn = turn;
        }
        if (progress && progress.at > (base.lastMainRecordAt ?? base.at) && !progress.terminal) observation.subagentRunning = true;
        if (progress?.terminal && progress.at > (base.lastMainRecordAt ?? base.at) && !base.turns.at(-1)?.aborted
            && progress.at > (observation.subagentWaitingAt ?? "")) observation.subagentWaitingAt = progress.at;
    }
    if (observation.subagentRunning) { observation.state = "working"; observation.confidence = "inferred"; observation.human = false; }
    observation.version = digest(observation);
    return observation;
}

/** Omitted records remain explicit gaps without decoding oversized lines. */
export function claudeRecords(body: string): unknown[] {
    const lines = body.split("\n"), gap = { type: "aimspan_activity_gap" };
    const records = lines.slice(0, 5000).flatMap((line): unknown[] => {
        if (!line.trim()) return [];
        if (Buffer.byteLength(line) > 256 * 1024) return [gap];
        try { return [JSON.parse(line) as unknown]; } catch { return [gap]; }
    });
    if (lines.slice(5000).some(line => line.trim())) records.push(gap);
    return records;
}

function foldActivity(raw: Record<string, unknown>, activity: ActivityEntry[], when: string) {
    const message = object(raw.message) ? raw.message : {};
    if (raw.type === "assistant") {
        const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
        for (const block of blocks) if (object(block) && block.type === "text" && typeof block.text === "string") {
            addActivity(activity, activityEntry(when, "message", block.text));
        }
    }
    if (raw.type === "system" && raw.subtype === "api_error") addActivity(activity, activityEntry(when, "error", apiErrorText(raw)));
    if (raw.type === "user" && interruption(text(message.content ?? raw.content))) addActivity(activity, activityEntry(when, "error", "interrupted"));
}

/** Pure transcript parsing; no filesystem or process access. Header/tail overlap is deduplicated. */
export function parseClaudeRecords(values: unknown[], fallback: { nativeId: string; mtime: string }): ClaudeObservation {
    const mainIdentity = values.find(raw => object(raw) && raw.isSidechain !== true && typeof raw.sessionId === "string");
    const sideIdentity = values.find(raw => object(raw) && raw.isSidechain === true && typeof raw.sessionId === "string");
    const identity = object(mainIdentity) ? mainIdentity : object(sideIdentity) ? sideIdentity : undefined;
    const nativeId = typeof identity?.sessionId === "string" ? identity.sessionId : fallback.nativeId;
    let project = "", entrypoint: string | undefined;
    let customTitle = "", aiTitle = "", lastPromptTitle = "", firstPrompt = "";
    let at = "", lastMainAt = "", state: Observation["state"] = "unknown", confidence: Observation["confidence"] = "unknown";
    let human = false, turnAborted = false, lastPromptAt: string | undefined, current: ClaudeTurn | undefined;
    let trailingCompletion: Observation["trailingCompletion"];
    let previousCompletion: Observation["previousCompletion"];
    const turns: ClaudeTurn[] = [], sources: Observation["sources"] = [];
    const seen = new Set<string>();
    const commands: Commands = new Map();
    const activity: ActivityEntry[] = [];
    let activityIncomplete = false;
    const sidechains = new Map<string, ChildProgress>();
    const addSource = (raw: Record<string, unknown>, when: string, body: string, prompt: boolean) => {
        sources.push({ id: typeof raw.uuid === "string" ? raw.uuid : digest(raw), kind: prompt ? "user" : "agent", time: when, excerpt: redact(body, 1600) });
        if (sources.length > 12) sources.shift();
    };
    for (const raw of values) {
        if (!object(raw)) continue;
        // Preserve the small-reader's lifecycle policy for skipped individual lines.
        if (raw.type === "aimspan_activity_gap") { activityIncomplete = true; commands.clear(); continue; }
        // A bounded read can omit the middle of a transcript. Never join a header
        // prompt to an unrelated final answer in the tail across that gap.
        if (raw.type === "aimspan_read_gap") {
            activityIncomplete = true;
            if (current) current.factsThrough = lastMainAt || current.promptAt;
            current = undefined; commands.clear(); sidechains.clear();
            trailingCompletion = undefined;
            state = "unknown"; confidence = "unknown"; human = false; turnAborted = false;
            continue;
        }
        const id = typeof raw.uuid === "string" ? raw.uuid : digest(raw);
        if (seen.has(id)) continue;
        seen.add(id);
        const recordedAt = timestamp(raw.timestamp ?? raw.created_at);
        const when = recordedAt ?? fallback.mtime;
        const sidechain = raw.isSidechain === true;
        const message = object(raw.message) ? raw.message : {};
        const body = text(message.content ?? raw.content);
        if (sidechain) {
            const key = typeof raw.agentId === "string" ? raw.agentId : "sidechain";
            const progress = childProgress(raw, when, sidechains.get(key));
            if (progress) sidechains.set(key, progress);
        } else {
            if (typeof raw.cwd === "string") project = redact(raw.cwd, 4096);
            if (typeof raw.entrypoint === "string") entrypoint = redact(raw.entrypoint, 120);
            if (raw.type === "custom-title") customTitle = text(raw.customTitle ?? raw.title) || customTitle;
            if (raw.type === "ai-title") aiTitle = text(raw.aiTitle ?? raw.title) || aiTitle;
            if (raw.type === "last-prompt") lastPromptTitle = text(raw.lastPrompt) || lastPromptTitle;
            if (recordedAt && recordedAt > lastMainAt) lastMainAt = recordedAt;
            if (["user", "assistant", "system"].includes(String(raw.type))) {
                lastMainAt = when > lastMainAt ? when : lastMainAt;
                if (when >= at) { at = when; human = false; }
            }
            if (realPrompt(raw, body)) {
                if (trailingCompletion && trailingCompletion.endedAt < when) previousCompletion = trailingCompletion;
                trailingCompletion = undefined;
                firstPrompt ||= body;
                lastPromptAt = when;
                current = { promptAt: when, ...(typeof raw.uuid === "string" ? { turnId: digest(raw.uuid) } : {}), errors: [], changedFiles: [], failedCommands: [] };
                turns.push(current);
                if (turns.length > 20) turns.shift();
                commands.clear();
                turnAborted = false;
                state = "working"; confidence = "inferred"; human = true;
                addSource(raw, when, body, true);
            }
            if (!turnAborted && (assistantActivity(raw) || toolActivity(raw) && !current?.endedAt)) {
                state = "working"; confidence = "inferred";
            }
            if (raw.type === "user" && interruption(body)) {
                turnAborted = true;
                state = "unknown"; confidence = "explicit"; human = false;
                if (current && !current.endedAt) {
                    current.endedAt = when;
                    current.aborted = true;
                    current.durationMs ??= Math.max(0, Date.parse(when) - Date.parse(current.promptAt));
                    if (current.errors.length >= 50) current.errors.pop();
                    current.errors.push("interrupted");
                }
                // Interrupted results may follow this marker; retain correlation
                // until their result, a new prompt, or a read gap arrives.
            }
            if (!turnAborted && raw.type === "assistant" && message.stop_reason === "end_turn") {
                state = "ended"; confidence = "explicit";
                if (current && !current.endedAt) {
                    current.endedAt = when;
                    current.durationMs ??= Math.max(0, Date.parse(when) - Date.parse(current.promptAt));
                    if (body) Object.assign(current, boundedAgentMessage(body));
                }
                if (!current) trailingCompletion = { endedAt: when, ...(body ? boundedAgentMessage(body) : {}) };
                if (body) addSource(raw, when, body, false);
            }
        }
        foldActivity(raw, activity, when);
        foldToolFacts(raw, current, commands, sidechain ? String(raw.agentId ?? "sidechain") : "main", activity, when);
        if (!current) continue;
        foldApiError(raw, current);
        if (raw.type === "system") {
            if (!sidechain && raw.subtype === "turn_duration" && typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs) && raw.durationMs >= 0) current.durationMs = raw.durationMs;
            if (!sidechain && raw.subtype === "away_summary") {
                const summary = text(raw.content) || text(raw.message) || body;
                if (summary) current.awaySummary = redact(summary, 4000);
            }
        }
    }
    const activeSidechains = [...sidechains.values()].filter(child => child.at > lastMainAt && !child.terminal);
    const subagentRunning = activeSidechains.length > 0;
    const subagentWaitingAt = [...sidechains.values()].filter(child => child.terminal && child.at > lastMainAt && !current?.aborted)
        .reduce((latest, child) => child.at > latest ? child.at : latest, "");
    if (lastMainAt > at) at = lastMainAt;
    at = [...sidechains.values()].reduce((latest, child) => child.at > latest ? child.at : latest, at);
    if (subagentRunning) { state = "working"; confidence = "inferred"; human = false; }
    const observation: ClaudeObservation = {
        agent: "claude-code", nativeId, project, title: redact(customTitle || aiTitle || lastPromptTitle || firstPrompt || nativeId, 120),
        state, at: at || fallback.mtime, confidence, sources, human, version: "", registry: { live: false }, turns, subagentRunning, activity, activityIncomplete,
        ...(trailingCompletion ? { trailingCompletion } : {}),
        ...(previousCompletion ? { previousCompletion } : {}),
        ...(subagentWaitingAt ? { subagentWaitingAt } : {}),
        ...(entrypoint ? { entrypoint } : {}), ...(lastPromptAt ? { lastPromptAt } : {}),
        ...(lastMainAt ? { lastMainRecordAt: lastMainAt } : {}),
    };
    observation.version = digest(observation);
    return observation;
}

export function withClaudeRegistry(base: ClaudeObservation, live?: ClaudeLiveSession): ClaudeObservation {
    if (!live) return base;
    const status = live.registry.status ?? "";
    const mapped = Object.hasOwn(CLAUDE_REGISTRY_STATES, status) ? CLAUDE_REGISTRY_STATES[status] : undefined;
    const state = base.subagentRunning || mapped === "running" ? "working" : mapped ?? base.state;
    const observation: ClaudeObservation = {
        ...base, project: live.project || base.project, registry: live.registry,
        ...(mapped === "running" && live.registry.statusUpdatedAt && live.registry.statusUpdatedAt > (base.lastPromptAt ?? "") ? { lastPromptAt: live.registry.statusUpdatedAt } : {}),
        ...(live.entrypoint ? { entrypoint: live.entrypoint } : {}),
        state, confidence: state === "unknown" ? "unknown" : "explicit", human: false,
        at: live.registry.statusUpdatedAt && live.registry.statusUpdatedAt > base.at ? live.registry.statusUpdatedAt : base.at,
    };
    observation.version = digest({ transcript: base.version, live });
    return observation;
}

export type ClaudeRegistryCache = Map<string, { stamp: string; pid: number; live: ClaudeLiveSession; unreadable?: boolean }>;
export async function readClaudeRegistry(claudeHome: string, options: ClaudeReadOptions = {}, cache: ClaudeRegistryCache = new Map(), dirty?: ReadonlySet<string>): Promise<{ sessions: Map<string, ClaudeLiveSession>; diagnostics: SourceDiagnostic[] }> {
    const sessions = new Map<string, ClaudeLiveSession>(), diagnostics: SourceDiagnostic[] = [];
    const read = options.read ?? readSource;
    const alive = options.isPidAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    const directory = join(claudeHome, "sessions");
    const seen = new Set<string>();
    try {
        noLinks(directory);
        const entries = await readdir(directory, { withFileTypes: true });
        if (entries.length > 20000) diagnostics.push({ code: "claude.registry.limit" });
        let files = 0;
        for (const entry of entries.slice(0, 20000)) {
            // Only PID JSON files can reach the reader: never inspect *.key.
            if (!entry.isFile() || !/^[1-9]\d*\.json$/.test(entry.name)) continue;
            if (++files > 1000) { diagnostics.push({ code: "claude.registry.limit" }); break; }
            const path = join(directory, entry.name);
            seen.add(path);
            try {
                let cached = cache.get(path);
                if (dirtyPath(dirty, path)) {
                    const stat = await lstat(path), stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
                    if (cached?.stamp !== stamp || cached.unreadable) {
                        const source = read(path, 16 * 1024);
                        if (source.size > 16 * 1024) throw new Error("core.errorOversizedRegistryEntry");
                        const raw: unknown = JSON.parse(source.body);
                        if (!object(raw) || !Number.isSafeInteger(raw.pid) || Number(raw.pid) <= 0 || `${raw.pid}.json` !== entry.name
                            || typeof raw.sessionId !== "string" || !raw.sessionId || raw.sessionId.length > 256 || /[/\\\0]/.test(raw.sessionId)
                            || typeof raw.cwd !== "string" || raw.cwd.length > 4096 || typeof raw.status !== "string" || raw.status.length > 120) throw new Error("core.errorInvalidRegistryEntry");
                        if (raw.kind === "subagent") { cache.delete(path); continue; }
                        const statusUpdatedAt = timestamp(raw.statusUpdatedAt);
                        const live: ClaudeLiveSession = { nativeId: raw.sessionId, project: redact(raw.cwd, 4096), registry: { live: true, status: redact(raw.status, 120), ...(statusUpdatedAt ? { statusUpdatedAt } : {}) }, ...(typeof raw.entrypoint === "string" ? { entrypoint: redact(raw.entrypoint, 120) } : {}) };
                        cached = { stamp, pid: Number(raw.pid), live };
                        if (!cache.has(path) && cache.size >= 1000) cache.delete(cache.keys().next().value!);
                        cache.set(path, cached);
                    }
                }
                if (cached?.unreadable) throw new Error("core.errorUnreadableRegistryEntry");
                if (!cached || !alive(cached.pid)) continue;
                const live = cached.live;
                const previous = sessions.get(live.nativeId);
                if (!previous || (live.registry.statusUpdatedAt ?? "") >= (previous.registry.statusUpdatedAt ?? "")) sessions.set(live.nativeId, live);
            } catch { const cached = cache.get(path); if (cached) cached.unreadable = true; if (!diagnostics.some(d => d.code === "claude.registry.uncertain")) diagnostics.push({ code: "claude.registry.uncertain" }); }
        }
    } catch (error) {
        if (!object(error) || error.code !== "ENOENT") diagnostics.push({ code: "claude.registry.unreadable" });
    }
    for (const path of cache.keys()) if (!seen.has(path)) cache.delete(path);
    return { sessions, diagnostics };
}
