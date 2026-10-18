import { useI18n } from "../shared/i18n/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { SessionGroup } from "./session-list";

const estimate = 126;
export const groupHeaderHeight = 32;
export function inputHasFocus(): boolean {
    const active = document.activeElement;
    return active instanceof HTMLElement && !!active.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}
export function layoutRows(ids: string[], heights: Map<string, number>, estimate = 126) { let top = 0; return ids.map(id => { const row = { id, top, height: heights.get(id) ?? estimate }; top += row.height; return row; }); }
export function layoutGroups(groups: SessionGroup[], heights: Map<string, number>) {
    let top = 0, index = 0;
    return groups.map(group => {
        const header = group.label ? groupHeaderHeight : 0;
        const rows = layoutRows(group.ids, heights).map(row => ({ ...row, top: row.top + header, index: index++ }));
        const height = rows.length ? rows.at(-1)!.top + rows.at(-1)!.height : header;
        const result = { ...group, top, height, header, rows }; top += height;
        return result;
    });
}
export function VirtualList({ ids, groups, expanded, focusRequest, render }: {
    ids: string[];
    groups?: SessionGroup[];
    expanded: string | null;
    focusRequest?: { id: string | null; sequence: number } | null;
    render: (id: string) => ReactNode;
}) {
    const { t } = useI18n();
    const host = useRef<HTMLDivElement>(null), heights = useRef(new Map<string, number>());
    const handledFocusRequest = useRef<typeof focusRequest>(null);
    const [viewport, setViewport] = useState({ top: 0, height: 600 });
    const [epoch, setEpoch] = useState(0);
    const sections = layoutGroups(groups ?? [{ label: "", ids }], heights.current);
    const rows = sections.flatMap(group => group.rows.map(row => ({ ...row, top: row.top + group.top, header: group.header })));
    const total = sections.length ? sections.at(-1)!.top + sections.at(-1)!.height : 0;
    const scrollTo = (top: number) => {
        if (!host.current) return;
        host.current.scrollTop = Math.max(0, top);
        setViewport(v => ({ ...v, top: host.current!.scrollTop }));
    };
    useLayoutEffect(() => {
        const row = rows.find(r => r.id === expanded);
        if (row) scrollTo(row.top - row.header);
    }, [expanded]);
    useLayoutEffect(() => {
        if (!focusRequest || handledFocusRequest.current === focusRequest) return;
        handledFocusRequest.current = focusRequest;
        if (inputHasFocus()) return;
        const row = rows.find(r => r.id === focusRequest?.id), node = host.current;
        if (!row || !node) return;
        const height = node.clientHeight || 600;
        if (row.top < node.scrollTop + row.header) scrollTo(row.top - row.header);
        else if (row.top + Math.min(row.height, estimate) > node.scrollTop + height)
            scrollTo(row.top + Math.min(row.height, estimate) - height);
        // The requested row is retained below, even before scrolling renders its neighbours.
        Array.from(node.querySelectorAll<HTMLElement>("[data-row-id]")).find(el => el.dataset.rowId === row.id)
            ?.querySelector<HTMLButtonElement>(".session-toggle")?.focus({ preventScroll: true });
    }, [focusRequest]);
    useLayoutEffect(() => {
        const node = host.current; if (!node) return;
        const update = () => setViewport({ top: node.scrollTop, height: node.clientHeight || 600 });
        update(); const observer = new ResizeObserver(update); observer.observe(node); return () => observer.disconnect();
    }, []);
    const focused = host.current?.querySelector<HTMLElement>(":focus")?.closest<HTMLElement>("[data-row-id]")?.dataset.rowId;
    const visible = new Set(rows.filter(r => (r.top + r.height > viewport.top - 350 && r.top < viewport.top + viewport.height + 350)
        || r.id === focused || r.id === focusRequest?.id || r.id === expanded).map(r => r.id));
    const measure = (id: string, height: number) => {
        const old = heights.current.get(id) ?? estimate; if (Math.abs(old - height) < 1) return;
        const row = rows.find(r => r.id === id); heights.current.set(id, height);
        if (row && row.top < viewport.top && host.current) scrollTo(host.current.scrollTop + height - old);
        setEpoch(e => e + 1);
    };
    useEffect(() => { if (host.current && viewport.top > total) scrollTo(total - viewport.height); }, [total, viewport.top, viewport.height]);
    return <div className="virtual-list" ref={host} onScroll={e => setViewport({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight || 600 })}
        role="list" aria-label={t("sessionListCount", ids.length)} data-epoch={epoch}>
        <div style={{ height: total, position: "relative" }}>{sections.map(group => {
            const rendered = group.rows.filter(row => visible.has(row.id));
            if (!rendered.length) return null;
            return <div key={group.label} className="session-group" role="presentation" style={{ position: "absolute", top: group.top, height: group.height, left: 0, right: 0 }}>
                {group.label && <h3 className="group-heading" style={{ height: groupHeaderHeight }}>{t(group.label as "today" | "yesterday" | "thisWeek" | "earlier")}</h3>}
                {rendered.map(row => <MeasuredRow key={row.id} id={row.id} top={row.top} index={row.index} count={ids.length} measure={measure}>{render(row.id)}</MeasuredRow>)}
            </div>;
        })}</div>
    </div>;
}
function MeasuredRow({ id, top, index, count, measure, children }: {
    id: string;
    top: number;
    index: number;
    count: number;
    measure: (id: string, h: number) => void;
    children: ReactNode;
}) { const ref = useRef<HTMLDivElement>(null); const cb = useRef(measure); cb.current = measure; useLayoutEffect(() => { const node = ref.current; if (!node)
    return; const observer = new ResizeObserver(entries => { const height = entries[0]?.borderBoxSize?.[0]?.blockSize ?? node.getBoundingClientRect().height; if (height > 0)
    cb.current(id, height); }); observer.observe(node); return () => observer.disconnect(); }, [id]); return <div ref={ref} role="listitem" aria-posinset={index + 1} aria-setsize={count} data-row-id={id} style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${top}px)` }}>{children}</div>; }
