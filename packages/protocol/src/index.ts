export type Agent = "codex" | "claude-code";
export type NewSessionApp = "codex" | "claude";
export const NEW_SESSION_TARGETS = { codex: "new-session:codex", claude: "new-session:claude" } as const;
export function newSessionApp(target: string | null): NewSessionApp | undefined {
    return target === NEW_SESSION_TARGETS.codex ? "codex" : target === NEW_SESSION_TARGETS.claude ? "claude" : undefined;
}
export type SessionSurface = "desktop" | "cli" | "vscode" | "automation" | "unknown";
export const CLAUDE_SURFACES = {
    "claude-desktop": "desktop", cli: "cli", "claude-vscode": "vscode",
    "sdk-cli": "automation", "sdk-ts": "automation", "sdk-py": "automation",
} as const satisfies Record<string, SessionSurface>;
export const CODEX_SURFACES = {
    "Codex Desktop": "desktop", codex_cli_rs: "cli", "codex-tui": "cli",
    codex_vscode: "vscode", vscode_agent_host: "vscode", codex_exec: "automation",
    codex_work_desktop: "desktop",
} as const satisfies Record<string, SessionSurface>;
/** Third-party clients driving Codex: shown by name instead of a generic surface. */
export const CODEX_CLIENT_IDS = ["openclaw", "aimspan", "codex-chrome-extension-sidepanel"] as const;
type SurfaceSource = { agent: Agent; entrypoint?: string | undefined; originator?: string | undefined };
export function sessionSurface(session: SurfaceSource): SessionSurface {
    const identifier = session.agent === "codex" ? session.originator ?? session.entrypoint : session.entrypoint;
    const mapping: Readonly<Record<string, SessionSurface>> = session.agent === "codex" ? CODEX_SURFACES : CLAUDE_SURFACES;
    return identifier && Object.hasOwn(mapping, identifier) ? mapping[identifier]! : "unknown";
}
export const NON_INTERACTIVE_IDENTIFIERS: Readonly<Record<Agent, readonly string[]>> = {
    codex: Object.keys(CODEX_SURFACES).filter(key => sessionSurface({ agent: "codex", originator: key }) === "automation"),
    "claude-code": Object.keys(CLAUDE_SURFACES).filter(key => sessionSurface({ agent: "claude-code", entrypoint: key }) === "automation"),
};
export function isInteractiveSession(session: SurfaceSource & { interactive?: boolean; surface?: SessionSurface }): boolean {
    return session.interactive !== false && session.surface !== "automation" && sessionSurface(session) !== "automation";
}
export type RunState = "running" | "waiting" | "idle" | "unknown";
/** Shared with notifications. Only busy/idle are observed; waiting values are from the CLI binary. */
export const CLAUDE_REGISTRY_STATES: Readonly<Record<string, "running" | "waiting" | undefined>> = {
    busy: "running",
    waiting: "waiting", needs_user: "waiting", requires_action: "waiting", blocked: "waiting",
    idle: undefined, paused: undefined, needs_trust: undefined,
};
export interface TurnCompletion {
    endedAt: string;
    lastAgentMessage?: string;
    lastAgentMessageTruncated?: boolean;
}
export interface SessionFacts {
    lastPromptAt?: string | undefined;
    lastTurnEndAt?: string | undefined;
    lastViewedAt?: string | undefined;
    handledAt?: string | undefined;
    /** Initial history has not yet been read with certain lifecycle evidence. */
    baselinePending?: boolean | undefined;
    lastActivityAt?: string | undefined;
    sourceChangedAt?: string | undefined;
    evidenceAt?: string | undefined;
    subagentWaitingAt?: string | undefined;
    deactivatedAt?: string | undefined;
    entrypoint?: string | undefined;
    registry?: { live: boolean; status?: string | undefined; statusUpdatedAt?: string | undefined } | undefined;
    /** Monotonic registry waiting entry, retained through resume and restart. */
    registryWaitingEntry?: number;
    latestTurn?: { identity?: string | undefined; promptAt: string; endedAt?: string | undefined; durationMs?: number | undefined; aborted?: boolean | undefined; factsThrough?: string | undefined } | undefined;
    sourceUncertain?: boolean | undefined;
    /** A completion whose prompt is unavailable or cannot be safely correlated. */
    unmatchedCompletion?: TurnCompletion | undefined;
    /** A known reply before a later prompt; its own prompt may be outside the read budget. */
    previousCompletion?: TurnCompletion | undefined;
    sourceArchived?: boolean | undefined;
    manualArchived?: boolean | undefined;
    subagentRunning: boolean;
    /** Internal native thread, including one whose parent is not observed. */
    isChild?: boolean;
    pinned: boolean;
    interactive: boolean;
}
export interface Versioned {
    id: string;
    revision: number;
    updatedAt: string;
}
export interface SourceRef {
    id: string;
    kind: "user" | "agent";
    time: string;
    excerpt: string;
}
export interface Session extends Versioned, SessionFacts {
    surface: SessionSurface;
    /** Newest first, bounded to 20 entries. */
    activity: ActivityEntry[];
    activityIncomplete: boolean;
    deviceId: string;
    agent: Agent;
    nativeId: string;
    title: string;
    project: string;
    parentNativeId?: string;
    state: RunState;
    observedAt: string;
    confidence: "explicit" | "inferred" | "unknown";
    sourceVersion: string;
    references: SourceRef[];
    archived: boolean;
    active: boolean;
    hasNewResult: boolean;
    pendingIdeaCount: number;
    lastNotifiedIdentity?: string;
}
/** Registry evidence is independent of unread results and folded child state. */
export function isRegistryWaiting(session: Pick<Session, "agent" | "registry">): boolean {
    return session.agent === "claude-code" && session.registry?.live === true &&
        Object.hasOwn(CLAUDE_REGISTRY_STATES, session.registry.status ?? "") && CLAUDE_REGISTRY_STATES[session.registry.status ?? ""] === "waiting";
}
export type NotificationKind = "waiting" | "completion";
/** Waiting entries may precede transcripts; completions use only the stable turn row. */
export function notificationIdentity(session: Session, kind: NotificationKind): string | undefined {
    if (kind === "waiting") return isRegistryWaiting(session) && Number.isSafeInteger(session.registryWaitingEntry) && (session.registryWaitingEntry ?? 0) > 0
        ? `waiting:${session.registryWaitingEntry}` : undefined;
    return session.latestTurn?.identity && session.latestTurn.endedAt ? `completion:${session.latestTurn.identity}` : undefined;
}
/** The same gate is used for active rows and tray/notification counts. */
export function isActiveSession(session: Session): boolean {
    return !session.isChild && isInteractiveSession(session) && session.active && !session.archived;
}
/** Shared by the tray and bubble, including their waiting/running counts. */
export function isAttentionSession(session: Session): boolean {
    return !session.parentNativeId && isActiveSession(session);
}
/** Ideas may move only to sessions with their own interactive root row. */
export function isIdeaTargetSession(session: Session): boolean {
    return !session.isChild && !session.parentNativeId && isInteractiveSession(session);
}
export type IdeaStatus = "pending" | "brought" | "discarded";
export interface Idea extends Versioned {
    sessionId: string | null;
    body: string;
    status: IdeaStatus;
    createdAt: string;
    broughtAt?: string;
    discardedAt?: string;
}
export interface CatchUp {
    /** Newest five entries, independent of the view anchor. */
    activity: ActivityEntry[];
    activityIncomplete: boolean;
    anchor: string | null;
    state: RunState;
    durationMsOfCurrentOrLastTurn: number | null;
    turnsSinceAnchor: number;
    pendingIdeas: Idea[];
    awaySummary?: string;
    lastAgentMessage?: { body: string; fromBeforeAnchor: boolean };
    truncated: boolean;
    /** At least one ended turn in the window has a gap before its end. */
    factsIncomplete: boolean;
    errors: string[];
    changedFiles: string[];
    failedCommands: string[];
}
export interface ActivityEntry {
    at: string;
    kind: "message" | "command" | "file" | "error";
    text: string;
    failed?: boolean;
}
/** Preserve selection order and user text; clipboard output has no preamble. */
export function formatBringBack(ideas: readonly Pick<Idea, "body">[]): string {
    if (ideas.length === 1) return ideas[0]!.body;
    return ideas.map((idea, index) => `${index + 1}. ${idea.body.replace(/\r\n|\r|\n/g, newline => `${newline}   `)}`).join("\n");
}
export interface Draft {
    target: string;
    /** Present only for a capture draft scoped to a destination. */
    sessionId?: string | null;
    body: string;
    revision: number;
    updatedAt: string;
}
export interface Settings {
    observeAll?: boolean;
    roots: string[];
    notifications: boolean;
    notificationsExplicit?: boolean;
    pinned: boolean;
    language: "zh" | "en";
    captureShortcut?: string;
    bubbleShortcut?: string;
    bubbleEnabled?: boolean;
    bubblePosition?: BubblePosition;
    bubbleHiddenUntil?: number;
    dndUntil?: number;
    lastNewSessionApp?: NewSessionApp;
}
export function notificationsEnabled(settings: Settings): boolean {
    return settings.notificationsExplicit ? settings.notifications : settings.bubbleEnabled === false;
}
/** Coordinates describe the full 44px circle, including its intentionally hidden half. */
export interface BubblePosition { x: number; y: number; side: "left" | "right" | "free" }
export type DiagnosticCode = "claude.source.uncertain" | "claude.source.limit" | "claude.source.unreadable" | "claude.registry.limit" | "claude.registry.uncertain" | "claude.registry.unreadable" | "discovery.read" | "watch-fallback" | "codex-stale" | "codex-read" | "codex-partial" | "codex-index" | "codex-index-partial" | "codex-directory" | "codex-decompressed-limit" | "codex-limit" | "codex-budget" | "codex-discovery";
export interface SourceDiagnostic { code: DiagnosticCode; path?: string }
export interface Workspace {
    sessions: Session[];
    ideas: Idea[];
    inboxIdeaCount: number;
    drafts: Record<string, Draft>;
    settings: Settings;
    seq: number;
    deviceId: string;
    diagnostics: SourceDiagnostic[];
    captureShortcutError?: string;
    bubbleShortcutError?: string;
    legacyImport?: { databases: number; sessions: number; ideas: number };
}
export const DEFAULT_SETTINGS: Settings = { roots: [], observeAll: true, notifications: false, notificationsExplicit: false, pinned: false, language: "en", captureShortcut: "CommandOrControl+Shift+Space", bubbleShortcut: "", bubbleEnabled: true, lastNewSessionApp: "codex" };
export type CoreRequest = {
    method: "workspace";
} | {
    method: "catchup";
    sessionId: string;
} | {
    method: "idea.save";
    id?: string;
    sessionId: string | null;
    body: string;
    expectedRevision: number;
    operationId: string;
} | {
    method: "idea.move";
    id: string;
    sessionId: string | null;
    expectedRevision: number;
    operationId: string;
} | {
    method: "idea.setStatus";
    id: string;
    status: IdeaStatus;
    expectedRevision: number;
    operationId: string;
} | {
    method: "idea.purge";
    id: string;
    expectedRevision: number;
    operationId: string;
} | {
    method: "draft.save";
    target: string;
    body: string;
    expectedRevision: number;
    operationId: string;
} | {
    /** Only Main may supply a path, after the native save dialog. */
    method: "legacy.export";
    path: string;
    operationId: string;
} | {
    method: "session.archive";
    sessionId: string;
    archived: boolean;
    operationId: string;
} | {
    method: "session.viewed" | "session.handled" | "session.pin" | "session.unpin" | "session.deactivate";
    sessionId: string;
    at?: string;
    expectedRevision: number;
    operationId: string;
} | {
    method: "settings.save";
    settings: Settings;
} | {
    /** Main reserves a durable notification receipt before displaying it. */
    method: "notification.claim";
    sessionId: string;
    identity: string;
    expectedRevision: number;
    operationId: string;
} | {
    method: "scan";
};
export type RendererRequest = Exclude<CoreRequest, { method: "legacy.export" | "notification.claim" }>;
export interface BringBackRequest {
    sessionId: string;
    ideas: { id: string; revision: number }[];
    operationId: string;
}
/** Catalog keys are narrowed by desktop; protocol owns only the serializable transport. */
export interface MessageRef<Key extends string = string> {
    key: Key;
    params?: Array<string | number | MessageRef<Key>>;
}
export interface MessageResult {
    message: string;
    messageRef?: MessageRef;
}
export interface BringBackResult extends MessageResult {
    brought: number;
    undoToken?: string;
    undoExpiresAt?: number;
}
export interface CaptureNewSessionRequest {
    kind: "capture";
    app: NewSessionApp;
    body: string;
    expectedRevision: 0;
    operationId: string;
}
export interface InboxNewSessionRequest {
    kind: "inbox";
    app: NewSessionApp;
    idea: { id: string; revision: number };
    operationId: string;
}
export type NewSessionRequest = CaptureNewSessionRequest | InboxNewSessionRequest;
export function validNewSessionRequest(value: unknown): value is NewSessionRequest {
    return object(value) && (value.app === "codex" || value.app === "claude") && text(value.operationId, 160) && !!value.operationId &&
        (value.kind === "capture" ? validIdeaBody(value.body) && !!value.body.trim() && value.expectedRevision === 0 :
            value.kind === "inbox" && object(value.idea) && text(value.idea.id, 160) && !!value.idea.id &&
            Number.isSafeInteger(value.idea.revision) && Number(value.idea.revision) > 0);
}
/** Exposed only by the sandboxed panel preload. No paths, clipboard writes or arbitrary IPC. */
export interface PanelApi {
    hide(): Promise<void>;
    call(request: RendererRequest): Promise<unknown>;
    onFlushDrafts(callback: () => void): () => void;
    subscribe(callback: (workspace: Workspace) => void): () => void;
    onOpen(callback: (target: PanelTarget) => void): () => void;
    reveal(sessionId: string): Promise<MessageResult>;
    chooseRoot(): Promise<void>;
    exportLegacy(operationId: string): Promise<unknown>;
    openLink(url: string): Promise<void>;
    bringBack(request: BringBackRequest): Promise<BringBackResult>;
    newSession(request: InboxNewSessionRequest): Promise<BringBackResult>;
    undoBringBack(token: string): Promise<void>;
}
export type PanelTarget = { kind: "session"; sessionId: string } | { kind: "settings" };
export interface BubbleState {
    language: Settings["language"];
    waiting: number;
    running: number;
    pulse: number;
    side: BubblePosition["side"];
    circleX: number;
    revealed: boolean;
    open: boolean;
    pinned: boolean;
}
export type CompactSession = Pick<Session, "id" | "nativeId" | "title" | "agent" | "surface" | "entrypoint" | "interactive" | "pinned" | "revision" | "state" | "lastPromptAt" | "lastTurnEndAt" | "lastActivityAt" | "observedAt" | "pendingIdeaCount" | "hasNewResult">;
export interface CompactState { language: Settings["language"]; sessions: CompactSession[]; pinned: boolean }
export interface CompactMutation { sessionId: string; expectedRevision: number; operationId: string }
export interface BubbleApi {
    getState(): Promise<BubbleState>;
    subscribe(callback: (state: BubbleState) => void): () => void;
    hover(inside: boolean): Promise<void>;
    pointer(phase: "down" | "move" | "up" | "cancel", point: { x: number; y: number; buttons?: number }): Promise<void>;
    toggle(): Promise<void>;
    menu(): Promise<void>;
}
export interface CompactApi {
    getState(): Promise<CompactState>;
    subscribe(callback: (state: CompactState) => void): () => void;
    hover(inside: boolean): Promise<void>;
    openSession(sessionId: string): Promise<void>;
    capture(sessionId: string | null): Promise<void>;
    newSession(): Promise<void>;
    pinSession(request: CompactMutation & { pinned: boolean }): Promise<void>;
    handleSession(request: CompactMutation): Promise<void>;
    togglePinned(): Promise<void>;
    close(): Promise<void>;
}
export type DesktopApi = PanelApi;
export type CaptureSession = Pick<Session, "id" | "nativeId" | "agent" | "title" | "project" | "state" | "lastPromptAt" | "lastTurnEndAt" | "lastActivityAt" | "observedAt" | "pendingIdeaCount" | "hasNewResult" | "active" | "archived">;
export interface CaptureContext {
    language: Settings["language"];
    openId: number;
    preselectedTarget?: string | null;
    sessions: CaptureSession[];
    inboxIdeaCount: number;
    drafts: Record<string, Draft>;
}
/** Stable error code Main uses when a save comes from a superseded capture open. */
export const CAPTURE_STALE_OPEN = "CAPTURE_STALE_OPEN";
export type CaptureIdeaRequest = Omit<Extract<CoreRequest, { method: "idea.save" }>, "method" | "id">;
export interface CaptureDraftInput { body: string; operationId: string }
/** Capture has no general Core, filesystem, navigation or panel authority. */
export interface CaptureApi {
    getContext(): Promise<CaptureContext>;
    onLanguage(callback: (language: Settings["language"]) => void): () => void;
    /** `openId` must be the open the page is showing; Main rejects saves from a superseded open. */
    saveIdea(request: CaptureIdeaRequest, openId: number): Promise<Idea>;
    newSession(request: CaptureNewSessionRequest, openId: number): Promise<BringBackResult>;
    saveDraft(request: CaptureDraftInput): Promise<void>;
    close(openId: number): Promise<void>;
}
export const CAPTURE_DRAFT_KEY = "capture:shared";
/** Legacy per-target key format; new writes use CAPTURE_DRAFT_KEY. */
export function captureDraftKey(sessionId: string | null): string { return `capture:${JSON.stringify(sessionId)}`; }
export function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
export function text(value: unknown, limit = 12000): value is string { return typeof value === "string" && value.length <= limit && !value.includes("\0"); }
export function validSettings(v: unknown): v is Settings {
    return object(v) && (v.observeAll === undefined || typeof v.observeAll === "boolean") && Array.isArray(v.roots) && v.roots.length <= 30 && v.roots.every(r => text(r, 1024)) && typeof v.notifications === "boolean" && typeof v.pinned === "boolean" && ["zh", "en"].includes(String(v.language)) &&
        (v.bubbleEnabled === undefined || typeof v.bubbleEnabled === "boolean") &&
        (v.notificationsExplicit === undefined || typeof v.notificationsExplicit === "boolean") &&
        (v.lastNewSessionApp === undefined || v.lastNewSessionApp === "codex" || v.lastNewSessionApp === "claude") &&
        [v.captureShortcut, v.bubbleShortcut].every(shortcut => shortcut === undefined || text(shortcut, 160)) &&
        [v.bubbleHiddenUntil, v.dndUntil].every(time => time === undefined || typeof time === "number" && Number.isSafeInteger(time) && time >= 0) &&
        (v.bubblePosition === undefined || object(v.bubblePosition) && ["left", "right", "free"].includes(String(v.bubblePosition.side)) &&
            [v.bubblePosition.x, v.bubblePosition.y].every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1_000_000));
}
export function validRequest(v: unknown): v is CoreRequest {
    if (!object(v) || !text(v.method, 60))
        return false;
    const id = (k: string) => text(v[k], 160) && String(v[k]).length > 0;
    const rev = () => Number.isSafeInteger(v.expectedRevision) && Number(v.expectedRevision) >= 0;
    const op = () => id("operationId");
    switch (v.method) {
        case "workspace":
        case "scan": return true;
        case "catchup": return id("sessionId");
        case "notification.claim": return id("sessionId") && id("identity") && rev() && op();
        case "idea.save": return (v.sessionId === null || id("sessionId")) && validIdeaBody(v.body) && rev() && op() && (v.id === undefined || id("id"));
        case "idea.move": return id("id") && (v.sessionId === null || id("sessionId")) && rev() && op();
        case "idea.setStatus": return id("id") && (v.status === "pending" || v.status === "brought" || v.status === "discarded") && rev() && op();
        case "idea.purge": return id("id") && rev() && op();
        case "draft.save": return id("target") && validIdeaBody(v.body) && rev() && op() && v.sessionId === undefined;
        case "legacy.export": return text(v.path, 4096) && v.path.startsWith("/") && op();
        case "session.archive": return id("sessionId") && typeof v.archived === "boolean" && op();
        case "session.viewed":
        case "session.handled":
        case "session.pin":
        case "session.unpin":
        case "session.deactivate": return id("sessionId") && rev() && op() && (v.at === undefined || (v.method === "session.viewed" || v.method === "session.handled") && text(v.at, 40) && Number.isFinite(Date.parse(v.at)));
        case "settings.save": return validSettings(v.settings);
        default: return false;
    }
}

/** Limit Unicode code points, so one emoji consumes one character, not two. */
export function validIdeaBody(value: unknown): value is string {
    return typeof value === "string" && value.length <= 8000 && Array.from(value).length <= 4000;
}
export function validRendererRequest(value: unknown): value is RendererRequest {
    return validRequest(value) && value.method !== "legacy.export" && value.method !== "notification.claim";
}
