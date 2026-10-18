import { messageRef, messageResult, type CatalogMessage } from "../shared/i18n/messages";
import { type Language } from "../shared/i18n";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NewSessionApp } from "@aimspan/protocol";

const exec = promisify(execFile);
const bundles = { codex: "com.openai.codex", claude: "com.anthropic.claudefordesktop" } as const;
export const NEW_SESSION_ENTRIES = { codex: bundles.codex, claude: "claude://code/new?source=desktop_action" } as const;
export function newSessionHint(app: NewSessionApp, language: Language = "en"): CatalogMessage {
    return messageResult(language, messageRef(app === "codex" ? "newCodexHint" : "newClaudeHint"));
}
/** Fixed entry points only. No keys, pasted text, project paths or guessed Codex URLs. */
export async function openNewSession(app: NewSessionApp, shell: { openExternal(url: string): Promise<unknown> },
    openBundle: (id: string) => Promise<unknown> = id => exec("/usr/bin/open", ["-b", id]), language: Language = "en"): Promise<CatalogMessage> {
    if (app === "claude") {
        try { await shell.openExternal(NEW_SESSION_ENTRIES.claude); return newSessionHint(app, language); }
        catch { /* The app itself is the fallback when its new-session entry is unavailable. */ }
    }
    try {
        await openBundle(bundles[app]);
        const hint = newSessionHint(app, language);
        return app === "claude" ? messageResult(language, messageRef("newSessionManual", hint.messageRef)) : hint;
    } catch {
        return messageResult(language, messageRef("newSessionOpenFailed", messageRef(app === "codex" ? "codex" : "claude")));
    }
}
