import { translator, type Language } from "../shared/i18n";
import { NEW_SESSION_TARGETS, type CaptureSession } from "@aimspan/protocol";
import { sessionTitle } from "./session-title";

export type CaptureTarget = { id: string | null; nativeId?: string; title: string; project: string };
export const inboxTarget = (language: Language = "en"): CaptureTarget => ({ id: null, title: translator(language)("inbox"), project: "" });
export const newSessionTargets = (language: Language = "en"): CaptureTarget[] => [
    { id: NEW_SESSION_TARGETS.codex, title: translator(language)("newCodexTarget"), project: "" },
    { id: NEW_SESSION_TARGETS.claude, title: translator(language)("newClaudeTarget"), project: "" },
];
export function defaultCaptureTarget(sessions: readonly CaptureSession[], now = Date.now()): string | null {
    const recent = sessions.filter(session => {
        const at = Date.parse(session.lastPromptAt ?? "");
        return session.state === "running" && at <= now && now - at <= 30 * 60_000;
    });
    return recent.sort((a, b) => Date.parse(b.lastPromptAt!) - Date.parse(a.lastPromptAt!) || a.id.localeCompare(b.id))[0]?.id ?? null;
}
export function activeCaptureTargets(sessions: readonly CaptureSession[], language: Language = "en"): CaptureTarget[] {
    return [...sessions.filter(s => s.active && !s.archived).map(session => ({ id: session.id, nativeId: session.nativeId, title: sessionTitle(session, language), project: session.project })), inboxTarget(language), ...newSessionTargets(language)];
}
export function filterCaptureTargets(sessions: readonly CaptureSession[], query: string, language: Language = "en"): CaptureTarget[] {
    const needle = query.trim().toLocaleLowerCase();
    const targets = sessions.map(session => ({ target: { id: session.id, nativeId: session.nativeId, title: sessionTitle(session, language), project: session.project }, sourceTitle: session.title }));
    return [...targets, ...[inboxTarget(language), ...newSessionTargets(language)].map(target => ({ target, sourceTitle: target.title }))]
        .filter(({ target, sourceTitle }) => `${target.title}\n${sourceTitle}\n${target.project}`.toLocaleLowerCase().includes(needle)).map(({ target }) => target);
}
export function cycleCaptureTarget(targets: readonly CaptureTarget[], current: string | null, direction: 1 | -1): string | null {
    if (!targets.length) return current;
    const index = targets.findIndex(target => target.id === current);
    return targets[(index < 0 ? direction === 1 ? 0 : targets.length - 1 : (index + direction + targets.length) % targets.length)]!.id;
}
