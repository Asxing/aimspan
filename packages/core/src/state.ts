import type { RunState, Session, SessionFacts } from "@aimspan/protocol";
import { isInteractiveSession, isRegistryWaiting } from "@aimspan/protocol";
import { CLAUDE_REGISTRY_STATES } from "./claude.js";

export const time = (value?: string): number => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : -Infinity;
type Evidence = Partial<SessionFacts> & Pick<Session, "agent">;

export function hasNewResult(session: Evidence): boolean {
    return !session.baselinePending && !session.latestTurn?.aborted && time(session.lastTurnEndAt) > Math.max(time(session.lastPromptAt), time(session.lastViewedAt));
}

/** Registry waiting overrides an unfinished transcript while it awaits permission. */
export function deriveState(session: Evidence, now: string | number): RunState {
    const state = deriveObservedState(session, now);
    // An automation's completed/blocked turn does not wait for this user.
    return state === "waiting" && !isInteractiveSession(session) ? "idle" : state;
}

function deriveObservedState(session: Evidence, now: string | number): RunState {
    if (session.latestTurn?.aborted) return "idle";
    if (session.unmatchedCompletion) return "unknown";
    if (session.subagentRunning) return "running";
    const status = session.registry?.status ?? "";
    const registry = session.agent === "claude-code" && session.registry?.live && Object.hasOwn(CLAUDE_REGISTRY_STATES, status)
        ? CLAUDE_REGISTRY_STATES[status] : undefined;
    if (registry) return registry;
    if (session.baselinePending) return "unknown";
    const handled = Math.max(time(session.handledAt), time(session.lastPromptAt));
    const childWaiting = time(session.subagentWaitingAt) > handled;
    if (session.sourceUncertain) return childWaiting ? "waiting" : "unknown";
    const turn = session.latestTurn;
    const open = turn ? !turn.endedAt : time(session.lastPromptAt) > time(session.lastTurnEndAt);
    if (open) {
        if (turn?.factsThrough) return childWaiting ? "waiting" : "unknown";
        const changed = time(session.sourceChangedAt);
        return (typeof now === "number" ? now : time(now)) - changed >= 2 * 3600000 ? childWaiting ? "waiting" : "unknown" : "running";
    }
    if (time(session.lastTurnEndAt) > handled || childWaiting) return "waiting";
    if (time(session.lastTurnEndAt) > -Infinity && time(session.lastTurnEndAt) >= time(session.lastPromptAt)
        && handled >= time(session.lastTurnEndAt)) return "idle";
    return "unknown";
}

export function isActive(session: Evidence & { archived: boolean }, now: string | number, state = deriveState(session, now)): boolean {
    if (session.isChild || !isInteractiveSession(session) || session.archived || time(session.deactivatedAt) > time(session.lastPromptAt)) return false;
    const activity = Math.max(time(session.lastActivityAt), time(session.lastPromptAt), time(session.lastTurnEndAt), time(session.lastViewedAt));
    const elapsed = (typeof now === "number" ? now : time(now)) - activity;
    return state === "running" || state === "waiting" || !!session.pinned || elapsed >= 0 && elapsed < 12 * 3600000;
}

/** Parents and rows use one projection, including old separately persisted children. */
export function projectSessions(sessions: Session[], now: string): Session[] {
    const result = sessions.map(session => {
        const state = deriveState(session, now);
        return { ...session, interactive: isInteractiveSession(session), state, active: isActive(session, now, state), hasNewResult: hasNewResult(session), pendingIdeaCount: 0 };
    });
    const identities = new Map(result.map(s => [`${s.deviceId}:${s.agent}:${s.nativeId}`, s]));
    for (const child of result) {
        if (!child.interactive || child.archived || !["running", "waiting"].includes(child.state)) continue;
        let parentId = child.parentNativeId;
        const seen = new Set([child.nativeId]);
        for (let depth = 0; parentId && depth < 12 && !seen.has(parentId); depth++) {
            seen.add(parentId);
            const parent = identities.get(`${child.deviceId}:${child.agent}:${parentId}`);
            if (!parent || !parent.interactive || parent.archived || parent.latestTurn?.aborted || parent.unmatchedCompletion) break;
            if (child.state === "running") { parent.subagentRunning = true; parent.state = "running"; }
            else if (parent.state !== "running" && (isRegistryWaiting(child) || !parent.baselinePending && time(child.lastTurnEndAt ?? child.observedAt) > Math.max(time(parent.handledAt), time(parent.lastPromptAt)))) parent.state = "waiting";
            parent.active = isActive(parent, now, parent.state);
            parentId = parent.parentNativeId;
        }
    }
    return result;
}
