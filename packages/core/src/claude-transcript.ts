import { object } from "@aimspan/protocol";
import { claudeRecords, isClaudePrompt, type ClaudeReadOptions } from "./claude.js";
import { readSource, readSourceBytes } from "./security.js";

const HEADER_BYTES = 48 * 1024;
export const CLAUDE_CHUNK_BYTES = 256 * 1024;
export const CLAUDE_READ_BUDGET = 8 * 1024 * 1024;
const MAX_RECORDS = 5000;
const gap = { type: "aimspan_read_gap" };
type SourceStamp = { identity: string; size: number; mtime: number };
function sameSource(a: SourceStamp, b: SourceStamp) {
    if (a.identity !== b.identity || a.size !== b.size || a.mtime !== b.mtime) throw new Error("core.errorSourceChangedDuringRead");
}
const isEnd = (raw: unknown) => object(raw) && raw.isSidechain !== true && raw.type === "assistant" && object(raw.message) && raw.message.stop_reason === "end_turn";

/** Byte chunks join before UTF-8 decoding. Only normalized observations are cached by Discovery. */
export function readClaudeTranscript(path: string, options: ClaudeReadOptions = {}): SourceStamp & { records: unknown[] } {
    const read = options.read ?? readSource, bytes = options.readBytes ?? readSourceBytes;
    const header = read(path, HEADER_BYTES);
    if (header.size <= CLAUDE_CHUNK_BYTES) {
        const tail = read(path, CLAUDE_CHUNK_BYTES, true);
        sameSource(header, tail);
        return { identity: tail.identity, size: tail.size, mtime: tail.mtime, records: claudeRecords(tail.body) };
    }
    const headerEnd = header.body.lastIndexOf("\n") + 1;
    const headerRecords = claudeRecords(header.body.slice(0, headerEnd));
    const titles = new Map<string, { position: number; body: string }>();
    const rememberTitle = (raw: unknown, position: number) => {
        if (!object(raw) || raw.isSidechain === true || raw.type !== "custom-title" && raw.type !== "ai-title") return;
        const value = (raw.type === "custom-title" ? raw.customTitle : raw.aiTitle) ?? raw.title;
        const body = typeof value === "string" ? value : Array.isArray(value)
            ? value.flatMap(block => object(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n") : "";
        if (body && position > (titles.get(raw.type)?.position ?? -1)) titles.set(raw.type, { position, body });
    };
    let headerPosition = 0;
    for (const line of header.body.slice(0, headerEnd).split("\n")) {
        try { rememberTitle(JSON.parse(line), headerPosition); } catch { /* Incomplete/invalid records have no title authority. */ }
        headerPosition += Buffer.byteLength(line) + 1;
    }
    let remaining = CLAUDE_READ_BUDGET - Math.min(header.size, HEADER_BYTES);
    let offset = header.size, start = header.size, pending = Buffer.alloc(0), skippingLongLine = false;
    let foundPrompt = false, foundEnd = false, done = false, retained = 0;
    const reversed: unknown[] = [];
    const addGap = () => { if (!done && reversed.at(-1) !== gap) reversed.push(gap); };
    const accept = (line: Buffer, position: number) => {
        if (!line.length) return;
        if (line.length > CLAUDE_CHUNK_BYTES) { addGap(); return; }
        let raw: unknown;
        try { raw = JSON.parse(line.toString("utf8")); } catch { addGap(); return; }
        rememberTitle(raw, position);
        if (done) return;
        const prompt = isClaudePrompt(raw), end = isEnd(raw);
        // Reserve room for lifecycle anchors beyond a busy tail's fact budget.
        if (retained < MAX_RECORDS - 8 || (prompt || end) && retained < MAX_RECORDS) { reversed.push(raw); retained++; }
        else addGap();
        if (prompt && !foundPrompt) { foundPrompt = true; if (foundEnd) done = true; }
        if (end) { if (foundPrompt) done = true; else foundEnd = true; }
    };
    // A header title cannot prove that no later rename exists in the omitted middle.
    const titlesComplete = () => {
        const custom = titles.get("custom-title");
        return custom !== undefined && custom.position >= offset;
    };
    while (offset > 0 && remaining > 0 && (!done || !titlesComplete())) {
        const length = Math.min(CLAUDE_CHUNK_BYTES, offset, remaining);
        offset -= length; remaining -= length;
        const source = bytes(path, length, false, offset);
        sameSource(header, source);
        if (source.body.length !== length) throw new Error("core.errorIncompleteSourceChunk");
        const joined = Buffer.concat([source.body, pending]);
        let end = joined.length;
        for (let newline = joined.lastIndexOf(10, end - 1); newline >= 0; newline = end > 0 ? joined.lastIndexOf(10, end - 1) : -1) {
            const position = offset + newline + 1;
            if (!done) start = position;
            if (skippingLongLine) { addGap(); skippingLongLine = false; }
            else accept(joined.subarray(newline + 1, end), position);
            end = newline;
        }
        if (offset === 0) {
            if (!done) start = 0;
            if (skippingLongLine) addGap(); else accept(joined.subarray(0, end), 0);
        } else if (end > CLAUDE_CHUNK_BYTES || skippingLongLine) {
            pending = Buffer.alloc(0); skippingLongLine = true;
        } else pending = joined.subarray(0, end);
    }
    const tailRecords = reversed.reverse();
    // A missing interval stays explicit, even if byte windows overlap a split record.
    const records = start === 0 ? tailRecords : [...headerRecords,
        ...(start <= Buffer.byteLength(header.body.slice(0, headerEnd)) ? [] : [gap]), ...tailRecords];
    // Title-only records cannot bridge a turn gap or alter prompt/reply timestamps.
    const titleRecords = [...titles].sort((a, b) => a[1].position - b[1].position).map(([type, title]) => ({ type, title: title.body }));
    return { identity: header.identity, size: header.size, mtime: header.mtime,
        records: [...records.filter(raw => !object(raw) || raw.type !== "custom-title" && raw.type !== "ai-title"), ...titleRecords] };
}
