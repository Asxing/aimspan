import { constants, lstatSync, mkdirSync, realpathSync, chmodSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { dirname, resolve, parse, relative, sep } from "node:path";
import { createHash } from "node:crypto";
export const digest = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");
export function redact(s: string, limit = 12000): string {
    const source = s.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[redacted]");
    // Shell continuations do not split a word. Match on logical text, but map
    // replacements back to the original so unrelated prose keeps its formatting.
    let logical = source;
    let offsets: number[] | undefined;
    if (/\\\r?\n/.test(source)) {
        logical = ""; offsets = [0];
        for (let i = 0; i < source.length;) {
            if (source[i] === "\\" && source[i + 1] === "\n") { i += 2; continue; }
            if (source[i] === "\\" && source[i + 1] === "\r" && source[i + 2] === "\n") { i += 3; continue; }
            logical += source[i++];
            offsets.push(i);
        }
    }
    const ranges: [number, number][] = [];
    const mask = (start: number, end: number) => ranges.push([offsets?.[start] ?? start, offsets?.[end] ?? end]);
    const pairs = /(\b((?:[a-z][a-z0-9_]*_)?(?:authorization|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key))\b["']?\s*([:=])\s*)("(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|(?:(?:Bearer|Basic)[ \t]+)?(?:\\[^\r\n]|[^\s"'`,;}&|<>])+)/gi;
    for (const match of logical.matchAll(pairs)) {
        const [, prefix, key, separator, value] = match;
        // A bare prose label such as "token: Identifier" is ambiguous. An
        // assignment, quoting, a credential-specific key or a non-word value
        // supplies credential context; the bare alphabetic label does not.
        if (key!.toLowerCase() === "token" && separator === ":" && !/["']/.test(prefix!) && /^[a-z]+$/i.test(value!.replace(/[.,!?)]+$/, ""))) continue;
        mask(match.index! + prefix!.length, match.index! + match[0].length);
    }
    // Long credential flags establish command context. Preserve prose labels
    // and short options such as -p, which often mean a path or a port.
    const flags = /(^|[\s"'`])--(?:token|api-key|password|secret)\s+((?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|\\[^\r\n]|[^\s"'`,;}&|<>])+)/gi;
    for (const match of logical.matchAll(flags)) {
        const value = match[2]!;
        mask(match.index! + match[0].length - value.length, match.index! + match[0].length);
    }
    for (const match of logical.matchAll(/\bBearer[ \t]+((?:\\[^\r\n]|[^\s"'`,;}&|<>])+)/gi)) {
        const value = match[1]!;
        // Trailing sentence punctuation is not token evidence ("Bearer responsibilities.").
        const word = value.replace(/[.,!?)]+$/, "");
        if (word.length >= 16 && /[^a-z]/i.test(word)) mask(match.index! + match[0].length - value.length, match.index! + match[0].length);
    }
    let output = "", end = 0;
    for (const [start, stop] of ranges.sort((a, b) => a[0] - b[0])) {
        if (start >= end) output += source.slice(end, start) + "[redacted]";
        end = Math.max(end, stop);
    }
    return (output + source.slice(end)).slice(0, limit);
}
/** Arg boundaries matter: an unquoted argv value can contain spaces or newlines. */
export function redactArgv(argv: string[], limit = 300): string {
    let credential = false;
    const safe = argv.slice(0, 1000).map(arg => {
        if (credential) { credential = false; return "[redacted]"; }
        credential = /^--(?:token|api-key|password|secret)$/i.test(arg);
        return arg;
    });
    return redact(safe.join(" "), limit);
}
export function inside(root: string, path: string) { const r = relative(resolve(root), resolve(path)); return r !== ".." && !r.startsWith(`..${sep}`) && !r.startsWith(sep); }
export function noLinks(path: string) { let p = resolve(path); const stop = parse(p).root; while (p !== stop) {
    const s = lstatSync(p);
    if (s.isSymbolicLink())
        throw new Error("core.errorSymlinkPathsAreNotSupported");
    p = dirname(p);
} }
export function privateDirectory(path: string) { mkdirSync(path, { recursive: true, mode: 0o700 }); noLinks(path); const s = lstatSync(path); if (!s.isDirectory() || (process.geteuid && s.uid !== process.geteuid()))
    throw new Error("core.errorUnsafeStateDirectory"); chmodSync(path, 0o700); return realpathSync(path); }
export function privateFile(path: string) { noLinks(path); const s = lstatSync(path); if (!s.isFile() || s.nlink !== 1 || (process.geteuid && s.uid !== process.geteuid()))
    throw new Error("core.errorUnsafeStateFile"); chmodSync(path, 0o600); }
/** Bounded regular-file reads. Parent identity checked before/after; no claim of hostile same-user OS confinement. */
export function readSourceBytes(path: string, maxBytes = 256 * 1024, tail = false, offset?: number): {
    body: Buffer;
    identity: string;
    size: number;
    mtime: number;
} {
    noLinks(path);
    const parent = lstatSync(dirname(path));
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
        const a = fstatSync(fd);
        if (!a.isFile() || a.nlink !== 1 || (process.geteuid && a.uid !== process.geteuid()))
            throw new Error("core.errorUnsupportedSource");
        if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0 || offset > a.size || tail)) throw new Error("core.errorInvalidSourceOffset");
        const start = offset ?? (tail ? Math.max(0, a.size - maxBytes) : 0);
        const b = Buffer.alloc(Math.min(maxBytes, a.size - start));
        const n = readSync(fd, b, 0, b.length, start);
        const z = fstatSync(fd);
        const current = lstatSync(path);
        const p = lstatSync(dirname(path));
        if (n !== b.length || a.ino !== z.ino || a.size !== z.size || a.mtimeMs !== z.mtimeMs || a.ino !== current.ino || a.dev !== current.dev || current.size !== z.size || current.mtimeMs !== z.mtimeMs || parent.ino !== p.ino || parent.dev !== p.dev || current.isSymbolicLink())
            throw new Error("core.errorSourceChangedDuringRead");
        return { body: b, identity: digest(`${a.dev}:${a.ino}`), size: a.size, mtime: a.mtimeMs };
    }
    finally {
        closeSync(fd);
    }
}
export function readSource(path: string, maxBytes = 256 * 1024, tail = false): {
    body: string; identity: string; size: number; mtime: number;
} {
    const source = readSourceBytes(path, maxBytes, tail);
    let body = source.body.toString("utf8");
    if (tail && source.size > maxBytes) body = body.slice(body.indexOf("\n") + 1);
    return { ...source, body };
}
