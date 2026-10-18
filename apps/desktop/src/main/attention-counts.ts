import { isAttentionSession, type Session } from "@aimspan/protocol";

/** One count contract for the tray and bubble. */
export function attentionCounts(sessions: readonly Session[]) {
    let running = 0, waiting = 0;
    for (const session of sessions) {
        if (!isAttentionSession(session)) continue;
        if (session.state === "running") running++;
        if (session.state === "waiting") waiting++;
    }
    return { running, waiting };
}
