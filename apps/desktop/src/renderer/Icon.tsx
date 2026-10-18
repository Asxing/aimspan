import type { ReactNode } from "react";

const paths = {
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></>,
    pin: <><path d="M9 4h6l-1 5 3 3v2H7v-2l3-3z"/><path d="M12 14v6"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="m10 3-.5 2.5-2 1.2-2.4-.8-2 3.4L5 11v2l-1.9 1.7 2 3.4 2.4-.8 2 1.2.5 2.5h4l.5-2.5 2-1.2 2.4.8 2-3.4L19 13v-2l1.9-1.7-2-3.4-2.4.8-2-1.2L14 3z"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    check: <path d="m5 12 5 5 9-10"/>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    more: <path d="M5 12h.01M12 12h.01M19 12h.01"/>,
    message: <path d="M4 5h16v11H8l-4 4z"/>,
    command: <><path d="m6 8 4 4-4 4"/><path d="M12 16h6"/></>,
    file: <><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></>,
    warning: <><path d="m12 3 10 18H2zM12 9v4M12 17h.01"/></>,
    chevron: <path d="m9 6 6 6-6 6"/>,
    back: <path d="m15 6-6 6 6 6"/>,
    dash: <path d="M5 12h14"/>,
} satisfies Record<string, ReactNode>;

/** Decorative only: the containing control or text owns its accessible label. */
export function Icon({ name, size = 16 }: { name: keyof typeof paths; size?: number }) {
    return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth={name === "more" ? 3 : 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
