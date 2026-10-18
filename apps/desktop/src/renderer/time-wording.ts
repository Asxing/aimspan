import { translator, type Language } from "../shared/i18n";
import type { Session } from "@aimspan/protocol";

export type SessionTime = Pick<Session, "state" | "lastPromptAt" | "lastTurnEndAt" | "lastActivityAt" | "observedAt">;

/** Duration, rounded down at minute/hour/day boundaries. */
export function elapsedLabel(milliseconds: number, language: Language = "en"): string {
    const t = translator(language);
    const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
    if (!Number.isFinite(minutes)) return t("durationUnknown");
    if (minutes < 1) return t("lessThanMinute");
    if (minutes < 60) return t("minutes", minutes);
    if (minutes < 1440) return t("hours", Math.floor(minutes / 60));
    return t("days", Math.floor(minutes / 1440));
}

function elapsedSince(at: string | undefined, now: number): number | null {
    const timestamp = Date.parse(at ?? "");
    return Number.isFinite(timestamp) && Number.isFinite(now) ? Math.max(0, now - timestamp) : null;
}

/** Relative timestamp; clock skew and future timestamps are always just now. */
export function timeAgo(at: string | undefined, now = Date.now(), language: Language = "en"): string {
    const t = translator(language);
    const elapsed = elapsedSince(at, now);
    return elapsed === null ? t("timeUnknown") : elapsed < 60_000 ? t("justNow") : t("ago", elapsedLabel(elapsed, language));
}

/** Complete row wording, shared by the panel and compact list. */
export function sessionTimeLabel(session: SessionTime, now = Date.now(), language: Language = "en"): string {
    const t = translator(language);
    if (session.state === "unknown") return t("checkingStatus");
    if (session.state === "idle") return elapsedSince(session.lastTurnEndAt, now) === null
        ? t("idleEndUnknown") : t("endedAgo", timeAgo(session.lastTurnEndAt, now, language));
    if (language === "en" && session.state === "waiting" && elapsedSince(session.lastTurnEndAt, now) !== null && (!session.lastPromptAt || Date.parse(session.lastTurnEndAt!) >= Date.parse(session.lastPromptAt))) return t("endedCard", t("waiting"), timeAgo(session.lastTurnEndAt, now, language));
    const at = session.state === "running" ? session.lastPromptAt : session.lastTurnEndAt ?? session.lastActivityAt ?? session.observedAt;
    const elapsed = elapsedSince(at, now);
    if (elapsed === null) return session.state === "running" ? t("runningDurationUnknown") : t("waitingDurationUnknown");
    if (elapsed < 60_000) return session.state === "running" ? t("justStartedRunning") : t("justStartedWaiting");
    return session.state === "running" ? `${t("runningPrefix")} ${elapsedLabel(elapsed, language)}` : t("waitingRow", elapsedLabel(elapsed, language));
}

/** Full status sentence for the card, using the same elapsed/relative time rules as rows. */
export function cardStatusLabel(session: SessionTime, duration: number | null, now = Date.now(), language: Language = "en"): string {
    const t = translator(language);
    if (session.state === "unknown") return t("checkingStatus");
    if (session.state === "running") {
        const elapsed = elapsedSince(session.lastPromptAt, now);
        if (elapsed === null) return sessionTimeLabel(session, now, language);
        const start = new Date(session.lastPromptAt!);
        const clock = `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`;
        return t("runningCard", elapsedLabel(elapsed, language), clock);
    }
    const ended = elapsedSince(session.lastTurnEndAt, now) !== null;
    // Waiting inside an open turn (e.g. an approval): the last end belongs to an earlier turn.
    const openTurn = !!session.lastPromptAt && (!session.lastTurnEndAt || Date.parse(session.lastPromptAt) > Date.parse(session.lastTurnEndAt));
    if (session.state === "waiting" && openTurn) {
        const waited = elapsedSince(session.lastPromptAt, now);
        return waited === null ? t("waitingInput") : t("waitingInputDuration", elapsedLabel(waited, language));
    }
    if (!ended) return sessionTimeLabel(session, now, language);
    return (session.state === "waiting" ? t("endedCard", t("waiting"), timeAgo(session.lastTurnEndAt, now, language)) : t("idleCard", timeAgo(session.lastTurnEndAt, now, language))) +
        (language === "zh" && duration !== null && duration > 0 ? t("turnDuration", elapsedLabel(duration, language)) : "");
}
