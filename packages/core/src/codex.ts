import type { SourceDiagnostic, DiagnosticCode } from "@aimspan/protocol";
import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createZstdDecompress } from "node:zlib";
import { object, type ActivityEntry } from "@aimspan/protocol";
import type { Observation } from "./store.js";
import { boundedAgentMessage, type SourceTurn } from "./source.js";
import { digest, noLinks, readSourceBytes, redact, redactArgv } from "./security.js";
import { dirtyPath } from "./discovery-loop.js";
import { CodexLineSniffer } from "./codex-line.js";
import { activityEntry, addActivity } from "./activity.js";

export interface CodexObservation extends Observation {
    agent: "codex";
    originator?: string;
    archived: boolean;
    lastPromptAt?: string;
    lastMainRecordAt?: string;
    turns: SourceTurn[];
    subagentRunning: boolean;
    activity: ActivityEntry[];
    activityIncomplete: boolean;
}

export interface CodexReadOptions {
    /** Rollout data reads; identity revalidation uses a separate bounded probe. */
    read?: typeof readSourceBytes;
    readIdentity?: typeof readSourceBytes;
    now?: () => number;
    /** Lower the hard streaming budget, e.g. for synthetic limit tests. */
    maxDecompressedBytes?: number;
    /** Lower hard plain-file budgets, including for synthetic scheduling tests. */
    maxFileBytes?: number;
    maxPassBytes?: number;
    maxPassMs?: number;
    budgetNow?: () => number;
}

const HEADER_BYTES = 48 * 1024, TAIL_BYTES = 256 * 1024;
const FIRST_LINE_BYTES = 1024 * 1024, MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
export const CODEX_MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 5000, MAX_ENTRIES = 20000, MAX_RECORDS = 5000;
const CHUNK_BYTES = 1024 * 1024, MAX_LINE_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024, MAX_PASS_BYTES = 256 * 1024 * 1024, MAX_PASS_MS = 1000;
const READ_GRACE_MS = 120000, IDENTITY_PREFIX_BYTES = 4096;
const gap = { type: "aimspan_read_gap" };
const invalidGap = { ...gap, invalid: true };

function timestamp(value: unknown): string | undefined {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const time = typeof value === "number" ? value * 1000 : Date.parse(value);
    return Number.isFinite(time) && Math.abs(time) <= 8.64e15 ? new Date(time).toISOString() : undefined;
}

function text(value: unknown): string {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return "";
    return value.slice(0, 1000).flatMap(block => object(block) && typeof block.type === "string" && /^(?:output_)?text$/i.test(block.type) && typeof block.text === "string" ? [block.text] : []).join("\n");
}

/** Keep both ends if the line budget is exhausted. Invalid interior lines break correlation. */
export function codexRecords(body: string): unknown[] {
    const head: string[] = [], tail: string[] = [];
    let start = 0;
    for (let count = 0; start < body.length && count < MAX_RECORDS / 2; count++) {
        const end = body.indexOf("\n", start);
        head.push(body.slice(start, end < 0 ? body.length : end));
        start = end < 0 ? body.length : end + 1;
    }
    let end = body.endsWith("\n") ? body.length - 1 : body.length;
    for (let count = 0; end > start && count < MAX_RECORDS / 2; count++) {
        const previous = body.lastIndexOf("\n", end - 1);
        tail.push(body.slice(Math.max(start, previous + 1), end));
        end = previous;
    }
    const lines: (string | typeof gap)[] = [...head, ...(start < body.length && end >= start ? [gap] : []), ...tail.reverse()];
    return lines.flatMap((line, index): unknown[] => {
        if (typeof line !== "string") return [line];
        if (!line.trim()) return [];
        const bytes = Buffer.byteLength(line);
        if (bytes > FIRST_LINE_BYTES) return [invalidGap];
        try {
            const value: unknown = JSON.parse(line);
            return object(value) && (bytes <= TAIL_BYTES || value.type === "session_meta") ? [value] : [invalidGap];
        }
        catch { return index === lines.length - 1 && !body.endsWith("\n") ? [] : [invalidGap]; }
    });
}

type CodexFallback = { nativeId: string; mtime: string; archived?: boolean; title?: string };

function rolloutId(name: string) {
    return /^rollout-.+-([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})(?:\.jsonl(?:\.zst)?)?$/i.exec(name)?.[1];
}

function metadataSignature(raw: unknown) {
    if (!object(raw) || raw.type !== "session_meta" || !object(raw.payload)) return undefined;
    const { id, cwd, originator, source } = raw.payload;
    return digest({ id, cwd, originator, source: typeof source === "string" ? source : undefined, ...childMetadata(raw.payload) });
}

function childMetadata(payload: Record<string, unknown>) {
    const source = object(payload.source) ? payload.source : {};
    const subagent = object(source.subagent) ? source.subagent : {};
    const spawn = object(subagent.thread_spawn) ? subagent.thread_spawn : {};
    const parent = spawn.parent_thread_id ?? payload.parent_thread_id;
    const isChild = Object.hasOwn(payload, "thread_source") && payload.thread_source !== "user" || Object.hasOwn(source, "subagent");
    // Downstream treats any parent ID as "child"; a user thread must never carry one.
    return { isChild, parentNativeId: isChild && typeof parent === "string" ? redact(parent, 256) : undefined };
}

/** Both readers feed this reducer; retained values are bounded, redacted facts. */
function codexParser(fallback: CodexFallback) {
    const authoritativeId = rolloutId(fallback.nativeId);
    let metadataId: string | undefined, metadata: string | undefined;
    let hasMetadata = false, partial = false, isChild = false;
    let nativeId = authoritativeId ?? redact(fallback.nativeId, 256), project = "", originator: string | undefined, parentNativeId: string | undefined;
    let firstPrompt = "", lastPromptAt: string | undefined, lastMainRecordAt = "", at = "";
    let state: Observation["state"] = "unknown", confidence: Observation["confidence"] = "unknown", human = false;
    let current: SourceTurn | undefined, currentId: string | undefined, hasPrompt = false, anonymousTerminal = false;
    let lastMessage: ReturnType<typeof boundedAgentMessage> | undefined, finalMessage: typeof lastMessage;
    let turns: SourceTurn[] = [], sources: Observation["sources"] = [], seen = new Set<string>();
    let activity: ActivityEntry[] = [], activityIncomplete = false;
    // Keep only the current turn correlation. Terminal IDs prevent replayed starts;
    // they are hashes, bounded to the same per-read record budget.
    let terminalIds = new Set<string>();
    let suspended: { turn: SourceTurn; id: string } | undefined;
    const turnKey = (value: unknown) => typeof value === "string" && value ? digest(value) : undefined;
    const begin = (when: string, id?: string) => {
        if (current && !current.endedAt) current.factsThrough = lastMainRecordAt || current.promptAt;
        current = { promptAt: when, ...(id ? { turnId: id } : {}), errors: [], changedFiles: [], failedCommands: [] };
        currentId = id; hasPrompt = false; anonymousTerminal = false; lastMessage = undefined; finalMessage = undefined;
        turns.push(current);
        if (turns.length > 20) turns.shift();
    };
    const source = (raw: unknown, when: string, body: string, user: boolean) => {
        if (!body) return;
        sources.push({ id: digest(raw), kind: user ? "user" : "agent", time: when, excerpt: redact(body, 1600) });
        if (sources.length > 12) sources.shift();
    };
    const push = (values: unknown[], mtime = fallback.mtime) => {
        fallback.mtime = mtime;
        for (const raw of values) {
            if (!object(raw)) continue;
            activityIncomplete ||= raw.aimspan_activity_incomplete === true;
            if (raw.type === "aimspan_read_gap") {
                activityIncomplete = true;
                partial ||= raw.invalid === true;
                if (current) current.factsThrough = lastMainRecordAt || current.promptAt;
                // An explicit turn ID still identifies the same turn across the gap.
                suspended = current && !current.endedAt && currentId ? { turn: current, id: currentId } : undefined;
                current = undefined; currentId = undefined; lastMessage = undefined; finalMessage = undefined;
                state = "unknown"; confidence = "unknown"; human = false;
                continue;
            }
            const fingerprint = digest(raw);
            if (seen.has(fingerprint)) continue;
            remember(seen, fingerprint);
            const payload = object(raw.payload) ? raw.payload : {};
            if (raw.type === "session_meta") {
                if (typeof payload.id !== "string" || authoritativeId && payload.id !== authoritativeId) continue;
                // Even metadata rejected by a size cap locks the legacy fallback ID.
                metadataId ??= digest(payload.id);
                if (digest(payload.id) !== metadataId || hasMetadata) continue;
                if (raw.aimspan_metadata_limited) { partial = true; continue; }
                hasMetadata = typeof payload.id === "string" && typeof payload.cwd === "string";
                if (hasMetadata) metadata = metadataSignature(raw);
                nativeId = authoritativeId ?? redact(payload.id, 256);
                if (typeof payload.cwd === "string") project = redact(payload.cwd, 4096);
                if (typeof payload.originator === "string") originator = redact(payload.originator, 120);
                ({ isChild, parentNativeId } = childMetadata(payload));
                continue;
            }
            if (raw.type !== "event_msg") continue;
            // File order defines lifecycle order. Native lifecycle payloads round
            // to seconds; prefer the record's millisecond timestamp for display.
            const when = timestamp(raw.timestamp ?? raw.created_at)
                ?? timestamp(payload.type === "task_started" ? payload.started_at : payload.type === "task_complete" || payload.type === "turn_aborted" ? payload.completed_at : undefined)
                ?? timestamp(fallback.mtime)!;
            if (when > lastMainRecordAt) lastMainRecordAt = when;
            at = lastMainRecordAt; human = false;
            const id = turnKey(payload.turn_id);
            if (payload.type === "task_started") {
                if (id ? terminalIds.has(id) : anonymousTerminal) continue;
                if (!current || current.endedAt || id && currentId && id !== currentId) begin(when, id);
                else if (id) { currentId = id; current.turnId = id; }
                state = "working"; confidence = "explicit";
            }
            if (payload.type === "task_complete" || payload.type === "turn_aborted") {
                const closingId = id ?? currentId;
                if (id && currentId && id !== currentId || (closingId ? terminalIds.has(closingId) : anonymousTerminal)) continue;
                const isAbort = payload.type === "turn_aborted";
                if (isAbort || payload.error) addActivity(activity, activityEntry(when, "error", isAbort
                    ? `aborted${typeof payload.reason === "string" ? `: ${payload.reason}` : ""}`
                    : text(object(payload.error) ? payload.error.message : payload.error) || "Codex task error"));
                state = isAbort ? "unknown" : payload.error ? "failed" : "ended"; confidence = "explicit";
                // Long turns start before the tail window. The completion still carries
                // the turn's start time and final reply, which the catch-up card needs.
                if (!current) {
                    const seenFinal = finalMessage, seenLast = lastMessage;
                    if (suspended && closingId === suspended.id) { current = suspended.turn; currentId = suspended.id; }
                    else { begin(timestamp(payload.started_at) ?? when, closingId); current!.factsThrough = current!.promptAt; }
                    finalMessage = seenFinal; lastMessage = seenLast;
                }
                suspended = undefined;
                if (current && !current.endedAt) {
                    current.endedAt = when;
                    current.durationMs = typeof payload.duration_ms === "number" && Number.isFinite(payload.duration_ms) && payload.duration_ms >= 0
                        ? payload.duration_ms : Math.max(0, Date.parse(when) - Date.parse(current.promptAt));
                    if (isAbort) {
                        current.aborted = true;
                        current.errors.push(redact(`aborted${typeof payload.reason === "string" ? `: ${payload.reason}` : ""}`, 500));
                    } else {
                        const explicit = text(payload.last_agent_message);
                        const reply = explicit ? boundedAgentMessage(explicit) : finalMessage ?? lastMessage;
                        if (reply) { Object.assign(current, reply); source(raw, when, reply.lastAgentMessage, false); }
                        if (payload.error) current.errors.push(redact(text(object(payload.error) ? payload.error.message : payload.error) || "Codex task error", 500));
                    }
                }
                if (closingId) remember(terminalIds, closingId);
                anonymousTerminal = true;
                lastMessage = undefined; finalMessage = undefined;
            }
            if (payload.type === "error") addActivity(activity, activityEntry(when, "error",
                text(object(payload.error) ? payload.error.message : payload.error) || text(payload.message) || "Codex error"));
            if (payload.type !== "item_completed" || !object(payload.item)) continue;
            const item = payload.item, itemId = id ?? turnKey(item.turn_id);
            if (item.type === "UserMessage") {
                if (itemId && terminalIds.has(itemId)) continue;
                const body = text(item.content);
                if (!body.trim()) continue;
                firstPrompt ||= redact(body, 120);
                lastPromptAt = when;
                const sameTurn = itemId !== undefined && itemId === currentId;
                if (!current || current.endedAt || current.factsThrough || hasPrompt && !sameTurn || itemId && currentId && itemId !== currentId) begin(when, itemId);
                else if (!hasPrompt) current.promptAt = when;
                if (itemId) { currentId = itemId; current!.turnId = itemId; }
                anonymousTerminal = false; hasPrompt = true;
                state = "working"; confidence = "inferred"; human = true;
                source(raw, when, body, true);
                continue;
            }
            // Activity is a session-level fact, even when a gap prevents turn correlation.
            if (item.type === "AgentMessage") addActivity(activity, activityEntry(when, "message", text(item.content)));
            if (item.type === "CommandExecution") {
                const command = typeof item.command === "string" ? item.command
                    : Array.isArray(item.command) ? redactArgv(item.command.slice(0, 1000).filter((arg): arg is string => typeof arg === "string")) : "";
                const failed = typeof item.exit_code === "number" && Number.isFinite(item.exit_code) && item.exit_code !== 0 || item.status === "failed";
                addActivity(activity, activityEntry(when, "command", command, failed));
            }
            if (item.type === "FileChange" && object(item.changes)) {
                for (const [path, change] of Object.entries(item.changes).slice(0, 1000)) {
                    for (const value of [path, object(change) ? change.move_path : undefined]) {
                        if (typeof value === "string") addActivity(activity, activityEntry(when, "file", value));
                    }
                }
            }
            if (!current || current.factsThrough || itemId && currentId && itemId !== currentId || itemId && terminalIds.has(itemId) && !current.endedAt) continue;
            // Late results can contribute facts to an aborted turn, but never reopen it.
            if (item.type === "AgentMessage" && !current.endedAt) {
                const body = text(item.content);
                if (body) lastMessage = boundedAgentMessage(body);
                if (body && (item.phase === "final_answer" || item.phase === "final")) finalMessage = lastMessage;
            }
            if (item.type === "FileChange" && object(item.changes)) {
                for (const [path, change] of Object.entries(item.changes).slice(0, 1000)) {
                    for (const value of [path, object(change) ? change.move_path : undefined]) {
                        if (typeof value !== "string") continue;
                        const file = redact(value, 4096);
                        { const at = current.changedFiles.indexOf(file); if (at >= 0) current.changedFiles.splice(at, 1); if (current.changedFiles.length < 200) current.changedFiles.push(file); }
                    }
                }
            }
            if (item.type === "CommandExecution" && (typeof item.exit_code === "number" && Number.isFinite(item.exit_code) && item.exit_code !== 0 || item.status === "failed") && current.failedCommands.length < 50) {
                const command = typeof item.command === "string" ? redact(item.command, 300)
                    : Array.isArray(item.command) ? redactArgv(item.command.slice(0, 1000).filter((arg): arg is string => typeof arg === "string")) : "";
                if (command) current.failedCommands.push(command);
            }
        }
    };
    const snapshot = (): CodexObservation => {
        const observation: CodexObservation = {
            agent: "codex", nativeId, project, title: redact(fallback.title || firstPrompt || nativeId, 120),
            state, at: at || timestamp(fallback.mtime)!, confidence, sources, human, version: "", turns, subagentRunning: false, activity, activityIncomplete,
            archived: fallback.archived ?? false, isChild,
            ...(originator ? { originator } : {}), ...(parentNativeId ? { parentNativeId } : {}),
            ...(lastPromptAt ? { lastPromptAt } : {}), ...(lastMainRecordAt ? { lastMainRecordAt } : {}),
        };
        observation.version = digest(observation);
        // A later append must not mutate observations already delivered to Store.
        return structuredClone(observation);
    };
    const checkpoint = () => {
        // Clone together so current/suspended still reference their entries in turns.
        const saved = structuredClone({ fallback, metadataId, metadata, hasMetadata, partial, isChild, nativeId, project, originator, parentNativeId,
            firstPrompt, lastPromptAt, lastMainRecordAt, at, state, confidence, human, current, currentId, hasPrompt,
            anonymousTerminal, lastMessage, finalMessage, turns, sources, seen, terminalIds, suspended, activity, activityIncomplete });
        return () => {
            ({ fallback, metadataId, metadata, hasMetadata, partial, isChild, nativeId, project, originator, parentNativeId,
                firstPrompt, lastPromptAt, lastMainRecordAt, at, state, confidence, human, current, currentId, hasPrompt,
                anonymousTerminal, lastMessage, finalMessage, turns, sources, seen, terminalIds, suspended, activity, activityIncomplete } = saved);
        };
    };
    return { push, snapshot, checkpoint, get metadata() { return metadata; }, get hasMetadata() { return hasMetadata; }, get partial() { return partial; } };
}

function remember(set: Set<string>, value: string) {
    set.add(value);
    if (set.size > MAX_RECORDS) set.delete(set.values().next().value!);
}

/** Pure parsing. Only native item_completed UserMessage records supply prompts. */
export function parseCodexRecords(values: unknown[], fallback: CodexFallback): CodexObservation {
    const parser = codexParser({ ...fallback });
    parser.push(values.length > MAX_RECORDS ? [...values.slice(0, MAX_RECORDS / 2), gap, ...values.slice(-MAX_RECORDS / 2)] : values);
    return parser.snapshot();
}

function windows(header: Buffer, tail: Buffer, size: number): unknown[] {
    if (size <= tail.length) return codexRecords(tail.toString("utf8"));
    const offset = size - tail.length;
    if (offset <= header.length) {
        if (!header.subarray(offset).equals(tail.subarray(0, header.length - offset))) throw new Error("core.errorSourceChangedBetweenWindows");
        return codexRecords(Buffer.concat([header.subarray(0, offset), tail]).toString("utf8"));
    }
    const newline = tail.indexOf(10);
    return [...codexRecords(header.toString("utf8")), gap, ...codexRecords(newline < 0 ? "" : tail.subarray(newline + 1).toString("utf8"))];
}

class DecompressedLimitError extends Error { }

/** Retain a bounded prefix and a tail ring; never materialize the full output. */
async function compressedRecords(body: Buffer, limit: number): Promise<unknown[]> {
    const decoder = createZstdDecompress({ chunkSize: 64 * 1024 });
    const prefix = Buffer.alloc(FIRST_LINE_BYTES), tail = Buffer.alloc(TAIL_BYTES);
    let size = 0, prefixSize = 0, prefixTarget = FIRST_LINE_BYTES, firstLineEnd = -1, tailOffset = 0;
    decoder.end(body);
    try {
        for await (const chunk of decoder) {
            const bytes: Buffer = chunk;
            size += bytes.length;
            if (size > limit) throw new DecompressedLimitError("core.errorDecompressedSourceExceedsProcessingLimit");
            if (prefixSize < prefixTarget) {
                const copied = bytes.copy(prefix, prefixSize, 0, Math.min(bytes.length, prefixTarget - prefixSize));
                const previousSize = prefixSize;
                prefixSize += copied;
                if (firstLineEnd < 0) {
                    firstLineEnd = prefix.subarray(0, prefixSize).indexOf(10, previousSize);
                    if (firstLineEnd >= 0) {
                        prefixTarget = Math.max(HEADER_BYTES, firstLineEnd + 1);
                        prefixSize = Math.min(prefixSize, prefixTarget);
                    }
                }
            }
            if (firstLineEnd < 0 && size > FIRST_LINE_BYTES) throw new Error("core.errorFirstLineExceedsSizeCap");
            if (bytes.length >= TAIL_BYTES) {
                bytes.copy(tail, 0, bytes.length - TAIL_BYTES); tailOffset = 0;
            } else {
                const first = Math.min(bytes.length, TAIL_BYTES - tailOffset);
                bytes.copy(tail, tailOffset, 0, first);
                bytes.copy(tail, 0, first);
                tailOffset = (tailOffset + bytes.length) % TAIL_BYTES;
            }
        }
        const suffix = size < TAIL_BYTES ? tail.subarray(0, size)
            : Buffer.concat([tail.subarray(tailOffset), tail.subarray(0, tailOffset)]);
        return windows(prefix.subarray(0, prefixSize), suffix, size);
    } finally { decoder.destroy(); }
}

type Candidate = { path: string; observation: CodexObservation; mtime: number; ready?: boolean; held?: boolean };
type Cached = Candidate & { stamp: string; partial: boolean; unreadable?: boolean; failureSince?: number; emitted?: CodexObservation; needsIdentity?: boolean };
class InvalidCodexSourceError extends Error { }
type FollowState = {
    dev: number; ino: number; size: number; mtime: number; stamp: string;
    /** Next unread byte, including bytes already held in partialLine/sniffer. */
    offset: number;
    lineStart: number;
    partialLine: Buffer;
    prefix?: { length: number; signature: string };
    metadataAnchor?: { offset: number; length: number; signature: string };
    oversized?: CodexLineSniffer;
    parser: ReturnType<typeof codexParser>;
    pending: boolean;
};

function consume(follow: FollowState, bytes: Buffer) {
    if (!follow.prefix && follow.offset === 0 && bytes.length) {
        const length = Math.min(bytes.length, IDENTITY_PREFIX_BYTES);
        follow.prefix = { length, signature: digest(bytes.subarray(0, length).toString("base64")) };
    }
    let start = 0;
    while (start < bytes.length) {
        const newline = bytes.indexOf(10, start);
        const piece = bytes.subarray(start, newline < 0 ? bytes.length : newline);
        if (!follow.oversized && follow.partialLine.length + piece.length > MAX_LINE_BYTES) {
            follow.oversized = new CodexLineSniffer(MAX_LINE_BYTES, FIRST_LINE_BYTES);
            follow.oversized.push(follow.partialLine);
            follow.partialLine = Buffer.alloc(0);
        }
        if (follow.oversized) follow.oversized.push(piece);
        else follow.partialLine = Buffer.concat([follow.partialLine, piece]);
        if (newline < 0) break;
        let record: unknown;
        if (follow.oversized) record = follow.oversized.record();
        else {
            const line = follow.partialLine.toString("utf8");
            if (line.trim()) {
                try { record = JSON.parse(line); } catch { record = invalidGap; }
            }
        }
        if (record) {
            follow.parser.push([record], new Date(follow.mtime).toISOString());
            if (!follow.metadataAnchor && follow.parser.metadata) follow.metadataAnchor = {
                offset: follow.lineStart, length: follow.offset + newline - follow.lineStart, signature: follow.parser.metadata,
            };
        }
        follow.lineStart = follow.offset + newline + 1;
        delete follow.oversized;
        follow.partialLine = Buffer.alloc(0);
        start = newline + 1;
    }
}

function consumeTrailing(follow: FollowState) {
    // Like codexRecords, accept a syntactically complete final record without LF.
    // Keep its bytes until LF arrives; the reducer deduplicates that replay.
    let record: unknown;
    if (follow.oversized?.complete) record = follow.oversized.record();
    else if (follow.oversized?.invalid) record = invalidGap;
    else if (!follow.oversized && follow.partialLine.length) {
        try { record = JSON.parse(follow.partialLine.toString("utf8")); } catch { /* Still being appended. */ }
    }
    if (record) follow.parser.push([record], new Date(follow.mtime).toISOString());
    if (!follow.metadataAnchor && follow.parser.metadata) follow.metadataAnchor = {
        offset: follow.lineStart, length: follow.offset - follow.lineStart, signature: follow.parser.metadata,
    };
}

/** Compare bounded committed identity evidence, including metadata beyond the prefix. */
function matchesIdentity(path: string, follow: FollowState, read: typeof readSourceBytes) {
    const probe = (offset: number, length: number) => {
        const source = read(path, length, false, offset);
        if (source.identity !== digest(`${follow.dev}:${follow.ino}`) || source.size !== follow.size || source.mtime !== follow.mtime || source.body.length !== length) throw new Error("core.errorSourceChangedDuringIdentityCheck");
        return source.body;
    };
    const prefix = follow.prefix;
    if (prefix && digest(probe(0, prefix.length).toString("base64")) !== prefix.signature) return false;
    const anchor = follow.metadataAnchor;
    if (anchor) {
        const body = probe(anchor.offset, anchor.length);
        let record: unknown;
        if (body.length <= MAX_LINE_BYTES) {
            try { record = JSON.parse(body.toString("utf8")); } catch { return false; }
        } else {
            const sniffer = new CodexLineSniffer(MAX_LINE_BYTES, FIRST_LINE_BYTES);
            sniffer.push(body); record = sniffer.record();
        }
        if (metadataSignature(record) !== anchor.signature) return false;
    }
    const authoritativeId = rolloutId(basename(path));
    return !authoritativeId || follow.parser.snapshot().nativeId === authoritativeId;
}

/** Read-only discovery: normalized facts plus bounded unfinished-line state. */
export class CodexSource {
    private cache = new Map<string, Cached>();
    private follows = new Map<string, FollowState>();
    private lastFollowPath: string | undefined;
    private indexCache: { stamp: string; titles: Map<string, string> } | undefined;
    constructor(private root: string, private options: CodexReadOptions = {}) {
        if (options.maxDecompressedBytes !== undefined && (!Number.isSafeInteger(options.maxDecompressedBytes) || options.maxDecompressedBytes < 1 || options.maxDecompressedBytes > CODEX_MAX_DECOMPRESSED_BYTES)) throw new Error("core.errorInvalidDecompressionBudget");
        for (const [value, cap] of [[options.maxFileBytes, MAX_FILE_BYTES], [options.maxPassBytes, MAX_PASS_BYTES], [options.maxPassMs, MAX_PASS_MS]] as const) {
            if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > cap)) throw new Error("core.errorInvalidPlainFileBudget");
        }
    }

    /** True while some followed file still has unread bytes or an unreadable cached entry. */
    get hasBacklog(): boolean {
        // Only keep fast reruns while reads make progress; permanent failures wait for file events.
        if (!this.progressed) return false;
        for (const follow of this.follows.values()) if (follow.pending) return true;
        return false;
    }
    private progressed = false;
    async scan(dirty?: ReadonlySet<string>): Promise<{ sessions: Candidate[]; children: CodexObservation[]; diagnostics: SourceDiagnostic[] }> {
        this.progressed = false;
        const read = this.options.read ?? readSourceBytes, now = (this.options.now ?? Date.now)();
        const home = basename(this.root) === "sessions" ? dirname(this.root) : this.root;
        const sessions = basename(this.root) === "sessions" ? this.root : join(home, "sessions");
        const diagnostics: SourceDiagnostic[] = [], seen = new Set<string>(), candidates = new Map<string, Candidate>();
        const known = new Set([...this.cache.keys(), ...this.follows.keys()]);
        const rollouts: { path: string; archived: boolean }[] = [];
        const pending: { path: string; follow: FollowState; bytes: number; failed: boolean; rollback?: () => void }[] = [];
        const identityClock = this.options.budgetNow ?? (() => performance.now()), identityBegan = identityClock();
        let identityBytes = 0;
        const readIdentity: typeof readSourceBytes = (path, length, tail, offset) => {
            identityBytes += length ?? TAIL_BYTES;
            return (this.options.readIdentity ?? readSourceBytes)(path, length, tail, offset);
        };
        const diagnostic = (code: DiagnosticCode, path: string) => { if (diagnostics.length < MAX_FILES + 3) diagnostics.push({ code, path: redact(path, 4096) }); };
        const fail = (cached: Cached | undefined, transient: boolean) => {
            if (!cached) return;
            cached.unreadable = true;
            if (transient) cached.failureSince ??= now;
            else delete cached.failureSince;
        };
        const stamp = (stat: { dev: number; ino: number; size: number; mtimeMs: number }) => `${digest(`${stat.dev}:${stat.ino}`)}:${stat.size}:${stat.mtimeMs}`;
        const evictMissing = async (path: string) => {
            try { noLinks(path); await lstat(path); }
            catch (error) {
                if (object(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
                    this.cache.delete(path); this.follows.delete(path); known.delete(path); return true;
                }
            }
            return false;
        };
        const index = join(home, "session_index.jsonl");
        try {
            if (dirtyPath(dirty, index)) {
                noLinks(index);
                const stat = await lstat(index), version = stamp(stat);
                if (this.indexCache?.stamp !== version) {
                    const source = read(index, TAIL_BYTES, true);
                    const offset = source.size > source.body.length ? source.body.indexOf(10) : -1;
                    const body = source.size > source.body.length ? offset < 0 ? "" : source.body.subarray(offset + 1).toString("utf8") : source.body.toString("utf8");
                    const titles = new Map<string, string>();
                    for (const raw of codexRecords(body)) {
                        if (object(raw) && raw.type === "aimspan_read_gap") { titles.clear(); diagnostic("codex-index-partial", index); }
                        if (object(raw) && typeof raw.id === "string" && typeof raw.thread_name === "string") titles.set(redact(raw.id, 256), redact(raw.thread_name, 120));
                    }
                    this.indexCache = { stamp: `${source.identity}:${source.size}:${source.mtime}`, titles };
                }
            }
        } catch (error) {
            if (object(error) && error.code === "ENOENT") this.indexCache = undefined;
            else diagnostic("codex-index", index);
        }
        let entries = 0, files = 0, limited = false, sessionsPresent = false, checkedCapacity = false;
        const visit = async (directory: string, depth: number, archived: boolean, directOnly = false): Promise<void> => {
            if (depth > 12 || entries >= MAX_ENTRIES || files >= MAX_FILES) { limited = true; return; }
            try {
                noLinks(directory);
                const list = await readdir(directory, { withFileTypes: true });
                if (directory === sessions) sessionsPresent = true;
                for (const entry of list) {
                    if (++entries > MAX_ENTRIES || files >= MAX_FILES) { limited = true; break; }
                    if (entry.isSymbolicLink()) continue;
                    const path = join(directory, entry.name);
                    if (entry.isDirectory()) { if (!directOnly) await visit(path, depth + 1, archived); continue; }
                    if (!entry.isFile() || !/\.jsonl(?:\.zst)?$/.test(entry.name) || entry.name === "session_index.jsonl") continue;
                    files++; seen.add(path);
                    if (!known.has(path)) {
                        if (known.size >= MAX_FILES && !checkedCapacity) {
                            checkedCapacity = true;
                            for (const previous of known) if (!seen.has(previous)) await evictMissing(previous);
                        }
                        // Retaining known sources must not grow the bounded registry.
                        if (known.size >= MAX_FILES) { limited = true; continue; }
                        known.add(path);
                    }
                    rollouts.push({ path, archived });
                    const cached = this.cache.get(path);
                    const previous = this.follows.get(path);
                    try {
                        if (dirtyPath(dirty, path) || !cached || previous?.pending || cached.unreadable || cached.needsIdentity) {
                            noLinks(path);
                            const stat = await lstat(path), version = stamp(stat);
                            if (path.endsWith(".zst")) {
                                if (!cached || cached.stamp !== version || cached.unreadable) {
                                    if (stat.size > MAX_COMPRESSED_BYTES) throw new Error("core.errorCompressedSourceExceedsSizeCap");
                                    const source = read(path, MAX_COMPRESSED_BYTES);
                                    if (source.size !== source.body.length) throw new Error("core.errorIncompleteCompressedSource");
                                    const records = await compressedRecords(source.body, this.options.maxDecompressedBytes ?? CODEX_MAX_DECOMPRESSED_BYTES);
                                    const parser = codexParser({ nativeId: entry.name.replace(/\.jsonl(?:\.zst)?$/, ""), mtime: new Date(source.mtime).toISOString(), archived });
                                    parser.push(records.length > MAX_RECORDS ? [...records.slice(0, MAX_RECORDS / 2), gap, ...records.slice(-MAX_RECORDS / 2)] : records);
                                    if (!parser.hasMetadata) throw new InvalidCodexSourceError("core.errorMissingSessionMetadata");
                                    const observation = parser.snapshot();
                                    this.cache.set(path, { path, observation, mtime: source.mtime, stamp: `${source.identity}:${source.size}:${source.mtime}`, partial: records.some(raw => object(raw) && raw.type === "aimspan_read_gap" && raw.invalid === true) });
                                }
                            } else {
                                if (!stat.isFile() || stat.nlink !== 1 || process.geteuid && stat.uid !== process.geteuid()) throw new Error("core.errorUnsupportedSource");
                                // Work on a draft; publish it only after this file's pass succeeds.
                                let follow = previous ? { ...previous } : undefined;
                                if (follow && follow.dev === stat.dev && follow.ino === stat.ino && stat.size >= follow.size && follow.stamp !== version) {
                                    const probeBytes = (follow.prefix?.length ?? 0) + (follow.metadataAnchor?.length ?? 0);
                                    // Identity checks have their own bounded pass. Deferred files
                                    // keep their observation and retry without another watch event.
                                    if (identityBytes + probeBytes > MAX_PASS_BYTES || identityClock() - identityBegan >= MAX_PASS_MS) {
                                        if (cached) cached.needsIdentity = true;
                                        diagnostic("codex-budget", path); continue;
                                    }
                                    follow.size = stat.size; follow.mtime = stat.mtimeMs;
                                    if (!matchesIdentity(path, follow, readIdentity)) follow = undefined;
                                    if (cached) delete cached.needsIdentity;
                                }
                                // A same-size rewrite is also detectable without rereading old bytes.
                                if (!follow || follow.dev !== stat.dev || follow.ino !== stat.ino || stat.size < follow.size
                                    || stat.size === follow.size && stat.mtimeMs !== follow.mtime) {
                                    follow = { dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtimeMs, stamp: version,
                                        offset: 0, lineStart: 0, partialLine: Buffer.alloc(0), pending: true,
                                        parser: codexParser({ nativeId: entry.name.slice(0, -6), mtime: new Date(stat.mtimeMs).toISOString(), archived }) };
                                }
                                follow.size = stat.size; follow.mtime = stat.mtimeMs; follow.stamp = version;
                                follow.pending = follow.offset < stat.size;
                                if (follow.pending || !cached || cached.unreadable || cached.stamp !== version) pending.push({ path, follow, bytes: 0, failed: false });
                            }
                        }
                    } catch (error) {
                        diagnostic(error instanceof DecompressedLimitError ? "codex-decompressed-limit" : "codex-read", path);
                        fail(cached, !(error instanceof DecompressedLimitError || error instanceof InvalidCodexSourceError));
                    }
                }
            } catch (error) {
                if (!object(error) || error.code !== "ENOENT") diagnostic("codex-directory", directory);
            }
        };
        await visit(sessions, 0, false);
        await visit(join(home, "archived_sessions"), 0, true);
        // Older callers may supply a flat rollout directory rather than Codex home.
        if (basename(this.root) !== "sessions" && !sessionsPresent) await visit(this.root, 0, false, true);
        for (const path of new Set([...this.cache.keys(), ...this.follows.keys()])) {
            if (seen.has(path)) continue;
            // Directory listings can be incomplete. Only confirmed disappearance
            // evicts a followed source; otherwise keep its last known observation.
            if (await evictMissing(path)) continue;
            const cached = this.cache.get(path);
            if (cached) {
                fail(cached, true);
                rollouts.push({ path, archived: cached.observation.archived });
            }
            diagnostic("codex-discovery", path);
        }
        // One chunk per file per round, rotating the first file across passes.
        // Pending files are eligible even on an unrelated/empty dirty pass.
        const next = pending.findIndex(job => job.path === this.lastFollowPath) + 1;
        const jobs = [...pending.slice(next), ...pending.slice(0, next)];
        const clock = this.options.budgetNow ?? (() => performance.now()), began = clock();
        const passBytes = this.options.maxPassBytes ?? MAX_PASS_BYTES, fileBytes = this.options.maxFileBytes ?? MAX_FILE_BYTES;
        let bytes = 0;
        let active = jobs;
        while (active.length && bytes < passBytes && clock() - began < (this.options.maxPassMs ?? MAX_PASS_MS)) {
            const again: typeof jobs = [];
            for (const job of active) {
                if (bytes >= passBytes || clock() - began >= (this.options.maxPassMs ?? MAX_PASS_MS)) break;
                const { path, follow } = job;
                const length = Math.min(CHUNK_BYTES, follow.size - follow.offset, fileBytes - job.bytes, passBytes - bytes);
                this.lastFollowPath = path;
                try {
                    if (!job.rollback) {
                        job.rollback = follow.parser.checkpoint();
                        if (follow.oversized) follow.oversized = follow.oversized.clone();
                    }
                    if (length > 0) {
                        // Charge attempted bytes too, so failures cannot defeat the budget.
                        bytes += length; job.bytes += length;
                        const source = read(path, length, false, follow.offset);
                        if (source.identity !== digest(`${follow.dev}:${follow.ino}`) || source.size !== follow.size
                            || source.mtime !== follow.mtime || source.body.length !== length) throw new Error("core.errorSourceReplaced");
                        consume(follow, source.body);
                        follow.offset += source.body.length;
                        if (source.body.length > 0) this.progressed = true;
                        follow.pending = follow.offset < follow.size;
                    }
                    if (!follow.pending) consumeTrailing(follow);
                    if (!follow.pending && !follow.parser.hasMetadata) throw new InvalidCodexSourceError("core.errorMissingSessionMetadata");
                    if (follow.pending && job.bytes < fileBytes) again.push(job);
                } catch (error) {
                    job.rollback?.();
                    diagnostic("codex-read", path); job.failed = true;
                    const cached = this.cache.get(path);
                    fail(cached, !(error instanceof InvalidCodexSourceError));
                }
            }
            active = again;
        }
        for (const { path, follow, failed, bytes: readBytes } of jobs) {
            if (!failed) this.follows.set(path, follow);
            if (!failed && follow.parser.hasMetadata && (readBytes || !follow.pending)) {
                this.cache.set(path, { path, observation: follow.parser.snapshot(), mtime: follow.mtime, stamp: follow.stamp, partial: follow.parser.partial });
            }
            if (follow.pending && !failed) diagnostic("codex-budget", path);
        }
        for (const { path, archived } of rollouts) {
            const cached = this.cache.get(path);
            if (!cached) continue;
            const grace = cached.unreadable && cached.failureSince !== undefined && now - cached.failureSince < READ_GRACE_MS;
            const uncertain = !!cached.unreadable && !grace;
            if (cached.unreadable && !dirtyPath(dirty, path)) diagnostic("codex-read", path);
            if (cached.partial) diagnostic("codex-partial", path);
            const observation: CodexObservation = grace && cached.emitted ? structuredClone(cached.emitted)
                : { ...cached.observation, archived, sourceChangedAt: new Date(cached.mtime).toISOString(), sourceUncertain: uncertain || cached.partial || (this.follows.get(path)?.pending ?? false),
                    activityIncomplete: cached.observation.activityIncomplete || uncertain || (this.follows.get(path)?.pending ?? false) };
            if (uncertain) { observation.state = "unknown"; observation.confidence = "unknown"; observation.human = false; observation.subagentRunning = false; }
            const open = observation.turns.at(-1);
            if (!grace && !archived && open && !open.endedAt && !open.factsThrough && now - cached.mtime >= 2 * 3600000) {
                diagnostic("codex-stale", path);
                observation.state = "unknown"; observation.confidence = "unknown"; observation.human = false;
            }
            const title = this.indexCache?.titles.get(observation.nativeId);
            if (title && !grace) observation.title = title;
            const ready = !cached.unreadable && !cached.needsIdentity && !observation.sourceUncertain && observation.confidence !== "unknown" && !(this.follows.get(path)?.pending ?? false);
            const previous = candidates.get(observation.nativeId);
            if (!previous || ready && !previous.ready || ready === previous.ready && (previous.observation.archived && !archived || previous.observation.archived === archived && cached.mtime > previous.mtime)) candidates.set(observation.nativeId, { path, mtime: cached.mtime, observation, ready, held: !!grace });
        }

        if (limited) diagnostic("codex-limit", home);
        for (const child of candidates.values()) {
            if (child.held || !child.observation.isChild || !child.observation.parentNativeId || child.observation.archived || child.observation.sourceUncertain) continue;
            const turn = child.observation.turns.at(-1);
            const running = child.observation.state === "working" && turn && !turn.endedAt && !turn.factsThrough;
            const waitingAt = child.observation.state === "waiting" ? child.observation.at
                : (child.observation.state === "ended" || child.observation.state === "failed") && turn?.endedAt && !turn.aborted ? turn.endedAt : undefined;
            if (!running && !waitingAt) continue;
            let parentId: string | undefined = child.observation.parentNativeId;
            const visited = new Set<string>([child.observation.nativeId]);
            for (let depth = 0; parentId && depth < 12 && !visited.has(parentId); depth++) {
                visited.add(parentId);
                const parentCandidate = candidates.get(parentId);
                if (parentCandidate?.held) break;
                const parent: CodexObservation | undefined = parentCandidate?.observation;
                if (!parent || parent.archived || parent.turns.at(-1)?.aborted) break;
                if (running) { parent.subagentRunning = true; parent.state = "working"; parent.confidence = "inferred"; parent.human = false; }
                if (waitingAt && waitingAt > (parent.subagentWaitingAt ?? "")) parent.subagentWaitingAt = waitingAt;
                if (child.observation.at > parent.at) parent.at = child.observation.at;
                parentId = parent.parentNativeId;
            }
        }
        const result: Candidate[] = [], children: CodexObservation[] = [];
        for (const candidate of candidates.values()) {
            const cached = this.cache.get(candidate.path)!;
            if (candidate.observation.isChild) { children.push(candidate.observation); continue; }
            candidate.observation.version = digest({ ...candidate.observation, version: "" });
            if (!cached.unreadable) cached.emitted = structuredClone(candidate.observation);
            result.push(candidate);
        }
        return { sessions: result, children, diagnostics };
    }
}
