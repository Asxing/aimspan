import { translator, type Language } from "../shared/i18n";
import { CODEX_CLIENT_IDS, isInteractiveSession, type Session } from "@aimspan/protocol";

/** Core stores the Codex originator in entrypoint. Client names override surfaces. */
export function surfaceTag(session: Pick<Session, "agent" | "surface" | "entrypoint" | "interactive">, language: Language = "en"): string {
    const t = translator(language);
    if (session.agent === "codex" && session.entrypoint && CODEX_CLIENT_IDS.some(id => id === session.entrypoint)) {
        return t(({ openclaw: "openClaw", aimspan: "aimSpan", "codex-chrome-extension-sidepanel": "chromeExtension" } as const)[session.entrypoint as typeof CODEX_CLIENT_IDS[number]]);
    }
    if (!isInteractiveSession(session)) return t("automated");
    const app = session.agent === "codex" ? t("codex") : t("claude");
    const suffix = { desktop: t("desktop"), cli: t("cli"), vscode: t("vsCode"), unknown: "", automation: "" }[session.surface];
    return suffix ? `${app} ${suffix}` : app;
}
