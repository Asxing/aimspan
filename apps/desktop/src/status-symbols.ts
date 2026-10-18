import { translator, type Language } from "./shared/i18n";
import type { RunState } from "@aimspan/protocol";

/** Native tray symbols and renderer colors share the same semantic tokens. */
export const statusSymbols = {
    running: { symbol: "🟢", color: "var(--color-running)" },
    waiting: { symbol: "🟠", color: "var(--color-waiting)" },
    idle: { symbol: "", color: "var(--color-secondary)" },
    unknown: { symbol: "", color: "var(--color-secondary)" },
} satisfies Record<RunState, { symbol: string; color: string }>;

type Counts = { running: number; waiting: number };
export function attentionSymbols(counts: Counts) {
    return (["running", "waiting"] as const).filter(state => counts[state] > 0)
        .map(state => ({ state, count: counts[state], ...statusSymbols[state] }));
}
export function attentionTitle(counts: Counts): string {
    return attentionSymbols(counts).map(({ symbol, count }) => `${symbol}${count}`).join(" ");
}
export function attentionTooltip({ running, waiting }: Counts, language: Language = "en"): string {
    const t = translator(language);
    return t("attentionCounts", running, waiting);
}
