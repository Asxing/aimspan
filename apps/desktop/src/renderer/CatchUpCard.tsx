import { useI18n } from "../shared/i18n/react";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { CatchUp } from "@aimspan/protocol";
import { Icon } from "./Icon";
import { elapsedLabel, timeAgo, type SessionTime } from "./time-wording";

function safeUrl(url: string) {
    try { return ["http:", "https:", "codex:", "claude:"].includes(new URL(url).protocol) ? url : ""; }
    catch { return ""; }
}
export function Reply({ body, onLink }: { body: string; onLink: (url: string) => void }) {
    const { t } = useI18n();
    const [expanded, setExpanded] = useState(false);
    const [overflows, setOverflows] = useState(false);
    const content = useRef<HTMLDivElement>(null), contentId = useId();
    const boundedBody = Array.from(body).slice(0, 20_000).join("");
    useLayoutEffect(() => {
        const node = content.current;
        if (!node) return;
        const measure = () => {
            const style = getComputedStyle(node);
            const lineHeight = Number.parseFloat(style.lineHeight) || (Number.parseFloat(style.fontSize) || 14) * 1.5;
            setOverflows(node.scrollHeight > lineHeight * 8 + 1);
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        return () => observer.disconnect();
    }, [boundedBody]);
    return <div className="markdown">
        <div ref={content} id={contentId} className={`reply-body ${expanded ? "" : "reply-clamped"} ${!expanded && overflows ? "reply-faded" : ""}`}
            onFocusCapture={() => { if (overflows) setExpanded(true); }}>
            <ReactMarkdown skipHtml disallowedElements={["img"]} urlTransform={safeUrl} components={{
                a: ({ href, children }) => href ? <a href={href} onClick={event => { event.preventDefault(); onLink(href); }}>{children}</a> : <span>{children}</span>,
            }}>{boundedBody}</ReactMarkdown>
        </div>
        {overflows && <button aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>{expanded ? t("collapseReply") : t("expandReply")}</button>}
    </div>;
}

export function CatchUpCard({ catchup, session, now, ideas, onLink, onHandled }: {
    catchup: CatchUp | null;
    session: SessionTime;
    now: number;
    ideas: ReactNode;
    onLink: (url: string) => void;
    onHandled?: (() => void) | undefined;
}) {
    const { language, t } = useI18n();
    const duration = catchup?.durationMsOfCurrentOrLastTurn;
    const ended = (session.state === "waiting" || session.state === "idle") && Number.isFinite(Date.parse(session.lastTurnEndAt ?? "")) &&
        (!session.lastPromptAt || Date.parse(session.lastTurnEndAt!) >= Date.parse(session.lastPromptAt));
    const activity = catchup && <>
        {catchup.activity.length > 0 ? <ul className="activity-list" aria-label={t("recentActivity")}>{catchup.activity.slice(0, 5).map((entry, index) => {
            const failed = entry.kind === "command" && entry.failed;
            const text = entry.kind === "message" ? Array.from(entry.text.split(/\r\n|\r|\n/, 1)[0]!).slice(0, 80).join("") : entry.text;
            const kind = { message: t("message"), command: t("command"), file: t("file"), error: t("errorOrInterruption") }[entry.kind];
            return <li key={`${entry.at}:${entry.kind}:${index}`} data-kind={entry.kind} className={failed || entry.kind === "error" ? "activity-failed" : ""}>
                <time dateTime={entry.at}>{timeAgo(entry.at, now, language)}</time>
                <span className="activity-kind" role="img" aria-label={kind}><Icon name={entry.kind === "error" ? "warning" : entry.kind} size={13}/></span>
                <span className="activity-text" title={text}>{text}</span>
                {failed && <span className="activity-failure">{t("failed")}</span>}
            </li>;
        })}</ul> : <p className="muted">{t("noActivity")}</p>}
        {catchup.activityIncomplete && <p className="warning">{t("earlierActivityNotRead")}</p>}
    </>;
    return <div className="catchup" aria-label={t("catchUpCard")}>
        <section data-section="ideas">{ideas}</section>
        <section data-section="result">{catchup ? <>
            <div className="result-heading"><h3>{session.state === "running" ? t("recentActivity") : t("result")}</h3>
                {ended && duration != null && duration > 0 && <span>{t("resultDuration", elapsedLabel(duration, language))}</span>}</div>
            {session.state === "running" ? <div data-section="activity">{activity}</div> : <>
                {catchup.awaySummary && <section data-section="away"><h3>{t("awaySummary")}</h3><p className="verbatim">{catchup.awaySummary}</p></section>}
                <section data-section="reply" aria-label={t("result")}>
                    {catchup.lastAgentMessage ? <Reply body={catchup.lastAgentMessage.body} onLink={onLink}/> : <p className="muted">{t("noReply")}</p>}
                    {catchup.truncated && <p className="warning">{t("replyTruncated")}</p>}
                </section>
                <details data-section="activity"><summary><Icon name="chevron" size={12}/>{t("processSteps", Math.min(catchup.activity.length, 5))}</summary>{activity}</details>
            </>}
        </> : <p>{t("loadingCatchUp")}</p>}
            {session.state === "waiting" && onHandled && <div className="result-actions"><button onClick={onHandled}><Icon name="check" size={14}/>{t("markHandledAction")}</button></div>}
        </section>
    </div>;
}
