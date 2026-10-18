import type { DiagnosticCode, SourceDiagnostic, SourceRef } from "@aimspan/protocol";
import { translator, type Language, type MessageKey } from "../shared/i18n";

const labels = {
    "codex-stale": "codexStale", "codex-read": "codexRead", "codex-partial": "codexPartial",
    "codex-index": "codexIndex", "codex-index-partial": "codexIndexPartial", "codex-directory": "codexDirectory",
    "codex-decompressed-limit": "codexDecompressedLimit", "codex-limit": "codexLimit", "codex-budget": "codexBudget",
    "codex-discovery": "codexDiscovery", "watch-fallback": "watchFallback", "discovery.read": "discoveryRead",
    "claude.source.uncertain": "claudeSourceUncertain", "claude.source.limit": "claudeSourceLimit",
    "claude.source.unreadable": "claudeSourceUnreadable", "claude.registry.limit": "claudeRegistryLimit",
    "claude.registry.uncertain": "claudeRegistryUncertain", "claude.registry.unreadable": "claudeRegistryUnreadable",
} as const satisfies Record<DiagnosticCode, MessageKey>;

export function sourceLabel(kind: SourceRef["kind"], language: Language = "en"): string {
    return translator(language)(kind === "user" ? "sourceUser" : "sourceAgent");
}
export function diagnosticView(diagnostic: SourceDiagnostic, language: Language = "en"): { label: string; path?: string } {
    const t = translator(language);
    const label = t(labels[diagnostic.code] ?? "sourceNeedsAttention");
    // Paths are bounded and redacted by Core; abbreviate without filesystem authority.
    const detail = diagnostic.path;
    const abbreviated = detail?.startsWith("/") ? detail.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~") : undefined;
    if (abbreviated === undefined) return { label };
    const characters = Array.from(abbreviated);
    const path = characters.length <= 72 ? abbreviated : `${characters.slice(0, 32).join("")}…${characters.slice(-39).join("")}`;
    return { label, path };
}
