import { useI18n } from "../shared/i18n/react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { validIdeaBody, type Idea, type NewSessionApp, type RendererRequest, type Session } from "@aimspan/protocol";
import { isComposing, isSaveEnter } from "./idea-keyboard";
import { sessionTitle } from "./session-title";
import { timeAgo } from "./time-wording";

type IdeaActions = {
    call: (request: RendererRequest) => Promise<unknown>;
    bringing: boolean;
    sessions: Session[];
    onSend: (idea: Idea) => Promise<void>;
    onDiscard: (idea: Idea) => Promise<void>;
    onNewSession: (idea: Idea, app: NewSessionApp) => Promise<void>;
};

function IdeaRow({ idea, call, bringing, sessions, onSend, onDiscard, onNewSession }: IdeaActions & { idea: Idea }) {
    const { language, t } = useI18n();
    // Keep the revision from the start of editing; a source update must not silently overwrite it.
    const [edit, setEdit] = useState<{ body: string; revision: number } | null>(null);
    const [busy, setBusy] = useState(false), inFlight = useRef(false);
    const editButton = useRef<HTMLButtonElement>(null), wasEditing = useRef(false);
    useLayoutEffect(() => {
        if (edit) wasEditing.current = true;
        else if (!busy && wasEditing.current) { editButton.current?.focus(); wasEditing.current = false; }
    }, [!!edit, busy]);
    const run = async (work: () => Promise<unknown>) => {
        if (inFlight.current) return;
        inFlight.current = true; setBusy(true);
        try { await work(); } finally { inFlight.current = false; setBusy(false); }
    };
    const status = () => run(() => call({ method: "idea.setStatus", id: idea.id, status: "pending", expectedRevision: idea.revision, operationId: crypto.randomUUID() }));
    const disabled = busy || bringing;
    return <div className="idea" data-idea-id={idea.id}>
        {edit ? <IdeaEditor body={edit.body} editing saving={busy} label={t("editIdea", idea.body)} onDraft={body => setEdit({ ...edit, body })}
            onCancel={() => setEdit(null)} onSave={() => void run(async () => {
                const saved = await call({ method: "idea.save", id: idea.id, sessionId: idea.sessionId, body: edit.body,
                    expectedRevision: edit.revision, operationId: crypto.randomUUID() });
                if (saved) setEdit(null);
            })}/> : <div className="idea-row"><p className="verbatim">{idea.body}</p><div className="idea-actions">
            {idea.status === "pending" ? <>
                {idea.sessionId !== null && <button className="text-action" disabled={disabled} aria-label={t("sendIdea", idea.body)} onClick={() => void run(() => onSend(idea))}>{t("send")}</button>}
                <button ref={editButton} disabled={disabled} aria-label={t("editIdea", idea.body)} onClick={() => setEdit({ body: idea.body, revision: idea.revision })}>{t("edit")}</button>
                <button disabled={disabled} aria-label={t("deleteIdea", idea.body)} onClick={() => void run(() => onDiscard(idea))}>{t("delete")}</button>
                {idea.sessionId === null && <>
                    <select disabled={disabled} aria-label={t("moveIdea", idea.body)} value="" onChange={event => void run(() => call({ method: "idea.move", id: idea.id,
                        sessionId: event.target.value, expectedRevision: idea.revision, operationId: crypto.randomUUID() }))}>
                        <option value="" disabled>{t("moveToSession")}</option>{sessions.map(session => <option key={session.id} value={session.id} title={t("sessionId", session.nativeId)}>{sessionTitle(session, language)}</option>)}
                    </select>
                    <button disabled={disabled} aria-label={t("newCodexIdea", idea.body)} onClick={() => void run(() => onNewSession(idea, "codex"))}>{t("newCodexAction")}</button>
                    <button disabled={disabled} aria-label={t("newClaudeIdea", idea.body)} onClick={() => void run(() => onNewSession(idea, "claude"))}>{t("newClaudeAction")}</button>
                </>}
            </> : <>
                <button disabled={disabled} aria-label={t("restoreIdeaLabel", idea.status === "brought" ? t("undoBringBack") : t("restore"), idea.body)} onClick={() => void status()}>{idea.status === "brought" ? t("undoBringBack") : t("restore")}</button>
                {idea.status === "discarded" && <button disabled={disabled} aria-label={t("purgeIdea", idea.body)} onClick={() => {
                    if (window.confirm(t("purgeConfirm"))) void run(() => call({ method: "idea.purge", id: idea.id, expectedRevision: idea.revision, operationId: crypto.randomUUID() }));
                }}>{t("purge")}</button>}
            </>}
        </div></div>}
        <small>{timeAgo(idea.createdAt, undefined, language)}</small>
    </div>;
}

export function IdeasView({ ideas, editor, ...actions }: IdeaActions & { ideas: Idea[]; editor: ReactNode }) {
    const { t } = useI18n();
    const pending = ideas.filter(i => i.status === "pending"), brought = ideas.filter(i => i.status === "brought"), discarded = ideas.filter(i => i.status === "discarded");
    const row = (idea: Idea) => <IdeaRow key={idea.id} idea={idea} {...actions}/>;
    return <div className="ideas"><h3>{t("myIdeas")}</h3>{pending.map(row)}
        {!!brought.length && <details><summary>{t("broughtPrefix")}{brought.length}</summary>{brought.map(row)}</details>}
        {!!discarded.length && <details><summary>{t("deletedPrefix")}{discarded.length}</summary>{discarded.map(row)}</details>}
        {editor}
    </div>;
}

export function IdeaEditor({ body, editing, saving, onDraft, onSave, onCancel, label: customLabel }: {
    body: string; editing: boolean; saving: boolean; onDraft: (body: string) => void; onSave: () => void; onCancel: () => void; label?: string;
}) {
    const { t } = useI18n();
    const composing = useRef(false);
    const label = customLabel ?? t("addIdea");
    const canSave = !saving && !!body.trim() && validIdeaBody(body);
    return <div className="idea-editor"><textarea aria-label={label} autoFocus={editing} disabled={saving && editing}
        placeholder={t("ideaPlaceholder")} value={body}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onChange={event => onDraft(event.target.value)} onKeyDown={event => {
            if (editing && event.key === "Escape" && !isComposing(event, composing.current)) {
                event.preventDefault(); event.stopPropagation(); if (!saving) onCancel(); return;
            }
            if (!isSaveEnter(event, composing.current)) return;
            event.preventDefault(); if (canSave) onSave();
        }}/>
        <div className="actions"><small>{Array.from(body).length}{t("ideaEditorHint")}</small>
            <button disabled={!canSave} aria-label={editing ? t("saveLabel", label) : t("saveIdea")} onClick={onSave}>{editing ? t("saveChanges") : t("saveIdea")}</button>
            {editing && <button disabled={saving} aria-label={t("cancelLabel", label)} onClick={onCancel}>{t("cancelEdit")}</button>}
        </div>
    </div>;
}
