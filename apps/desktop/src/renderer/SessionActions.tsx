import { useI18n } from "../shared/i18n/react";
import { Icon } from "./Icon";
import { useEffect, useId, useRef, useState } from "react";

export function SessionActions({ pendingCount, bringing, pinned, archived, onBringBack, onOpen, onPin, onDeactivate, onArchive, onHandled }: {
    pendingCount: number; bringing: boolean; pinned: boolean; archived: boolean;
    onBringBack: () => void; onOpen: () => void; onPin: () => void; onDeactivate: () => void; onArchive: () => void;
    onHandled?: (() => void) | undefined;
}) {
    const { t } = useI18n();
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
    const menuId = useId();
    const close = () => { setOpen(false); trigger.current?.focus(); };
    const focusItem = (index: number) => {
        const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
        if (items?.length) items[(index + items.length) % items.length]?.focus();
    };
    useEffect(() => {
        if (!open) return;
        focusItem(0);
        const outside = (event: PointerEvent) => {
            if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
        };
        document.addEventListener("pointerdown", outside);
        return () => document.removeEventListener("pointerdown", outside);
    }, [open]);
    return <div className="actions main-actions">
        <button className="primary-action" disabled={bringing} onClick={pendingCount > 0 ? onBringBack : onOpen}>
            {pendingCount > 0 ? t("bringBackCount", pendingCount) : t("openSessionAction")}
        </button>
        <div className="session-overflow" ref={root} onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
        }} onKeyDown={event => {
            if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); }
        }}>
            <button ref={trigger} aria-label={t("moreSessionActions")} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
                onClick={() => setOpen(value => !value)} onKeyDown={event => {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (open) focusItem(event.key === "ArrowUp" ? -1 : 0); else setOpen(true); }
                }}><Icon name="more"/></button>
            {open && <div className="session-menu" role="menu" aria-label={t("sessionActions")} id={menuId} ref={menu} onKeyDown={event => {
                const items = Array.from(event.currentTarget.querySelectorAll('[role="menuitem"]'));
                const index = items.indexOf(document.activeElement!);
                const target = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
                if (target !== null) { event.preventDefault(); focusItem(target); }
            }}>
                <button role="menuitem" onClick={() => { close(); onOpen(); }}>{t("openSessionOnly")}</button>
                <button role="menuitem" onClick={() => { close(); onPin(); }}>{pinned ? t("unpin") : t("pinToActive")}</button>
                {onHandled && <button role="menuitem" onClick={() => { close(); onHandled(); }}><Icon name="check"/>{t("markHandledAction")}</button>}
                <button role="menuitem" onClick={() => { close(); onDeactivate(); }}>{t("hideUntilPrompt")}</button>
                <button role="menuitem" onClick={() => { close(); onArchive(); }}>{archived ? t("restoreSession") : t("archive")}</button>
            </div>}
        </div>
    </div>;
}
