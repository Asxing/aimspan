import type { MenuItemConstructorOptions } from "electron";
import { DEFAULT_SETTINGS, type Settings } from "@aimspan/protocol";
import { translator } from "../shared/i18n";

export function trayMenuTemplate(settings: Pick<Settings, "language" | "captureShortcut" | "bubbleEnabled">, actions: {
    open(): void; capture(): void; showBubble(enabled: boolean): void; settings(): void; quit(): void;
}): MenuItemConstructorOptions[] {
    const t = translator(settings.language);
    const shortcut = settings.captureShortcut ?? DEFAULT_SETTINGS.captureShortcut;
    return [
        { label: t("openSessions"), click: actions.open },
        { label: t("quickCapture"), ...(shortcut ? { accelerator: shortcut } : {}), registerAccelerator: false, click: actions.capture },
        { label: t("showBubble"), type: "checkbox", checked: settings.bubbleEnabled !== false, click: item => actions.showBubble(item.checked) },
        { type: "separator" },
        { label: t("traySettings"), click: actions.settings },
        { label: t("quit"), click: actions.quit },
    ];
}
