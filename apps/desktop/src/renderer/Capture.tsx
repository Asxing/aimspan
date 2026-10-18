import { renderMessage } from "../shared/i18n/messages";
import type { MessageResult } from "@aimspan/protocol";
import { errorMessage } from "../shared/i18n/errors";
import { useI18n } from "../shared/i18n/react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CAPTURE_DRAFT_KEY, CAPTURE_STALE_OPEN, NEW_SESSION_TARGETS, newSessionApp, validIdeaBody, type CaptureApi, type CaptureContext, type CaptureIdeaRequest } from "@aimspan/protocol";
import { activeCaptureTargets, cycleCaptureTarget, defaultCaptureTarget, filterCaptureTargets, inboxTarget, newSessionTargets } from "./capture-targets";
import { isComposing, isSaveEnter } from "./idea-keyboard";
import { StateMarker } from "./StateMarker";
import { Icon } from "./Icon";
import { sessionTitle } from "./session-title";
import { sessionTimeLabel } from "./time-wording";

declare global { interface Window { aimspanCapture: CaptureApi } }
export function Capture() {
    const [context, setContext] = useState<CaptureContext>();
    const languageUpdate = useRef<CaptureContext["language"] | undefined>(undefined);
    const { language, t } = useI18n(context?.language ?? "en", "captureTitle");
    const [loading, setLoading] = useState(true);
    const [target, setTarget] = useState<string | null>(null);
    const [currentTarget, setCurrentTarget] = useState<string | null>(null);
    const [body, setBody] = useState("");
    const latestBody = useRef("");
    const [now, setNow] = useState(Date.now());
    const [filter, setFilter] = useState<string | null>(null), [filterIndex, setFilterIndex] = useState(0);
    const [saving, setSaving] = useState(false), [notice, setNotice] = useState<{ kind: "saved" } | ({ kind: "handoff" } & MessageResult) | null>(null), [error, setError] = useState("");
    const composing = useRef(false), textarea = useRef<HTMLTextAreaElement>(null), filterInput = useRef<HTMLInputElement>(null);
    const openId = useRef(-1), latestOpen = useRef(-1), busy = useRef(false), pendingIdea = useRef<CaptureIdeaRequest | undefined>(undefined);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => {
        let alive = true, sequence = 0;
        const load = async () => {
            const current = ++sequence;
            // Only a first load or a newly announced open blocks input; a focus-triggered refresh of the
            // same open must never disable the textarea or swallow Enter while the user is typing.
            if (openId.current < 0 || latestOpen.current > openId.current) setLoading(true);
            try {
                const next = await window.aimspanCapture.getContext();
                if (!alive || current !== sequence) return;
                next.language = languageUpdate.current ?? next.language;
                setContext(next);
                if (next.openId !== openId.current) {
                    clearTimeout(timer.current);
                    openId.current = next.openId;
                    latestBody.current = next.drafts[CAPTURE_DRAFT_KEY]?.body ?? "";
                    const defaultTarget = defaultCaptureTarget(next.sessions);
                    setBody(latestBody.current); setNow(Date.now()); setContext(next); setTarget(next.preselectedTarget === undefined ? defaultTarget : next.preselectedTarget);
                    setCurrentTarget(next.preselectedTarget && !newSessionApp(next.preselectedTarget) ? next.preselectedTarget : defaultTarget);
                    setFilter(null); setNotice(null); setError(""); composing.current = false;
                }
            } catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : t("captureReadFailed")); }
            finally { if (alive && current === sequence) setLoading(false); }
        };
        void load();
        const focus = () => { void load(); };
        window.addEventListener("focus", focus);
        // The newest open ID arrives before its context; a pending auto-close from an
        // earlier open must not fire, and an immediate close must target this open.
        const opened = (event: Event) => {
            const id = (event as CustomEvent<unknown>).detail;
            if (typeof id === "number") { latestOpen.current = id; clearTimeout(timer.current); }
            void load();
        };
        window.addEventListener("aimspan-capture-opened", opened);
        return () => { alive = false; clearTimeout(timer.current); window.removeEventListener("focus", focus); window.removeEventListener("aimspan-capture-opened", opened); };
    }, []);
    useEffect(() => window.aimspanCapture.onLanguage(language => { languageUpdate.current = language; setContext(current => current ? { ...current, language } : current); }), []);
    useEffect(() => { const interval = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(interval); }, []);
    useEffect(() => { if (!loading) { if (filter !== null) filterInput.current?.focus(); else textarea.current?.focus(); } }, [filter === null, context?.openId, loading]);
    const sessions = context?.sessions ?? [];
    const selectedSession = sessions.find(session => session.id === target);
    const newApp = newSessionApp(target);
    const selectedTitle = selectedSession ? sessionTitle(selectedSession, language) : newSessionTargets(language).find(t => t.id === target)?.title ?? inboxTarget(language).title;
    const pendingCount = newApp ? 0 : selectedSession?.pendingIdeaCount ?? context?.inboxIdeaCount ?? 0;
    const length = Array.from(body).length;
    const matches = filterCaptureTargets(sessions, filter ?? "", language);
    const report = (cause: unknown) => setError(cause instanceof Error && cause.message.includes(CAPTURE_STALE_OPEN) ? t("captureStaleOpen") : cause instanceof Error ? cause.message : t("saveFailed"));
    function draft(value: string) {
        latestBody.current = value; setBody(value);
        if (validIdeaBody(value)) void window.aimspanCapture.saveDraft({ body: value, operationId: crypto.randomUUID() }).catch(report);
    }
    function choose(id: string | null) { setTarget(id); setFilter(null); setError(""); textarea.current?.focus(); }
    function picker() { setFilter(""); setFilterIndex(0); }
    function chip(index: number) {
        if (index === 5) picker();
        else choose([currentTarget, null, NEW_SESSION_TARGETS.codex, NEW_SESSION_TARGETS.claude][index - 1]!);
    }
    function close() { clearTimeout(timer.current); void window.aimspanCapture.close(Math.max(openId.current, latestOpen.current)).catch(report); }
    async function save() {
        if (busy.current || loading || !context || notice || !body.trim() || !validIdeaBody(body)) return;
        busy.current = true; setSaving(true); setError("");
        // Use the committed context's open ID: it changes in the same render as the shown target,
        // so a save is either for the shown target or rejected by Main as a superseded open.
        const generation = context.openId;
        const request = pendingIdea.current?.body === body && pendingIdea.current.sessionId === target ? pendingIdea.current :
            { sessionId: target, body, expectedRevision: 0, operationId: crypto.randomUUID() };
        pendingIdea.current = request;
        try {
            const result = newApp ? await window.aimspanCapture.newSession({ kind: "capture", app: newApp, body: request.body,
                expectedRevision: 0, operationId: request.operationId }, generation) : await window.aimspanCapture.saveIdea(request, generation);
            pendingIdea.current = undefined;
            if (latestBody.current === body) draft("");
            if (openId.current === generation) {
                setNotice("message" in result ? { kind: "handoff", ...result } : { kind: "saved" });
                timer.current = setTimeout(() => { void window.aimspanCapture.close(generation).catch(report); }, newApp ? 1500 : 1000);
            }
        } catch (cause) {
            report(cause);
            // Superseded open: reload the current context so the new target is shown before another Enter.
            if (cause instanceof Error && cause.message.includes(CAPTURE_STALE_OPEN)) window.dispatchEvent(new Event("focus"));
        }
        finally { busy.current = false; setSaving(false); }
    }
    function keys(event: KeyboardEvent) {
        if (isComposing(event, composing.current)) return;
        if (event.key === "Escape") { event.preventDefault(); if (filter !== null) setFilter(null); else close(); return; }
        if (loading || saving || notice || !context) return;
        if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && /^[1-5]$/.test(event.key)) {
            event.preventDefault(); chip(Number(event.key));
        } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && (filter !== null || event.metaKey)) {
            event.preventDefault();
            const direction = event.key === "ArrowDown" ? 1 : -1;
            if (filter !== null) setFilterIndex(index => matches.length ? (index + direction + matches.length) % matches.length : 0);
            else choose(cycleCaptureTarget(activeCaptureTargets(sessions, language), target, direction));
        } else if (filter !== null && isSaveEnter(event, composing.current)) {
            event.preventDefault(); const match = matches[filterIndex]; if (match) choose(match.id);
        }
    }
    const composition = { onCompositionStart: () => { composing.current = true; }, onCompositionEnd: () => { composing.current = false; } };
    const selectedChip = filter !== null ? 5 : target === null ? 2 : target === currentTarget ? 1 : newApp === "codex" ? 3 : newApp === "claude" ? 4 : 5;
    return <main className="capture" data-capture-open={context?.openId} onKeyDown={keys}>
        <div className="capture-chips" role="group" aria-label={t("captureTargets")}>
            {[t("thisSession"), t("inbox"), t("newCodex"), t("newClaude"), t("otherSessions")].map((label, index) => <button key={label}
                aria-label={label} aria-keyshortcuts={`Meta+${index + 1}`} aria-pressed={selectedChip === index + 1}
                aria-describedby={selectedChip === index + 1 ? "capture-target-details" : undefined}
                title={index === 0 && currentTarget === null ? t("noRecentSession") : `${label} · ⌘${index + 1}`}
                disabled={loading || saving || !!notice || !context} onClick={() => chip(index + 1)}>{label}<kbd>⌘{index + 1}</kbd></button>)}
        </div>
        <div className={`capture-target ${selectedSession?.state ?? "inbox"}`}>
            <button id="capture-target-details" className="capture-target-select" disabled={loading || saving || !!notice || !context} onClick={picker} aria-label={t("chooseTarget")} title={t("switchTargetHint")}>
                {selectedSession && <span className="capture-metadata"><span className="capture-project"><StateMarker state={selectedSession.state}/>
                    {selectedSession.agent === "codex" ? t("codex") : t("claude")} · {selectedSession.project.split("/").filter(Boolean).at(-1) || t("unconfirmed")}</span>
                    <span className="capture-time">{sessionTimeLabel(selectedSession, now, language)}</span></span>}
                <span className="capture-title"><span title={selectedSession ? t("sessionId", selectedSession.nativeId) : undefined} className={`session-title ${selectedSession?.hasNewResult ? "has-new-result" : ""}`}>{selectedTitle}</span>
                    {pendingCount > 0 && <span className="idea-badge">{t("ideaCount", pendingCount)}</span>}</span>
            </button>
            <button className="capture-close" onClick={close} aria-label={t("closeCapture")}>{t("escapeKey")}</button>
        </div>
        {filter !== null ? <div className="capture-filter">
            <label className="capture-search"><Icon name="search" size={14}/><input ref={filterInput} disabled={loading} aria-label={t("filterTargets")} value={filter} placeholder={t("searchTargets")} {...composition}
                onChange={event => { setFilter(event.target.value); setFilterIndex(0); }}/></label>
            <div className="capture-matches" role="listbox" aria-label={t("targets")}>
                {matches.map((match, index) => {
                    const session = sessions.find(session => session.id === match.id);
                    return <button role="option" aria-label={match.title} title={match.nativeId ? t("sessionId", match.nativeId) : undefined} aria-selected={index === filterIndex} key={match.id ?? "inbox"}
                    ref={index === filterIndex ? node => node?.scrollIntoView?.({ block: "nearest" }) : undefined}
                    onMouseDown={event => event.preventDefault()} onClick={() => choose(match.id)}>{session && <StateMarker state={session.state}/>}<span className="match-title">{match.title}</span>{match.project && <small>{match.project.split("/").filter(Boolean).at(-1)}</small>}</button>; })}
                {!matches.length && <span>{t("noMatchingTargets")}</span>}
            </div>
        </div> : <textarea ref={textarea} autoFocus aria-label={t("captureIdea")} value={body} disabled={loading || !context || saving || !!notice}
            placeholder={t("capturePlaceholder")} {...composition}
            onChange={event => {
                if (!validIdeaBody(event.target.value)) { setError(t("captureTooLong")); return; }
                setError(""); draft(event.target.value);
            }} onKeyDown={event => {
                if (isComposing(event, composing.current)) return;
                if (event.key === "@") { event.preventDefault(); picker(); }
                else if (isSaveEnter(event, composing.current)) { event.preventDefault(); void save(); }
            }}/>}
        <footer>{notice ? <span role="status">{notice.kind === "saved" ? t("savedTo", selectedTitle) : renderMessage(language, notice)}</span> : error ? <span role="alert">{errorMessage(error, language)}</span> : <span>{filter !== null ? t("capturePickerHint") : newApp ? t("captureNewFooter", newApp === "codex" ? t("codex") : t("claude")) : t("captureFooter")}</span>}
            {length >= 3600 && <span className={length > 4000 ? "over-limit" : ""} aria-label={t("characterCount")}>{length} / 4000</span>}
        </footer>
    </main>;
}
