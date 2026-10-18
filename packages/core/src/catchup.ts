import type { CatchUp, Idea, Session } from "@aimspan/protocol";
import { MAX_AGENT_MESSAGE_CHARS, type SourceTurn } from "./source.js";
import { time } from "./state.js";
import { mergeActivity } from "./activity.js";

/** Read-only projection; the caller supplies the same derived state as Workspace. */
export function projectCatchUp(session: Session, turns: readonly SourceTurn[], ideas: readonly Idea[], now: string): CatchUp {
    const anchor = [session.lastPromptAt, session.lastViewedAt]
        .filter((value): value is string => time(value) > -Infinity)
        .sort((a, b) => time(a) - time(b)).at(-1) ?? null;
    const ordered = [...turns].sort((a, b) => time(a.promptAt) - time(b.promptAt));
    const current = ordered.at(-1);
    const ended = ordered.filter(turn => time(turn.endedAt) > -Infinity)
        .sort((a, b) => time(a.endedAt) - time(b.endedAt));
    const window = anchor === null ? current?.endedAt ? [current] : [] : ended.filter(turn => time(turn.endedAt) > time(anchor));
    const lastEnded = window.at(-1) ?? ended.at(-1);
    const reply = session.previousCompletion && time(session.previousCompletion.endedAt) > time(lastEnded?.endedAt) ? session.previousCompletion : lastEnded;
    const body = reply?.lastAgentMessage;
    const files = new Set<string>();
    for (const turn of window) for (const file of turn.changedFiles) {
        files.delete(file);
        files.add(file);
    }
    const awaySummary = window.filter(turn => turn.awaySummary !== undefined).at(-1)?.awaySummary;
    const duration = session.state === "running" && time(session.lastPromptAt) > time(current?.promptAt) ? time(now) - time(session.lastPromptAt) : current ? current.endedAt
        ? current.durationMs ?? time(current.endedAt) - time(current.promptAt)
        : time(now) - time(current.promptAt) : null;
    return {
        activity: mergeActivity([], session.activity).slice(0, 5), activityIncomplete: session.activityIncomplete,
        anchor, state: session.state,
        durationMsOfCurrentOrLastTurn: duration === null || !Number.isFinite(duration) ? null : Math.max(0, duration),
        turnsSinceAnchor: window.length,
        pendingIdeas: ideas.filter(idea => idea.sessionId === session.id && idea.status === "pending"),
        ...(awaySummary !== undefined ? { awaySummary } : {}),
        ...(body !== undefined ? { lastAgentMessage: { body: body.slice(0, MAX_AGENT_MESSAGE_CHARS), fromBeforeAnchor: window.length === 0 || reply === session.previousCompletion } } : {}),
        // Old capped rows predate truncation metadata; conservatively flag the cap.
        truncated: body !== undefined && (body.length > MAX_AGENT_MESSAGE_CHARS || (reply?.lastAgentMessageTruncated ?? body.length >= MAX_AGENT_MESSAGE_CHARS)),
        factsIncomplete: window.some(turn => turn.factsThrough !== undefined && time(turn.factsThrough) < time(turn.endedAt)),
        errors: window.flatMap(turn => turn.aborted && !turn.errors.some(error => error === "interrupted" || error === "aborted" || error.startsWith("aborted:"))
            ? [...turn.errors, "aborted"] : turn.errors),
        changedFiles: [...files],
        failedCommands: window.flatMap(turn => turn.failedCommands),
    };
}
