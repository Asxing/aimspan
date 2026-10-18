import { messageRef, messageResult, renderMessage } from "../shared/i18n/messages";
import { errorMessage } from "../shared/i18n/errors";
import { translator } from "../shared/i18n";
import { useI18n, LanguageContext } from "../shared/i18n/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Workspace, Idea, Session, NewSessionApp, RendererRequest, PanelApi, PanelTarget, CatchUp, BringBackResult } from "@aimspan/protocol";
import { isActiveSession, isIdeaTargetSession, notificationsEnabled, validIdeaBody } from "@aimspan/protocol";
import { VirtualList, inputHasFocus } from "./VirtualList";
import { sessionRows, sortSessions, groupSessions, freezeGroups, type SessionGroup } from "./session-list";
import { cardStatusLabel, sessionTimeLabel, type SessionTime } from "./time-wording";
import { StateMarker } from "./StateMarker";
import { Icon } from "./Icon";
import { version } from "../../package.json";
import { sessionTitle } from "./session-title";
import { surfaceTag } from "./surface-tag";
import { SessionActions } from "./SessionActions";
import { DraftWriter } from "./draft-writer";
import { isComposing } from "./idea-keyboard";
import { IdeasView, IdeaEditor } from "./IdeasView";
import { CatchUpCard } from "./CatchUpCard";
import { diagnosticView } from "./diagnostics";
declare global { interface Window { aimspan: PanelApi } }
type Notice = BringBackResult & { undoIdea?: Idea };
const op = () => crypto.randomUUID();
const isInput = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest("input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable=true]");

export function App() {
    const [w, setW] = useState<Workspace | null>(null), [error, setError] = useState("");
    const { language, t } = useI18n(w?.settings.language, "appTitle");
    const [query, setQuery] = useState(""), [filter, setFilter] = useState<"active" | "all">("active"), [agent, setAgent] = useState("");
    const [expanded, setExpanded] = useState<string | null>(null), [settings, setSettings] = useState(false);
    const [openTarget, setOpenTarget] = useState<PanelTarget | null>(null);
    const [catchup, setCatchup] = useState<{ value: CatchUp; session: SessionTime & Pick<Session, "revision"> } | null>(null);
    const [drafts, setDrafts] = useState<Record<string, string>>({}), [saving, setSaving] = useState(false);
    const [hovered, setHovered] = useState(false), [inputFocused, setInputFocused] = useState(false), [listFocused, setListFocused] = useState(false);
    const [held, setHeld] = useState<{ view: string; groups: SessionGroup[] }>({ view: "", groups: [] });
    const [selected, setSelected] = useState<string | null>(null), [focusRequest, setFocusRequest] = useState<{ id: string | null; sequence: number } | null>(null);
    const search = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null), composing = useRef(false), settingsBack = useRef<HTMLButtonElement>(null);
    // Toggling Settings unmounts the button that had focus; keep focus inside <main> so Escape still reaches its handler.
    useLayoutEffect(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        if (settings) settingsBack.current?.focus({ preventScroll: true }); else list.current?.focus({ preventScroll: true });
    }, [settings]);
    const [awaitingApply, setAwaitingApply] = useState(false);
    const [now, setNow] = useState(Date.now()), [bringing, setBringing] = useState(false), [notice, setNotice] = useState<Notice | null>(null);
    const initialized = useRef(false), closing = useRef(false), saveInFlight = useRef(false), bringInFlight = useRef(false);
    const undoInFlight = useRef(false);
    const expansion = useRef(0), current = useRef(w);
    current.current = w;
    const draftBodies = useRef<Record<string, string>>({});
    const [draftWriter] = useState(() => new DraftWriter(request => window.aimspan.call(request), error => setError(error instanceof Error ? error.message : t("draftSaveFailed"))));
    useEffect(() => window.aimspan.onOpen(setOpenTarget), []);
    useEffect(() => {
        if (!w || !openTarget) return;
        setOpenTarget(null);
        if (openTarget.kind === "settings") { setSettings(true); return; }
        if (!w.sessions.some(s => s.id === openTarget.sessionId)) return;
        setSettings(false);
        if (!entries.some(s => s.id === openTarget.sessionId)) { setQuery(""); setAgent(""); setFilter("all"); }
        expand(openTarget.sessionId, true);
    }, [w, openTarget]);
    useEffect(() => {
        const apply = (v: Workspace) => {
            setW(v); current.current = v;
            if (!initialized.current) {
                initialized.current = true;
                draftBodies.current = Object.fromEntries(Object.entries(v.drafts).map(([target, draft]) => [target, draft.body]));
                draftWriter.initialize(v.drafts); setDrafts(draftBodies.current);
            }
        };
        let pushed = false;
        const off = window.aimspan.subscribe(value => { pushed = true; apply(value); });
        void window.aimspan.call({ method: "workspace" }).then(v => { if (!pushed) apply(v as Workspace); }, e => setError(String(e)));
        const offFlush = window.aimspan.onFlushDrafts(() => { closing.current = true; draftWriter.flush(); });
        const timer = setInterval(() => setNow(Date.now()), 15000);
        return () => { off(); offFlush(); clearInterval(timer); };
    }, [draftWriter]);
    useEffect(() => {
        if (!notice?.undoExpiresAt) return;
        const timer = setTimeout(() => setNotice(value => {
            if (!value) return null;
            const { undoToken: _token, undoExpiresAt: _expires, undoIdea: _idea, ...retained } = value;
            return retained;
        }), Math.max(0, notice.undoExpiresAt - Date.now()));
        return () => clearTimeout(timer);
    }, [notice]);
    async function perform(work: () => Promise<unknown>) {
        setError("");
        try { return await work(); }
        catch (e) { setError(e instanceof Error ? e.message : t("operationFailed")); return undefined; }
    }
    const call = (request: RendererRequest) => perform(() => window.aimspan.call(request));
    const rows = useMemo(() => !w ? [] : sortSessions(sessionRows(w.sessions).filter(session =>
        !query || `${session.title} ${sessionTitle(session, language)} ${session.project} ${w.ideas.filter(i => i.sessionId === session.id).map(i => i.body).join(" ")}`.toLowerCase().includes(query.toLowerCase())
    )), [w, query, language]);
    const activeRows = rows.filter(isActiveSession);
    const allRows = rows.filter(session => !agent || session.agent === agent);
    const entries = filter === "active" ? activeRows : allRows;
    const nextGroups = filter === "all" ? groupSessions(entries, now) : entries.length ? [{ label: "", ids: entries.map(s => s.id) }] : [];
    const view = JSON.stringify([filter, query, filter === "all" ? agent : ""]);
    const nextKey = JSON.stringify(nextGroups), frozen = hovered || inputFocused || listFocused;
    const sameView = held.view === view, heldKey = JSON.stringify(held.groups);
    const groups = sameView && (frozen || awaitingApply) ? freezeGroups(held.groups, nextGroups) : nextGroups;
    const ids = groups.flatMap(group => group.ids), selectedId = selected && ids.includes(selected) ? selected : ids[0] ?? null;
    const displayedKey = JSON.stringify(groups);
    useLayoutEffect(() => {
        if (!sameView) setAwaitingApply(false);
        else if (frozen && heldKey !== nextKey) setAwaitingApply(true);
        // Every painted row joins the frozen order, including arrivals during this freeze.
        if (!sameView || heldKey !== displayedKey) setHeld({ view, groups: JSON.parse(displayedKey) as SessionGroup[] });
    }, [nextKey, heldKey, displayedKey, frozen, sameView, view]);
    useLayoutEffect(() => {
        if (!settings && document.activeElement === document.body) list.current?.focus({ preventScroll: true });
    }, [!!w, settings, selectedId]);
    useLayoutEffect(() => {
        if (!focusRequest) return;
        // Child layout effects apply row focus first. Consume even when the list was absent
        // or an input blocked focus, so a later remount cannot replay the request.
        setFocusRequest(null);
        if (!settings && focusRequest.id === null && !inputHasFocus()) list.current?.focus({ preventScroll: true });
    }, [focusRequest, settings]);
    const hasUpdate = sameView && (awaitingApply || frozen && heldKey !== nextKey);

    function selectRow(id: string) {
        setSelected(id);
        setFocusRequest(value => ({ id, sequence: (value?.sequence ?? 0) + 1 }));
    }
    function restoreListFocus() {
        setFocusRequest(value => ({ id: selectedId, sequence: (value?.sequence ?? 0) + 1 }));
    }
    function collapse() {
        ++expansion.current; setExpanded(null); setCatchup(null);
        restoreListFocus();
    }
    const reveal = (id: string) => void perform(async () => setNotice({ ...await window.aimspan.reveal(id), brought: 0 }));
    function onKeyDown(event: KeyboardEvent) {
        if (event.defaultPrevented || isComposing(event, composing.current)) return;
        if (event.key === "Escape") {
            event.preventDefault();
            if (!event.repeat) {
                if (expanded && !settings) collapse();
                else void perform(() => window.aimspan.hide());
            }
            return;
        }
        if (isInput(event.target) || settings || event.altKey || event.ctrlKey || event.shiftKey) return;
        if (event.key === "/" && !event.metaKey) { event.preventDefault(); search.current?.focus(); return; }
        if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.metaKey) {
            event.preventDefault();
            const index = selectedId ? ids.indexOf(selectedId) : -1;
            const id = ids[Math.max(0, Math.min(ids.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
            if (id) selectRow(id);
            return;
        }
        if (!selectedId) return;
        if (event.metaKey && (event.key === "Enter" || event.key.toLowerCase() === "o")) {
            event.preventDefault(); if (event.repeat) return;
            const pending = w!.ideas.filter(idea => idea.sessionId === selectedId && idea.status === "pending");
            if (event.key === "Enter" && pending.length) void bringBack(selectedId);
            else reveal(selectedId);
        } else if (event.key === "Enter" && !event.metaKey && event.target instanceof HTMLElement &&
            (event.target === list.current || event.target.matches(".session-toggle[data-session-id]"))) {
            event.preventDefault(); if (!event.repeat) expand(selectedId);
        }
    }

    function draft(target: string, body: string) {
        if (closing.current) return;
        draftBodies.current = { ...draftBodies.current, [target]: body }; setDrafts(draftBodies.current);
        if (!validIdeaBody(body)) { setError(t("ideaTooLong")); return; }
        draftWriter.save(target, body);
    }
    async function saveIdea(target: string) {
        if (closing.current || saveInFlight.current) return;
        const body = draftBodies.current[target] ?? "";
        if (!body.trim() || !validIdeaBody(body)) return;
        saveInFlight.current = true; setSaving(true);
        try {
            await draftWriter.drain();
            if (closing.current) return;
            const result = await call({ method: "idea.save", sessionId: target === "inbox" ? null : target, body,
                expectedRevision: 0, operationId: op() }) as Idea | undefined;
            if (result && !closing.current) {
                if (draftBodies.current[target] === body) draft(target, "");
            }
        } finally { saveInFlight.current = false; setSaving(false); }
    }
    function expand(id: string, force = false) {
        const version = ++expansion.current;
        setCatchup(null);
        if (id !== "inbox") selectRow(id);
        // Explicit navigation starts a fresh visit even when this card was left open.
        if (!force && expanded === id) { setExpanded(null); return; }
        setExpanded(id);
        if (id === "inbox") return;
        const at = new Date().toISOString();
        void perform(async () => {
            // Capture the old anchor before advancing it. Keep this snapshot for this expansion.
            const value = await window.aimspan.call({ method: "catchup", sessionId: id }) as CatchUp;
            if (expansion.current !== version) return;
            const session = current.current?.sessions.find(s => s.id === id);
            if (session) {
                setCatchup({ value, session });
                await window.aimspan.call({ method: "session.viewed", sessionId: id, at, expectedRevision: session.revision, operationId: op() });
            }
        });
    }
    async function bringBack(id: string, only?: Idea) {
        if (bringInFlight.current) return;
        bringInFlight.current = true; setBringing(true);
        try {
            const ideas = only ? [only] : current.current!.ideas.filter(i => i.sessionId === id && i.status === "pending");
            if (!ideas.length) return;
            await perform(async () => setNotice(await window.aimspan.bringBack({ sessionId: id, ideas: ideas.map(i => ({ id: i.id, revision: i.revision })), operationId: op() })));
        } finally { bringInFlight.current = false; setBringing(false); }
    }
    async function newSession(idea: Idea, app: NewSessionApp) {
        if (bringInFlight.current) return;
        bringInFlight.current = true; setBringing(true);
        try {
            await perform(async () => setNotice(await window.aimspan.newSession({ kind: "inbox", app,
                idea: { id: idea.id, revision: idea.revision }, operationId: op() })));
        } finally { bringInFlight.current = false; setBringing(false); }
    }
    async function discard(idea: Idea) {
        const discarded = await call({ method: "idea.setStatus", id: idea.id, status: "discarded", expectedRevision: idea.revision, operationId: op() }) as Idea | undefined;
        if (discarded) setNotice({ ...messageResult(language, messageRef("ideaDeleted")), brought: 0, undoIdea: discarded, undoExpiresAt: Date.now() + 5000 });
    }
    async function undoNotice() {
        if (!notice || undoInFlight.current || !notice.undoExpiresAt || Date.now() >= notice.undoExpiresAt) return;
        undoInFlight.current = true;
        try {
            await perform(async () => {
                if (notice.undoIdea) await window.aimspan.call({ method: "idea.setStatus", id: notice.undoIdea.id, status: "pending",
                    expectedRevision: notice.undoIdea.revision, operationId: op() });
                else if (notice.undoToken) await window.aimspan.undoBringBack(notice.undoToken);
                setNotice(value => value === notice ? { ...messageResult(language, messageRef("ideaRestored")), brought: 0 } : value);
            });
        } finally { undoInFlight.current = false; }
    }
    function ideasView(target: string) {
        const ideas = w!.ideas.filter(i => i.sessionId === (target === "inbox" ? null : target));
        return <IdeasView ideas={ideas} sessions={sessionRows(w!.sessions).filter(isIdeaTargetSession)} call={call}
            bringing={bringing} onNewSession={newSession} onDiscard={discard} onSend={idea => bringBack(target, idea)}
            editor={<IdeaEditor body={drafts[target] ?? ""} editing={false} saving={saving}
                onDraft={body => draft(target, body)} onSave={() => void saveIdea(target)} onCancel={() => {}}/>}/>;
    }
    if (!w) return <main className="loading"><h1>{t("aimSpan")}</h1><p>{error ? errorMessage(error, language) : t("connecting")}</p></main>;
    return <LanguageContext.Provider value={language}><main className={`app ${w.settings.pinned ? "pinned" : ""}`} onKeyDown={onKeyDown}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onFocusCapture={event => setInputFocused(isInput(event.target))} onBlurCapture={event => setInputFocused(isInput(event.relatedTarget))}>
        <header className={settings ? "settings-header" : "panel-header"}>
            {settings ? <><button ref={settingsBack} className="icon-button" aria-label={t("backToList")} onClick={() => setSettings(false)}><Icon name="back"/></button><h1>{t("settings")}</h1></> : <>
            <label className="panel-search"><Icon name="search" size={14}/><input ref={search} aria-label={t("searchLabel")} placeholder={t("search")} value={query} onFocus={() => setSettings(false)} onChange={event => setQuery(event.target.value)}/></label>
            <nav aria-label={t("sessionViews")}><button className={filter === "active" ? "selected" : ""} aria-pressed={filter === "active"} onClick={() => { setFilter("active"); setSettings(false); }}>{t("active")}<span>{activeRows.length}</span></button>
                <button className={filter === "all" ? "selected" : ""} aria-pressed={filter === "all"} onClick={() => { setFilter("all"); setSettings(false); }}>{t("all")}<span>{allRows.length}</span></button></nav></>}
            <button className="icon-button" aria-label={w.settings.pinned ? t("unpinWindow") : t("pinWindow")} title={w.settings.pinned ? t("unpinWindow") : t("pinWindow")} aria-pressed={w.settings.pinned}
                onClick={() => void call({ method: "settings.save", settings: { ...w.settings, pinned: !w.settings.pinned } })}>
                <Icon name="pin"/></button>
            {!settings && <button className="icon-button" aria-label={t("settings")} title={t("settings")} onClick={() => setSettings(true)}><Icon name="settings"/></button>}
        </header>
        {!settings && filter === "all" && <div className="source-chips" role="group" aria-label={t("sourceApps")}>
            {[["", t("allApps")], ["codex", t("codex")], ["claude-code", t("claude")]].map(([value, label]) => <button key={value} aria-pressed={agent === value} className={agent === value ? "selected" : ""} onClick={() => setAgent(value!)}>{label}</button>)}
        </div>}
        {!settings && hasUpdate && <div className="list-updates"><button className="update-pill" onClick={() => { setHeld({ view, groups: nextGroups }); setAwaitingApply(false); restoreListFocus(); }}>{t("updatesAvailable")}</button></div>}
        {error && <div className="error" role="alert">{errorMessage(error, language)}<button aria-label={t("closeError")} onClick={() => setError("")}><Icon name="close" size={14}/></button></div>}
        {notice && <div className="notice" role="status"><span>{renderMessage(language, notice)}</span>{(notice.undoToken || notice.undoIdea) && <button onClick={() => void undoNotice()}>{t("undo")}</button>}<button aria-label={t("closeNotice")} onClick={() => setNotice(null)}><Icon name="close" size={14}/></button></div>}
        {settings ? <SettingsView w={w} call={call} perform={perform}/> : <>
            <div className="list-region" ref={list} tabIndex={0} aria-label={t("sessionNavigation")} onFocusCapture={() => setListFocused(true)} onBlurCapture={event => setListFocused(event.currentTarget.contains(event.relatedTarget))}
                onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
                {entries.length ? <VirtualList ids={ids} groups={groups} expanded={expanded} focusRequest={focusRequest} render={id => {
                    const session = entries.find(s => s.id === id)!;
                    const pending = w.ideas.filter(idea => idea.sessionId === id && idea.status === "pending");
                    const handled = session.state === "waiting" ? () => void call({ method: "session.handled", sessionId: id, expectedRevision: session.revision, operationId: op() }) : undefined;
                    // Keep the visit's reply/away anchor, while recent activity and state stay live.
                    const currentCatchup = catchup && { ...catchup.value,
                        ...(session.revision > catchup.session.revision ? { activity: session.activity.slice(0, 5), activityIncomplete: session.activityIncomplete } : {}),
                        durationMsOfCurrentOrLastTurn: session.lastPromptAt === catchup.session.lastPromptAt && session.lastTurnEndAt === catchup.session.lastTurnEndAt
                            ? catchup.value.durationMsOfCurrentOrLastTurn : session.latestTurn?.durationMs ?? null };
                    return <article onFocusCapture={() => setSelected(id)} className={`session ${session.state === "waiting" ? "needs-you" : ""} ${expanded === id ? "expanded" : ""} ${selectedId === id ? "keyboard-selected" : ""}`}>
                        <div className="session-header"><button className="session-toggle" data-session-id={id} tabIndex={selectedId === id ? 0 : -1} aria-current={selectedId === id ? "true" : undefined}
                            aria-expanded={expanded === id} onClick={() => expand(id)}>
                            <div className="metadata"><span className="session-provenance"><StateMarker state={session.state}/><span className="surface-tag">{surfaceTag(session, language)}</span><span className="session-project">{session.project.split("/").filter(Boolean).at(-1) || t("unconfirmed")}{session.archived ? t("archivedSuffix") : ""}</span></span>
                                {expanded !== id && <span className={`status ${session.state}`}>{sessionTimeLabel(session, now, language)}</span>}</div>
                            <div className="row-title"><h2 title={t("sessionId", session.nativeId)} className={`session-title ${session.hasNewResult ? "has-new-result" : ""} ${session.state === "idle" ? "muted" : ""}`}>{sessionTitle(session, language)}</h2>
                                {expanded !== id && session.pendingIdeaCount > 0 && <span className="idea-badge">{t("ideaCount", session.pendingIdeaCount)}</span>}</div>
                            {expanded === id && <div className={`status catchup-summary ${session.state}`}>{cardStatusLabel(session, null, now, language)}</div>}</button>
                        {expanded !== id && handled && <button className="session-handled" aria-label={t("markSessionHandled", sessionTitle(session, language))} onClick={handled}><Icon name="check" size={14}/></button>}
                        {expanded === id && <SessionActions pendingCount={pending.length} bringing={bringing} pinned={session.pinned} archived={session.archived} onHandled={handled}
                            onBringBack={() => void bringBack(id)} onOpen={() => reveal(id)}
                            onPin={() => void call({ method: session.pinned ? "session.unpin" : "session.pin", sessionId: id, expectedRevision: session.revision, operationId: op() })}
                            onDeactivate={() => void call({ method: "session.deactivate", sessionId: id, expectedRevision: session.revision, operationId: op() })}
                            onArchive={() => void call({ method: "session.archive", sessionId: id, archived: !session.archived, operationId: op() })}/>}</div>
                        {expanded === id && <div className="details"><CatchUpCard key={`${id}:${expansion.current}`} catchup={currentCatchup}
                            session={session} now={now} ideas={ideasView(id)} onHandled={handled} onLink={url => void perform(() => window.aimspan.openLink(url))}/></div>}
                    </article>;
                }}/> : <div className="empty"><h2>{filter === "active" ? t("noActiveSessions") : t("noMatchingSessions")}</h2><p>{t("emptySessionsHint")}</p></div>}
            </div>
            {w.inboxIdeaCount > 0 && <article className={`session inbox ${expanded === "inbox" ? "expanded" : ""}`}><button className="session-toggle" aria-expanded={expanded === "inbox"} onClick={() => expand("inbox")}><h2>{t("inboxCount", w.inboxIdeaCount)}</h2></button>
                {expanded === "inbox" && <div className="details">{ideasView("inbox")}</div>}</article>}
        </>}
        {!settings && w.diagnostics.length > 0 && <footer><span className="warning">{t("sourcesNeedAttention", w.diagnostics.length)}<button onClick={() => setSettings(true)}>{t("view")}</button></span></footer>}
    </main></LanguageContext.Provider>;
}

function SettingsView({ w, call, perform }: {
    w: Workspace; call: (request: RendererRequest) => Promise<unknown>; perform: (work: () => Promise<unknown>) => Promise<unknown>;
}) {
    const { language, t } = useI18n(w.settings.language);
    const [captureShortcut, setCaptureShortcut] = useState(w.settings.captureShortcut ?? "CommandOrControl+Shift+Space");
    const [bubbleShortcut, setBubbleShortcut] = useState(w.settings.bubbleShortcut ?? "");
    const [exported, setExported] = useState(false);
    const change = (patch: Partial<Workspace["settings"]>) => {
        const settings = { ...w.settings, ...patch };
        void call({ method: "settings.save", settings: { ...settings, notifications: notificationsEnabled(settings) } });
    };
    return <div className="settings">
        <section className="settings-card"><div className="setting-row">
            <div className="setting-copy"><h2 id="language-label">{t("language")}</h2><p>{t("languageHint")}</p></div>
            <div className="segmented" role="radiogroup" aria-labelledby="language-label" onKeyDown={event => {
                if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === "Home" ? "en" : event.key === "End" ? "zh" : w.settings.language === "en" ? "zh" : "en";
                event.currentTarget.querySelector<HTMLButtonElement>(`[data-language="${next}"]`)?.focus();
                change({ language: next });
            }}>{(["en", "zh"] as const).map(value => <button key={value} role="radio" data-language={value} aria-checked={w.settings.language === value}
                tabIndex={w.settings.language === value ? 0 : -1} onClick={() => change({ language: value })}>{value === "en" ? translator("en")("englishOption") : translator("zh")("chineseOption")}</button>)}</div>
        </div></section>
        <section className="settings-card"><h2 className="settings-section-title">{t("sessionSources")}</h2>
            <label className="setting-row"><span className="setting-copy"><span>{t("observeAll")}</span><small>{t("sourcesDescription")}</small></span>
                <input type="checkbox" aria-label={t("observeAll")} checked={w.settings.observeAll !== false} onChange={event => change({ observeAll: event.target.checked })}/></label>
            {w.settings.roots.map(path => <div key={path} className="setting-row root"><span>{path}</span><button onClick={() => change({ roots: w.settings.roots.filter(p => p !== path) })}>{t("remove")}</button></div>)}
            <div className="setting-row setting-buttons"><button onClick={() => void perform(() => window.aimspan.chooseRoot())}>{t("chooseProject")}</button>
                <button onClick={() => void call({ method: "scan" })}>{t("refreshSources")}</button></div>
            <div className="settings-diagnostics"><h3>{t("sourceDiagnostics")}</h3>{w.diagnostics.length ? <ul>{w.diagnostics.map((diagnostic, index) => {
                const view = diagnosticView(diagnostic, language);
                return <li key={index}><span>{view.label}</span>{view.path && <small className="diagnostic-path">{view.path}</small>}</li>;
            })}</ul> : <p>{t("sourcesOk")}</p>}</div>
        </section>
        <section className="settings-card"><h2 className="settings-section-title">{t("shortcuts")}</h2>
            <label className="setting-row"><span>{t("quickCapture")}</span><input value={captureShortcut} maxLength={160} placeholder={t("shortcutPlaceholder")} onChange={event => setCaptureShortcut(event.target.value)}/></label>
            <label className="setting-row"><span>{t("toggleBubble")}</span><input value={bubbleShortcut} maxLength={160} placeholder={t("notSet")} onChange={event => setBubbleShortcut(event.target.value)}/></label>
            <div className="setting-row"><div className="setting-copy"><p>{t("shortcutsHint")}</p>
                {w.captureShortcutError && <p role="alert">{w.captureShortcutError}</p>}
                {w.bubbleShortcutError && <p role="alert">{w.bubbleShortcutError}</p>}</div>
                <button onClick={() => change({ captureShortcut, bubbleShortcut })}>{t("saveShortcuts")}</button></div>
        </section>
        <section className="settings-card"><h2 className="settings-section-title">{t("bubbleNotifications")}</h2>
            <label className="setting-row"><span className="setting-copy"><span>{t("showBubble")}</span><small>{t("bubbleHint")}</small></span><input type="checkbox" aria-label={t("showBubble")} checked={w.settings.bubbleEnabled !== false} onChange={event => change({ bubbleEnabled: event.target.checked })}/></label>
            <label className="setting-row"><span className="setting-copy"><span>{t("notifyProgress")}</span><small>{t("notificationsHint")}</small></span><input type="checkbox" aria-label={t("notifyProgress")} checked={notificationsEnabled(w.settings)} onChange={event => change({ notifications: event.target.checked, notificationsExplicit: true })}/></label>
            {(w.settings.bubbleHiddenUntil ?? 0) > Date.now() && <div className="setting-row"><button onClick={() => change({ bubbleHiddenUntil: 0, bubbleEnabled: true })}>{t("showBubbleNow")}</button></div>}
            <label className="setting-row"><span>{t("dndHour")}</span><input type="checkbox" checked={(w.settings.dndUntil ?? 0) > Date.now()} onChange={event => change({ dndUntil: event.target.checked ? Date.now() + 3_600_000 : 0 })}/></label>
        </section>
        <section className="settings-card"><h2 className="settings-section-title">{t("legacyData")}</h2>
            <div className="setting-row"><div className="setting-copy"><p>{!w.legacyImport ? t("legacyUnavailable") : w.legacyImport.databases ? t("legacyImported", w.legacyImport.databases, w.legacyImport.sessions, w.legacyImport.ideas) : t("legacyNone")}</p>
                {exported && <p role="status">{t("legacyExported")}</p>}</div>
                <button onClick={() => void perform(async () => { const result = await window.aimspan.exportLegacy(op()); if (result) setExported(true); })}>{t("exportLegacy")}</button></div>
        </section>
        <footer className="settings-footer"><span>{t("settingsAbout", version)}</span><a href="https://github.com/Asxing/aimspan" onClick={event => { event.preventDefault(); void perform(() => window.aimspan.openLink("https://github.com/Asxing/aimspan")); }}>{t("github")}</a></footer>
    </div>;
}
