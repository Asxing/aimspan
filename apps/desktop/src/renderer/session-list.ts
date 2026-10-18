import type { Session } from "@aimspan/protocol";
import { isAttentionSession, isInteractiveSession } from "@aimspan/protocol";

const timestamp = (at: string | undefined) => at && Number.isFinite(Date.parse(at)) ? Date.parse(at) : 0;
export function sortSessions(sessions: readonly Session[]): Session[] {
    const rank = (session: Session) => session.state === "waiting" ? 0 : session.state === "running" ? 1 : 2;
    return [...sessions].sort((a, b) => rank(a) - rank(b) || (a.state === "waiting" && b.state === "waiting"
        ? timestamp(a.lastTurnEndAt ?? a.lastActivityAt ?? a.observedAt) - timestamp(b.lastTurnEndAt ?? b.lastActivityAt ?? b.observedAt)
        : a.state === "running" && b.state === "running"
            ? timestamp(b.lastPromptAt ?? b.observedAt) - timestamp(a.lastPromptAt ?? a.observedAt)
            : timestamp(b.lastActivityAt ?? b.observedAt) - timestamp(a.lastActivityAt ?? a.observedAt)) || a.id.localeCompare(b.id));
}

/** Compact includes every pinned state, followed by waiting and running roots. */
export function compactSessions(sessions: readonly Session[]): Session[] {
    const rows = sortSessions(sessions.filter(s => isAttentionSession(s) && (s.pinned || s.state === "waiting" || s.state === "running")));
    return [...rows.filter(s => s.pinned), ...rows.filter(s => !s.pinned)];
}

/** Retain existing positions; new matches append and vanished matches leave immediately. */
export function freezeOrder(previous: readonly string[], next: readonly string[]): string[] {
    const incoming = new Set(next), known = new Set(previous);
    return [...previous.filter(id => incoming.has(id)), ...next.filter(id => !known.has(id))];
}

export interface SessionGroup { label: string; ids: string[] }
const groupLabels = ["today", "yesterday", "thisWeek", "earlier"];

/** Calendar boundaries use local midnight (including DST), with Monday starting the week. */
export function sessionGroup(session: Session, now: number): string {
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const monday = new Date(today); monday.setDate(today.getDate() - (today.getDay() + 6) % 7);
    const at = timestamp(session.lastActivityAt ?? session.observedAt);
    if (at >= today.getTime()) return "today";
    if (at >= yesterday.getTime()) return "yesterday";
    if (at >= monday.getTime()) return "thisWeek";
    return "earlier";
}

/** Input already has the state/time order; grouping preserves it within each bucket. */
export function groupSessions(sessions: readonly Session[], now: number): SessionGroup[] {
    const buckets = new Map(groupLabels.map(label => [label, [] as string[]]));
    for (const session of sessions) buckets.get(sessionGroup(session, now))!.push(session.id);
    return [...buckets].map(([label, ids]) => ({ label, ids })).filter(group => group.ids.length > 0);
}

/** Hold both membership and order while browsing; append arrivals to their own group. */
export function freezeGroups(previous: readonly SessionGroup[], next: readonly SessionGroup[]): SessionGroup[] {
    const incoming = new Set(next.flatMap(group => group.ids));
    const known = new Set(previous.flatMap(group => group.ids));
    return ["", ...groupLabels].map(label => ({ label, ids: [
        ...(previous.find(group => group.label === label)?.ids ?? []).filter(id => incoming.has(id)),
        ...(next.find(group => group.label === label)?.ids ?? []).filter(id => !known.has(id)),
    ] })).filter(group => group.ids.length > 0);
}

/** Collapse descendants before filtering/counting so an active child never hides its parent. */
export function sessionRows(sessions: Session[]): Session[] {
    const byNative = new Map(sessions.map(s => [`${s.deviceId}:${s.agent}:${s.nativeId}`, { ...s }]));
    const hidden = new Set<string>();
    for (const child of sessions) {
        if (!isInteractiveSession(child)) continue;
        let parentId = child.parentNativeId;
        const seen = new Set([child.nativeId]);
        for (let depth = 0; parentId && depth < 12 && !seen.has(parentId); depth++) {
            seen.add(parentId);
            const parent = byNative.get(`${child.deviceId}:${child.agent}:${parentId}`);
            if (!parent) break;
            hidden.add(child.id);
            if (isInteractiveSession(parent) && !parent.unmatchedCompletion && !parent.latestTurn?.aborted && !child.latestTurn?.aborted && !parent.archived && !child.archived && (child.state === "running" || child.state === "waiting") &&
                (child.state === "running" || child.registry?.live || !(parent.handledAt ?? parent.lastViewedAt) || Date.parse(child.lastTurnEndAt ?? child.observedAt) > Date.parse((parent.handledAt ?? parent.lastViewedAt)!)) &&
                !(Date.parse(parent.deactivatedAt ?? "") > Date.parse(parent.lastPromptAt ?? "0001-01-01"))) {
                parent.active = true;
                if (child.state === "running") parent.state = "running";
                else if (parent.state !== "running") parent.state = "waiting";
            }
            parentId = parent.parentNativeId;
        }
        if (parentId && seen.has(parentId)) for (const nativeId of seen) {
            const member = byNative.get(`${child.deviceId}:${child.agent}:${nativeId}`);
            if (member) hidden.delete(member.id);
        }
    }
    return [...byNative.values()].filter(s => !s.isChild && !hidden.has(s.id));
}
