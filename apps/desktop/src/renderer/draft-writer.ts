import type { CoreRequest, Draft, Workspace } from "@aimspan/protocol";

type DraftRequest = Extract<CoreRequest, { method: "draft.save" }>;
type PendingDraft = Pick<DraftRequest, "target" | "body" | "operationId">;

/** Normal writes wait for revisions; quit sends the latest unsent bodies before acknowledging Main. */
export class DraftWriter {
    private revisions = new Map<string, number>();
    private pending: PendingDraft[] = [];
    private current: DraftRequest | undefined;
    private closed = false;
    private waiters: (() => void)[] = [];

    constructor(private readonly send: (request: DraftRequest) => Promise<unknown>, private readonly onError: (error: unknown) => void) {}

    initialize(drafts: Workspace["drafts"]) {
        this.revisions = new Map(Object.entries(drafts).map(([target, draft]) => [target, draft.revision]));
    }

    save(target: string, body: string, operationId: string = crypto.randomUUID()) {
        if (this.closed) return;
        this.pending.push({ target, body, operationId });
        this.pump();
    }

    drain(): Promise<void> {
        if (!this.current && !this.pending.length) return Promise.resolve();
        return new Promise(resolve => this.waiters.push(resolve));
    }

    flush() {
        if (this.closed) return;
        this.closed = true;
        const revisions = new Map(this.revisions);
        // This request is already queued in Main/Core, even if its reply has not reached us.
        if (this.current) revisions.set(this.current.target, this.current.expectedRevision + 1);
        const latest = new Map(this.pending.map(draft => [draft.target, draft]));
        this.pending = [];
        for (const draft of latest.values()) {
            const request: DraftRequest = { method: "draft.save", ...draft, expectedRevision: revisions.get(draft.target) ?? 0 };
            // Invoke synchronously: the preload acknowledges only after every IPC call is queued.
            void this.dispatch(request).catch(this.onError);
        }
        this.settle();
    }

    private dispatch(request: DraftRequest): Promise<unknown> {
        try { return this.send(request); } catch (error) { return Promise.reject(error); }
    }

    private pump() {
        if (this.closed || this.current) return;
        const draft = this.pending.shift();
        if (!draft) { this.settle(); return; }
        const request: DraftRequest = { method: "draft.save", ...draft, expectedRevision: this.revisions.get(draft.target) ?? 0 };
        this.current = request;
        void this.dispatch(request).then(result => {
            this.revisions.set(request.target, (result as Draft).revision);
        }).catch(this.onError).finally(() => {
            this.current = undefined;
            if (!this.closed) this.pump();
            this.settle();
        });
    }

    private settle() {
        if (!this.current && !this.pending.length) {
            for (const resolve of this.waiters) resolve();
            this.waiters = [];
        }
    }
}
