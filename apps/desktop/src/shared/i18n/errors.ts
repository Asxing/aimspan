import { en } from "./en";
import { zhCN } from "./zh-CN";
import { t, type Language } from "./index";

type TextKey = { [K in keyof typeof en]: typeof en[K] extends string ? K : never }[keyof typeof en];
const messages = new Map<string, TextKey>();
for (const key of Object.keys(en) as (keyof typeof en)[]) {
    if (typeof en[key] === "string") {
        const textKey = key as TextKey;
        messages.set(en[textKey], textKey);
        messages.set(zhCN[textKey], textKey);
        if (key.startsWith("error")) {
            messages.set(`core.${key}`, textKey);
            messages.set(`desktop.${key}`, textKey);
        }
    }
}
messages.set("CAPTURE_STALE_OPEN", "captureStaleOpen");
/** Electron wraps rejected IPC errors. Strip its envelope, then translate known codes/copy. */
export function errorMessage(error: unknown, language: Language = "en"): string {
    const message = error instanceof Error ? error.message : String(error);
    const bare = message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "").replace(/^Error: /, "");
    const key = messages.get(bare);
    return key ? t(language, key) : t(language, "operationFailed");
}
