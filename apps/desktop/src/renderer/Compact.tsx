import { errorMessage } from "../shared/i18n/errors";
import { useI18n } from "../shared/i18n/react";
import { useEffect, useRef, useState } from "react";
import type { CompactApi, CompactState } from "@aimspan/protocol";
import { sessionTimeLabel } from "./time-wording";
import { StateMarker } from "./StateMarker";
import { Icon } from "./Icon";
import { sessionTitle } from "./session-title";
import { surfaceTag } from "./surface-tag";
import { isComposing } from "./idea-keyboard";
declare global { interface Window { aimspanCompact: CompactApi } }
export function Compact() {
    const [state, setState] = useState<CompactState>({ sessions: [], pinned: false, language: "en" });
    const { language, t } = useI18n(state.language ?? "en", "compactTitle");
    const [now, setNow] = useState(Date.now()), [error, setError] = useState("");
    const composing = useRef(false), inFlight = useRef(false);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        let pushed = false;
        const off = window.aimspanCompact.subscribe(value => { pushed = true; setState(value); });
        void window.aimspanCompact.getState().then(value => { if (!pushed) setState(value); });
        const timer = setInterval(() => setNow(Date.now()), 15000);
        return () => { off(); clearInterval(timer); };
    }, []);
    const run = (promise: Promise<void>) => { setError(""); void promise.catch(cause => setError(cause instanceof Error ? cause.message : t("retryOperation"))); };
    const mutate = (work: () => Promise<void>) => {
        if (inFlight.current) return;
        inFlight.current = true; setBusy(true);
        run(work().finally(() => { inFlight.current = false; setBusy(false); }));
    };
    return <main className="compact" data-pinned={state.pinned}
        onMouseEnter={() => run(window.aimspanCompact.hover(true))} onMouseLeave={() => run(window.aimspanCompact.hover(false))}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => { if (event.key === "Escape" && !isComposing(event, composing.current)) { event.preventDefault(); run(window.aimspanCompact.close()); } }}>
        <header className="compact-header"><strong>{t("sessions")}</strong><span className="compact-counts">{t("attentionCounts", state.sessions.filter(session => session.state === "running").length, state.sessions.filter(session => session.state === "waiting").length)}</span>
            <button aria-label={state.pinned ? t("unpinCompact") : t("pinCompact")} aria-pressed={state.pinned} onClick={() => run(window.aimspanCompact.togglePinned())}><Icon name="pin" size={15}/></button>
            <button aria-label={t("closeCompact")} title={t("closeCompactHint")} onClick={() => run(window.aimspanCompact.close())}><Icon name="close" size={14}/></button>
        </header>
        <div className="compact-rows" role="list" aria-label={t("compactSessions")}>
            {state.sessions.map(session => <div className={`compact-row ${session.state === "waiting" ? "needs-you" : ""}`} role="listitem" data-compact-id={session.id} key={session.id}>
                <button className="compact-open" onClick={() => run(window.aimspanCompact.openSession(session.id))}>
                    <StateMarker state={session.state}/><span className="compact-copy"><span className="compact-title"><span title={t("sessionId", session.nativeId)} className={`session-title ${session.hasNewResult ? "has-new-result" : ""}`}>{sessionTitle(session, language)}</span></span>
                    <small><span className="surface-tag">{surfaceTag(session, language)}</span><span className={`compact-time ${session.state}`}>{sessionTimeLabel(session, now, language)}</span>{session.pendingIdeaCount > 0 && <span className="idea-badge"> · {t("ideaCount", session.pendingIdeaCount)}</span>}</small></span>
                </button>
                <div className="compact-actions">
                    <button className="compact-add" aria-label={t("addIdeaToSession", sessionTitle(session, language))} onClick={() => run(window.aimspanCompact.capture(session.id))}><Icon name="plus" size={14}/></button>
                    <button aria-label={`${session.pinned ? t("unpin") : t("pin")} ${sessionTitle(session, language)}`} aria-pressed={session.pinned} disabled={busy}
                        onClick={() => mutate(() => window.aimspanCompact.pinSession({ sessionId: session.id, pinned: !session.pinned, expectedRevision: session.revision, operationId: crypto.randomUUID() }))}><Icon name="pin" size={15}/></button>
                    {session.state === "waiting" && <button aria-label={t("markSessionHandled", sessionTitle(session, language))} disabled={busy}
                        onClick={() => mutate(() => window.aimspanCompact.handleSession({ sessionId: session.id, expectedRevision: session.revision, operationId: crypto.randomUUID() }))}><Icon name="check" size={14}/></button>}
                </div>
            </div>)}
            {!state.sessions.length && <p className="compact-empty">{t("noCompactSessions")}</p>}
        </div>
        <footer><button onClick={() => run(window.aimspanCompact.capture(null))}>{t("saveToInbox")}</button><button className="text-action" onClick={() => run(window.aimspanCompact.newSession())}><Icon name="plus" size={13}/>{t("newSessionAction")}</button></footer>
        {error && <div className="compact-error" role="alert">{errorMessage(error, language)}</div>}
    </main>;
}
