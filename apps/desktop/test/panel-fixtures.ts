import { DEFAULT_SETTINGS, type Idea, type Session, type Workspace } from "@aimspan/protocol";
export function session(id = "a", patch: Partial<Session> = {}): Session {
    return { surface: "unknown", activity: [], activityIncomplete: false, id, revision: 1, updatedAt: "2026-10-16T08:00:00Z", deviceId: "fixture", agent: "codex", nativeId: id, title: `会话 ${id}`,
        project: "/__aimspan_fixture__/project", state: "waiting", observedAt: "2026-10-16T08:00:00Z", lastActivityAt: "2026-10-16T08:00:00Z",
        confidence: "explicit", sourceVersion: "1", references: [], archived: false, active: true, hasNewResult: true, pinned: false,
        subagentRunning: false, pendingIdeaCount: 0, interactive: true, ...patch };
}
export function idea(id = "idea-a", body = "  第一条\n继续  ", patch: Partial<Idea> = {}): Idea {
    return { id, body, sessionId: "a", revision: 1, status: "pending", createdAt: "2026-10-16T08:00:00Z", updatedAt: "2026-10-16T08:00:00Z", ...patch };
}
export function workspace(sessions = [session()], ideas = [idea()]): Workspace {
    return { sessions, ideas, inboxIdeaCount: 0, drafts: {}, settings: { ...DEFAULT_SETTINGS }, seq: 1, deviceId: "fixture", diagnostics: [] };
}
