import { isAttentionSession, type Session } from "@aimspan/protocol";
import { attentionCounts } from "./attention-counts";
import { initialHoverIntent, sampleHoverIntent, suppressHoverIntent, type PointerSample } from "./bubble-intent";

export function visualState(sessions: readonly Session[], lastEnd: number | undefined) {
    const active = sessions.filter(isAttentionSession);
    const latest = Math.max(0, ...active.map(s => Date.parse(s.lastTurnEndAt ?? "") || 0));
    return { ...attentionCounts(sessions),
        lastEnd: Math.max(lastEnd ?? 0, latest), pulse: lastEnd !== undefined && latest > lastEnd };
}

/** Main owns the timers. Neither visibility nor pinning is inferred from DOM focus. */
export class BubbleInteraction {
    open = false;
    pinned = false;
    bubble = false;
    list = false;
    private clicked = false;
    private enteredList = false;
    private intent = initialHoverIntent();
    private leaveTimer: ReturnType<typeof setTimeout> | undefined;
    constructor(private readonly changed: () => void) {}
    sample(sample: PointerSample) {
        this.intent = sampleHoverIntent(this.intent, sample);
        this.hover("bubble", sample.inside);
        if (this.intent.phase === "ready" && !this.open) {
            this.clear(); this.clicked = this.enteredList = false; this.open = true; this.changed();
        }
    }
    hover(surface: "bubble" | "list", inside: boolean) {
        if (this[surface] === inside) return;
        this[surface] = inside;
        if (inside) {
            this.clear();
            if (surface === "list" && this.open) this.enteredList = true;
        } else {
            if (surface === "bubble") this.intent = initialHoverIntent();
            if (this.open && !this.bubble && !this.list && !this.pinned && (!this.clicked || this.enteredList)) {
                this.clear();
                this.leaveTimer = setTimeout(() => this.close(), this.clicked ? 1000 : 500);
            }
        }
        this.changed();
    }
    toggle() {
        if (this.open) this.close();
        else { this.clear(); this.open = this.clicked = true; this.enteredList = false; this.changed(); }
    }
    togglePinned() {
        this.pinned = !this.pinned;
        if (!this.pinned) this.close();
        else { this.clear(); this.open = true; this.changed(); }
    }
    actionCompleted() { if (!this.pinned) this.close(); }
    // Pin preference lasts for this Main instance, including explicit close/reopen.
    close() { this.clear(); this.intent = suppressHoverIntent(this.intent); this.open = this.clicked = this.enteredList = this.list = false; this.changed(); }
    reset() { this.intent = initialHoverIntent(); this.bubble = this.list = false; this.close(); }
    stop() { this.clear(); this.intent = initialHoverIntent(); }
    private clear() { clearTimeout(this.leaveTimer); this.leaveTimer = undefined; }
}
