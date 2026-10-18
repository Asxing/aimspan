import { errorMessage } from "../shared/i18n/errors";
import { useI18n } from "../shared/i18n/react";
import { useEffect, useState, type PointerEvent } from "react";
import type { BubbleApi, BubbleState } from "@aimspan/protocol";
import { Icon } from "./Icon";
import { attentionSymbols, attentionTooltip } from "../status-symbols";
declare global { interface Window { aimspanBubble: BubbleApi } }
export function Bubble() {
    const [state, setState] = useState<BubbleState>();
    const { language, t } = useI18n(state?.language ?? "en", "bubbleTitle");
    const [error, setError] = useState("");
    useEffect(() => {
        let pushed = false;
        const off = window.aimspanBubble.subscribe(value => { pushed = true; setState(value); });
        void window.aimspanBubble.getState().then(value => { if (!pushed) setState(value); });
        return off;
    }, []);
    const run = (promise: Promise<void>) => { void promise.catch(() => setError(t("bubbleUnavailable"))); };
    const observe = (event: PointerEvent<HTMLButtonElement>) => run(window.aimspanBubble.pointer("move", { x: event.screenX, y: event.screenY, buttons: event.buttons }));
    const pointer = (phase: "down" | "move" | "up" | "cancel", event: PointerEvent<HTMLButtonElement>) => {
        if (phase === "down") {
            if (event.button !== 0) { observe(event); return; }
            event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
        } else if (!event.currentTarget.hasPointerCapture(event.pointerId)) { observe(event); return; }
        run(window.aimspanBubble.pointer(phase, { x: event.screenX, y: event.screenY, buttons: event.buttons }));
        if (phase === "up" || phase === "cancel") event.currentTarget.releasePointerCapture(event.pointerId);
    };
    if (!state) return null;
    const counts = attentionSymbols(state), label = attentionTooltip(state, language);
    return <button className={`bubble ${state.waiting > 0 ? "waiting" : counts.length === 0 ? "dimmed" : ""}`} data-bubble data-side={state.side} data-revealed={state.revealed}
        style={{ left: state.circleX }} title={error ? errorMessage(error, language) : label}
        aria-label={label} aria-expanded={state.open}
        onMouseEnter={() => run(window.aimspanBubble.hover(true))} onMouseLeave={() => run(window.aimspanBubble.hover(false))}
        onPointerEnter={observe}
        onPointerDown={event => pointer("down", event)} onPointerMove={event => pointer("move", event)}
        onPointerUp={event => pointer("up", event)} onPointerCancel={event => pointer("cancel", event)}
        onLostPointerCapture={event => run(window.aimspanBubble.pointer("cancel", { x: event.screenX, y: event.screenY }))}
        onClick={event => { if (event.detail === 0) run(window.aimspanBubble.toggle()); }}
        onContextMenu={event => { event.preventDefault(); run(window.aimspanBubble.menu()); }}>
        <span className={`bubble-ring ${state.running > 0 ? "running" : ""}`} aria-hidden="true"/>
        {state.pulse > 0 && <span key={state.pulse} className="bubble-pulse" aria-hidden="true"/>}
        <span className="bubble-counts" aria-hidden="true">{counts.length === 0 && <Icon name="dash" size={20}/>} {counts.map(({ state, count, color }) =>
            <span key={state} className={`bubble-count ${state}`} style={{ color }}>{count}</span>)}</span>
    </button>;
}
