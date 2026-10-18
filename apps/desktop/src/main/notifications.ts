import { translator } from "../shared/i18n";
import { Notification } from "electron";
import { randomUUID } from "node:crypto";
import { isAttentionSession, isRegistryWaiting, notificationIdentity, notificationsEnabled, type CoreRequest, type NotificationKind, type PanelTarget, type Session, type Settings, type Workspace } from "@aimspan/protocol";

export interface SessionNotification { identity: string; title: string; body: string }
const time = (at?: string) => at && Number.isFinite(Date.parse(at)) ? Date.parse(at) : -Infinity;

/** Snapshots, not transcript versions, define events. Startup only establishes a baseline. */
export function shouldNotify(prev: Session | undefined, next: Session, settings: Settings, now: number): SessionNotification | null {
    if (!prev || prev.id !== next.id || prev.deviceId !== next.deviceId || prev.agent !== next.agent || prev.nativeId !== next.nativeId ||
        !isAttentionSession(next) || next.state === "unknown" || next.latestTurn?.aborted || next.unmatchedCompletion ||
        !notificationsEnabled(settings) || (settings.dndUntil ?? 0) > now) return null;
    const t = translator(settings.language);
    let body: string, kind: NotificationKind;
    if (isRegistryWaiting(next) && (!isRegistryWaiting(prev) || next.registryWaitingEntry !== prev.registryWaitingEntry)) { kind = "waiting"; body = t("notificationWaiting"); }
    else {
        const turn = next.latestTurn;
        if (!turn?.identity || !turn.endedAt || next.sourceUncertain || !next.hasNewResult ||
            turn.endedAt !== next.lastTurnEndAt || time(turn.endedAt) <= time(prev.lastTurnEndAt) || time(turn.endedAt) > now ||
            !Number.isFinite(turn.durationMs) || (turn.durationMs ?? 0) < 120_000) return null;
        kind = "completion"; body = t("notificationCompletion");
    }
    const identity = notificationIdentity(next, kind);
    if (!identity || identity === next.lastNotifiedIdentity) return null;
    if (next.pendingIdeaCount > 0) body += t("notificationIdeas", next.pendingIdeaCount);
    return { identity, title: next.title, body };
}

type Core = { snapshot(): Workspace | undefined; call(request: CoreRequest): Promise<unknown> };
export class SessionNotifications {
    private previous = new Map<string, Session>();
    private pending = new Set<string>();
    private visible = new Set<Notification>();
    private stopped = false;
    constructor(private readonly core: Core, private readonly openPanel: (target: PanelTarget) => void) {}

    async publish(workspace: Workspace): Promise<void> {
        const previous = this.previous;
        this.previous = new Map(workspace.sessions.map(s => [s.id, s]));
        if (this.stopped || !Notification.isSupported()) return;
        await Promise.all(workspace.sessions.map(async session => {
            const prev = previous.get(session.id);
            const candidate = shouldNotify(prev, session, workspace.settings, Date.now());
            if (!candidate) return;
            const key = JSON.stringify([session.id, candidate.identity]);
            if (this.pending.has(key)) return;
            this.pending.add(key);
            try {
                // Persist before the OS side effect. A crash here can omit an alert,
                // but can never cause the same identity to be displayed twice.
                const claimed = await this.core.call({ method: "notification.claim", sessionId: session.id,
                    identity: candidate.identity, expectedRevision: 0, operationId: randomUUID() });
                if (!claimed || this.stopped) return;
                const current = this.core.snapshot();
                const live = current?.sessions.find(s => s.id === session.id);
                if (!live || !current) return;
                // Settings and session state may have changed while the receipt was saved.
                const { lastNotifiedIdentity: _receipt, ...fresh } = live;
                const content = shouldNotify(prev, fresh, current.settings, Date.now());
                if (!content || content.identity !== candidate.identity) return;
                const notification = new Notification({ title: content.title, body: content.body });
                this.visible.add(notification);
                notification.on("click", () => { if (!this.stopped) this.openPanel({ kind: "session", sessionId: session.id }); });
                notification.on("close", () => this.visible.delete(notification));
                notification.on("failed", () => this.visible.delete(notification));
                notification.show();
            } catch (error) {
                console.error("Session notification:", error instanceof Error ? error.message : "failed");
            } finally { this.pending.delete(key); }
        }));
    }
    stop() { this.stopped = true; for (const notification of this.visible) notification.close(); this.visible.clear(); }
}
