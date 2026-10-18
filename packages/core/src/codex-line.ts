type Phase = "keyOrEnd" | "key" | "colon" | "value" | "valueOrEnd" | "commaOrEnd";
type Frame = { path: string; array: boolean; phase: Phase; key?: string };

/** Bounded JSON validation and selective extraction; oversized values are never materialized. */
export class CodexLineSniffer {
    private frames: Frame[] = [];
    private root: "value" | "end" = "value";
    private bad = false;
    private quoted = false;
    private escaped = false;
    private unicode = 0;
    private utf8 = 0;
    private utf8Min = 128;
    private utf8Max = 191;
    private primitive = "";
    private literal = "";
    private literalAt = 0;
    private key = false;
    private token = "";
    private target = "";
    private dropped = false;
    private position = 0;
    private fields: Record<string, unknown> = Object.create(null);
    private compound: { path: string; depth: number; token: string } | undefined;
    constructor(private prefixBytes: number, private metadataBytes: number) {}

    clone(): CodexLineSniffer {
        return Object.assign(new CodexLineSniffer(this.prefixBytes, this.metadataBytes), structuredClone(this));
    }
    private valuePath() {
        const frame = this.frames.at(-1);
        return frame && !frame.array && !frame.key?.includes(".") ? `${frame.path}${frame.key ?? ""}` : "";
    }
    private clearPath(path: string) {
        if (!path) return;
        for (const field of Object.keys(this.fields)) if (field === path || field.startsWith(`${path}.`)) delete this.fields[field];
    }
    private begin(quoted: boolean, key = false) {
        this.quoted = quoted; this.key = key; this.escaped = false; this.unicode = 0;
        const path = this.valuePath();
        if (!key) this.clearPath(path);
        this.target = /^(type|timestamp|created_at|payload\.(type|turn_id|started_at|completed_at|duration_ms|reason|error|id|cwd|originator|thread_source|parent_thread_id|source|source\.subagent|source\.subagent\.thread_spawn\.parent_thread_id))$/.test(path)
            || path === "payload.last_agent_message" && this.position <= this.prefixBytes ? path : "";
        // Presence still identifies an internal thread when its value exceeds the text budget.
        if (!key && (this.target === "payload.source.subagent" || this.target === "payload.thread_source")) this.fields[this.target] = {};
        this.token = quoted ? '"' : ""; this.dropped = false;
    }
    private add(byte: number) {
        if (!this.key && !this.target || this.dropped) return;
        if (this.token.length >= (this.key ? 64 : this.prefixBytes)
            || this.target === "payload.last_agent_message" && this.position > this.prefixBytes) {
            this.token = ""; this.dropped = true; return;
        }
        this.token += String.fromCharCode(byte);
    }
    private valueDone() {
        const frame = this.frames.at(-1);
        if (frame) frame.phase = "commaOrEnd";
        else this.root = "end";
    }
    private finish() {
        if (!this.dropped && (this.key || this.target)) {
            try {
                const value: unknown = JSON.parse(Buffer.from(this.token, "latin1").toString("utf8"));
                if (this.key) {
                    const frame = this.frames.at(-1)!;
                    if (typeof value === "string") frame.key = value;
                } else this.fields[this.target] = value;
            } catch { this.bad = true; }
        }
        if (this.key) this.frames.at(-1)!.phase = "colon";
        else this.valueDone();
        this.quoted = false; this.primitive = ""; this.token = "";
    }
    private stringByte(byte: number) {
        this.add(byte);
        if (this.utf8) {
            if (byte < this.utf8Min || byte > this.utf8Max) this.bad = true;
            this.utf8--; this.utf8Min = 128; this.utf8Max = 191; return;
        }
        if (this.unicode) {
            if (!(byte >= 48 && byte <= 57 || byte >= 65 && byte <= 70 || byte >= 97 && byte <= 102)) this.bad = true;
            this.unicode--; return;
        }
        if (this.escaped) {
            if (byte === 117) this.unicode = 4;
            else if (![34, 47, 92, 98, 102, 110, 114, 116].includes(byte)) this.bad = true;
            this.escaped = false; return;
        }
        if (byte === 92) this.escaped = true;
        else if (byte === 34) this.finish();
        else if (byte < 32) this.bad = true;
        else if (byte >= 128) {
            if (byte >= 194 && byte <= 223) this.utf8 = 1;
            else if (byte >= 224 && byte <= 239) {
                this.utf8 = 2; this.utf8Min = byte === 224 ? 160 : 128; this.utf8Max = byte === 237 ? 159 : 191;
            } else if (byte >= 240 && byte <= 244) {
                this.utf8 = 3; this.utf8Min = byte === 240 ? 144 : 128; this.utf8Max = byte === 244 ? 143 : 191;
            } else this.bad = true;
        }
    }
    private numberByte(byte: number) {
        const digit = byte >= 48 && byte <= 57;
        switch (this.primitive) {
            case "minus": this.primitive = byte === 48 ? "zero" : byte >= 49 && byte <= 57 ? "int" : "bad"; break;
            case "zero": case "int":
                if (digit && this.primitive === "int") break;
                this.primitive = byte === 46 ? "dot" : byte === 101 || byte === 69 ? "exp" : "bad"; break;
            case "dot": this.primitive = digit ? "frac" : "bad"; break;
            case "frac": if (!digit) this.primitive = byte === 101 || byte === 69 ? "exp" : "bad"; break;
            case "exp": this.primitive = byte === 43 || byte === 45 ? "sign" : digit ? "expDigits" : "bad"; break;
            case "sign": this.primitive = digit ? "expDigits" : "bad"; break;
            case "expDigits": if (!digit) this.primitive = "bad"; break;
        }
        if (this.primitive === "bad") this.bad = true;
    }
    push(bytes: Buffer) {
        for (const byte of bytes) {
            this.position++;
            if (this.bad) continue;
            if (this.compound) {
                if (this.compound.token.length >= this.prefixBytes || this.compound.path === "payload.last_agent_message" && this.position > this.prefixBytes) this.compound = undefined;
                else this.compound.token += String.fromCharCode(byte);
            }
            if (this.quoted) { this.stringByte(byte); continue; }
            if (this.primitive) {
                if (![9, 10, 13, 32, 44, 93, 125].includes(byte)) {
                    this.add(byte);
                    if (this.primitive === "literal") {
                        if (this.literal.charCodeAt(this.literalAt++) !== byte) this.bad = true;
                    } else this.numberByte(byte);
                    continue;
                }
                if (this.primitive === "literal" ? this.literalAt !== this.literal.length : !["zero", "int", "frac", "expDigits"].includes(this.primitive)) this.bad = true;
                this.finish();
                if (this.bad) continue;
            }
            if ([9, 10, 13, 32].includes(byte)) continue;
            const frame = this.frames.at(-1);
            if (byte === 125 || byte === 93) {
                if (!frame || frame.array !== (byte === 93) || !["keyOrEnd", "valueOrEnd", "commaOrEnd"].includes(frame.phase)) { this.bad = true; continue; }
                this.frames.pop();
                if (this.compound && this.frames.length === this.compound.depth) {
                    try { this.fields[this.compound.path] = JSON.parse(Buffer.from(this.compound.token, "latin1").toString("utf8")); } catch { this.bad = true; }
                    this.compound = undefined;
                }
                this.valueDone(); continue;
            }
            if (frame?.phase === "colon") {
                if (byte === 58) frame.phase = "value";
                else this.bad = true;
                continue;
            }
            if (frame?.phase === "commaOrEnd") {
                if (byte === 44) { frame.phase = frame.array ? "value" : "key"; delete frame.key; }
                else this.bad = true;
                continue;
            }
            if (frame?.phase === "keyOrEnd" || frame?.phase === "key") {
                if (byte === 34) this.begin(true, true);
                else this.bad = true;
                continue;
            }
            if (!frame && this.root === "end") { this.bad = true; continue; }
            if (byte === 34) { this.begin(true); continue; }
            if (byte === 123 || byte === 91) {
                if (this.frames.length >= 64) { this.bad = true; continue; }
                const path = this.valuePath();
                this.clearPath(path);
                if (path === "payload.source.subagent" || path === "payload.thread_source") this.fields[path] = {};
                if (path === "payload.error") this.fields[path] = true;
                if (path === "payload.error" || path === "payload.last_agent_message" && this.position <= this.prefixBytes) this.compound = { path, depth: this.frames.length, token: String.fromCharCode(byte) };
                this.frames.push({ path: this.frames.length ? path ? `${path}.` : "!" : "", array: byte === 91, phase: byte === 91 ? "valueOrEnd" : "keyOrEnd" });
                continue;
            }
            this.begin(false); this.add(byte);
            if (byte === 116 || byte === 102 || byte === 110) {
                this.primitive = "literal"; this.literal = byte === 116 ? "true" : byte === 102 ? "false" : "null"; this.literalAt = 1;
            } else if (byte === 45) this.primitive = "minus";
            else if (byte >= 48 && byte <= 57) this.primitive = byte === 48 ? "zero" : "int";
            else this.bad = true;
        }
    }
    get invalid() { return this.bad; }
    get complete() { return !this.bad && this.root === "end" && this.frames.length === 0 && !this.quoted && !this.primitive; }
    record(): unknown {
        const { type, timestamp, created_at } = this.fields;
        if (!this.complete || typeof type !== "string") return { type: "aimspan_read_gap", invalid: true };
        const payload: Record<string, unknown> = Object.create(null);
        for (const [key, value] of Object.entries(this.fields)) {
            if (key === "payload.source.subagent") payload.source = { subagent: value };
            else if (key === "payload.source.subagent.thread_spawn.parent_thread_id") payload.source = { subagent: { thread_spawn: { parent_thread_id: value } } };
            else if (key.startsWith("payload.")) payload[key.slice(8)] = value;
        }
        return { type, timestamp, created_at, payload,
            ...(type === "event_msg" && (payload.type === "item_completed" || payload.type === "error") ? { aimspan_activity_incomplete: true } : {}),
            ...(type === "session_meta" && this.position > this.metadataBytes ? { aimspan_metadata_limited: true } : {}) };
    }
}
