import type { MessageRef as WireMessageRef, MessageResult } from "@aimspan/protocol";
import { en } from "./en";
import { zhCN } from "./zh-CN";
import type { Locale, MessageKey } from "./index";

export type MessageRef = WireMessageRef<MessageKey>;
export type CatalogMessage = MessageResult & { messageRef: MessageRef };
type Params<K extends MessageKey> = typeof en[K] extends (...args: infer P extends Array<string | number>) => string ? P : [];
type ReferenceParams<P extends Array<string | number>> = { [I in keyof P]: P[I] | (string extends P[I] ? MessageRef : never) };

/** Keep user text as literal parameters; only explicit refs are translated recursively. */
export function messageRef<K extends MessageKey>(key: K, ...params: ReferenceParams<Params<K>>): MessageRef;
export function messageRef(key: MessageKey, ...params: Array<string | number | MessageRef>): MessageRef {
    return params.length ? { key, params } : { key };
}

function resolveMessage(locale: Locale, ref: WireMessageRef, depth = 0): string | undefined {
    if (depth > 16 || !ref || !Object.hasOwn(en, ref.key)) return undefined;
    const entry = (locale === "en" ? en : zhCN)[ref.key as MessageKey];
    const params = ref.params ?? [];
    if (!Array.isArray(params)) return undefined;
    if (typeof entry === "string") return params.length ? undefined : entry;
    if (params.length !== entry.length) return undefined;
    const resolved: Array<string | number> = [];
    for (const param of params) {
        const value = typeof param === "object" ? resolveMessage(locale, param, depth + 1) : param;
        if (value === undefined) return undefined;
        resolved.push(value);
    }
    return (entry as (...args: Array<string | number>) => string)(...resolved);
}

/** Main retains fallback text for consumers without a compatible catalog. */
export function messageResult(locale: Locale, ref: MessageRef): CatalogMessage {
    const message = resolveMessage(locale, ref);
    if (message === undefined) throw new Error("desktop.invalidMessageRef");
    return { message, messageRef: ref };
}

export function renderMessage(locale: Locale, result: MessageResult): string {
    return result.messageRef ? resolveMessage(locale, result.messageRef) ?? result.message : result.message;
}
