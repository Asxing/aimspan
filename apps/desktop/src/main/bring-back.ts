import { messageRef, messageResult, type CatalogMessage, type MessageRef } from "../shared/i18n/messages";
import { translator, type Language } from "../shared/i18n";
import { createHash, randomUUID } from "node:crypto";
import { formatBringBack, object, text, validNewSessionRequest, type NewSessionApp, type NewSessionRequest, type BringBackRequest, type BringBackResult, type CoreRequest, type Idea, type Session, type Workspace } from "@aimspan/protocol";

export function allowedLink(value: unknown): value is string {
    if (!text(value, 8192)) return false;
    try { return ["http:", "https:", "codex:", "claude:"].includes(new URL(value).protocol); }
    catch { return false; }
}

export async function openSession(session: Session, shell: { openExternal(url: string): Promise<unknown>; openPath(path: string): Promise<string> }, language: Language = "en"): Promise<CatalogMessage> {
    if (session.agent === "claude-code") {
        const hint = messageRef("claudeSessionHint", session.title, session.project);
        try {
            const error = await shell.openPath("/Applications/Claude.app");
            return messageResult(language, error ? messageRef("claudeOpenFailed", hint) : hint);
        } catch { return messageResult(language, messageRef("claudeOpenFailed", hint)); }
    }
    try {
        await shell.openExternal(`codex://threads/${encodeURIComponent(session.nativeId)}`);
        return messageResult(language, messageRef("codexOpened"));
    } catch { return messageResult(language, messageRef("codexOpenFailed")); }
}

function validSelection(value: unknown): value is BringBackRequest {
    return object(value) && text(value.sessionId, 160) && !!value.sessionId && text(value.operationId, 160) && !!value.operationId &&
        Array.isArray(value.ideas) && value.ideas.length > 0 && value.ideas.length <= 1000 && value.ideas.every(idea =>
            object(idea) && text(idea.id, 160) && !!idea.id && Number.isSafeInteger(idea.revision) && Number(idea.revision) > 0) &&
        new Set(value.ideas.map(idea => idea.id)).size === value.ideas.length;
}

/** Main owns all clipboard/native effects. Core owns every status change and revision check. */
export class BringBack {
    private readonly t = translator(() => this.deps.language?.() ?? "en");
    private operations = new Map<string, { fingerprint: string; result: Promise<BringBackResult> }>();
    private undos = new Map<string, { ideas: Idea[]; expiresAt: number; running: boolean }>();
    constructor(private readonly deps: {
        call(request: CoreRequest): Promise<unknown>;
        writeText(text: string): void | Promise<void>;
        open(session: Session): Promise<CatalogMessage>;
        openNewSession?(app: NewSessionApp): Promise<CatalogMessage>;
        now?: () => number;
        language?: () => Language;
    }) {}
    private now() { return this.deps.now?.() ?? Date.now(); }

    /** Shared capture/panel entry: resolve or save an inbox idea, copy, mark, remember app, open. */
    newSession(request: unknown): Promise<BringBackResult> {
        if (!validNewSessionRequest(request)) return Promise.reject(new Error(this.t("invalidNewSession")));
        const fingerprint = JSON.stringify(["new-session", request.app, request.kind,
            request.kind === "capture" ? request.body : [request.idea.id, request.idea.revision]]);
        const previous = this.operations.get(request.operationId);
        if (previous) return previous.fingerprint === fingerprint ? previous.result : Promise.reject(new Error(this.t("operationReused")));
        if (this.operations.size >= 4096) return Promise.reject(new Error(this.t("bringBackLimit")));
        const result = this.runNewSession(request);
        this.operations.set(request.operationId, { fingerprint, result });
        // A failed attempt (e.g. a transient clipboard error before the idea is marked) must be
        // retryable with the same operation ID; the Core steps it replays are idempotent.
        result.catch(() => { if (this.operations.get(request.operationId)?.result === result) this.operations.delete(request.operationId); });
        return result;
    }

    private async runNewSession(request: NewSessionRequest): Promise<BringBackResult> {
        if (!this.deps.openNewSession) throw new Error(this.t("newSessionUnavailable"));
        const key = createHash("sha256").update(request.operationId).digest("hex");
        const workspace = await this.deps.call({ method: "workspace" }) as Workspace;
        const idea = request.kind === "capture" ? await this.deps.call({ method: "idea.save", sessionId: null,
            body: request.body, expectedRevision: 0, operationId: `${key}:new:save` }) as Idea : workspace.ideas.find(i => i.id === request.idea.id);
        if (!idea || idea.sessionId !== null || idea.status !== "pending" || (request.kind === "inbox" && idea.revision !== request.idea.revision))
            throw new Error(this.t("inboxIdeaChanged"));
        // Persist the choice before native effects; clipboard failure leaves the saved idea pending.
        const current = await this.deps.call({ method: "workspace" }) as Workspace;
        await this.deps.call({ method: "settings.save", settings: { ...current.settings, lastNewSessionApp: request.app } });
        await this.deps.writeText(idea.body);
        const brought = await this.deps.call({ method: "idea.setStatus", id: idea.id, status: "brought",
            expectedRevision: idea.revision, operationId: `${key}:new:bring` }) as Idea;
        // The text is already copied and the idea marked; failing to open the app is not a failed handoff.
        let ref: MessageRef;
        try { ref = (await this.deps.openNewSession(request.app)).messageRef; }
        catch { ref = messageRef("copiedOpenFailed", messageRef(request.app === "codex" ? "codex" : "claude")); }
        return this.withUndo(ref, [brought]);
    }

    bringBack(request: unknown): Promise<BringBackResult> {
        if (!validSelection(request)) return Promise.reject(new Error(this.t("invalidIdeaSelection")));
        const fingerprint = JSON.stringify([request.sessionId, request.ideas.map(idea => [idea.id, idea.revision])]);
        const previous = this.operations.get(request.operationId);
        if (previous) return previous.fingerprint === fingerprint ? previous.result : Promise.reject(new Error(this.t("operationReused")));
        // Never evict receipts: a delayed replay must not repeat a clipboard/native effect.
        if (this.operations.size >= 4096) return Promise.reject(new Error(this.t("bringBackLimit")));
        const result = this.run(request);
        this.operations.set(request.operationId, { fingerprint, result });
        return result;
    }

    private async run(request: BringBackRequest): Promise<BringBackResult> {
        const workspace = await this.deps.call({ method: "workspace" }) as Workspace;
        const session = workspace.sessions.find(s => s.id === request.sessionId);
        if (!session) throw new Error(this.t("sessionUnavailableRefresh"));
        const ideas = request.ideas.map(selected => {
            const idea = workspace.ideas.find(i => i.id === selected.id);
            if (!idea || idea.sessionId !== session.id || idea.status !== "pending" || idea.revision !== selected.revision)
                throw new Error(this.t("ideaChanged"));
            return idea;
        });
        await this.deps.writeText(formatBringBack(ideas));
        const brought: Idea[] = [];
        const operationKey = createHash("sha256").update(request.operationId).digest("hex");
        let ref: MessageRef;
        try {
            for (const [index, idea] of ideas.entries()) {
                brought.push(await this.deps.call({ method: "idea.setStatus", id: idea.id, status: "brought", expectedRevision: idea.revision,
                    operationId: `${operationKey}:bring:${index}` }) as Idea);
            }
            ref = messageRef("ideasCopied", ideas.length, (await this.deps.open(session)).messageRef);
        } catch {
            ref = messageRef("ideasPartiallyBrought", ideas.length, brought.length);
        }
        if (!brought.length) return { ...messageResult(this.deps.language?.() ?? "en", ref), brought: 0 };
        return this.withUndo(ref, brought);
    }

    private withUndo(ref: MessageRef, brought: Idea[]): BringBackResult {
        for (const [token, undo] of this.undos) if (undo.expiresAt < this.now() && !undo.running) this.undos.delete(token);
        const undoToken = randomUUID(), undoExpiresAt = this.now() + 5000;
        this.undos.set(undoToken, { ideas: brought, expiresAt: undoExpiresAt, running: false });
        return { ...messageResult(this.deps.language?.() ?? "en", ref), brought: brought.length, undoToken, undoExpiresAt };
    }

    async undo(token: unknown): Promise<void> {
        const undo = typeof token === "string" ? this.undos.get(token) : undefined;
        if (!undo || undo.expiresAt < this.now()) throw new Error(this.t("undoExpired"));
        if (undo.running) return;
        undo.running = true;
        try {
            for (const idea of [...undo.ideas]) {
                await this.deps.call({ method: "idea.setStatus", id: idea.id, status: "pending", expectedRevision: idea.revision,
                    operationId: `${token}:undo:${createHash("sha256").update(idea.id).digest("hex")}` });
                undo.ideas = undo.ideas.filter(i => i.id !== idea.id);
            }
            this.undos.delete(String(token));
        } finally { undo.running = false; }
    }
}
