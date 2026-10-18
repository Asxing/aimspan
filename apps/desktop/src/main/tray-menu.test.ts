// @vitest-environment node
import type { MenuItemConstructorOptions } from "electron";
import { expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@aimspan/protocol";
import { trayMenuTemplate } from "./tray-menu";
import { trayTitle } from "./panel";
import { attentionTooltip } from "../status-symbols";
import { session } from "../../test/panel-fixtures";

const actions = () => ({ open: vi.fn(), capture: vi.fn(), showBubble: vi.fn(), settings: vi.fn(), quit: vi.fn() });
const click = (item: MenuItemConstructorOptions, checked = false) => item.click!({ checked } as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);

test.each([
    ["en", ["Open sessions", "Quick capture", "Show bubble", undefined, "Settings…", "Quit AimSpan"]],
    ["zh", ["打开会话列表", "快捷记录", "显示悬浮气泡", undefined, "设置…", "退出 AimSpan"]],
] as const)("%s tray follows the mockup order and retains explicit action handlers", (language, labels) => {
    const callbacks = actions();
    const menu = trayMenuTemplate({ ...DEFAULT_SETTINGS, language }, callbacks);
    expect(menu.map(item => item.label)).toEqual(labels);
    expect(menu[3]).toEqual({ type: "separator" });
    for (const index of [0, 1, 4, 5]) click(menu[index]!);
    for (const action of [callbacks.open, callbacks.capture, callbacks.settings, callbacks.quit]) expect(action).toHaveBeenCalledOnce();
    expect(callbacks.showBubble).not.toHaveBeenCalled();
});

test("Show bubble reflects the current setting and passes the checkbox's new state", () => {
    const callbacks = actions();
    const hidden = trayMenuTemplate({ ...DEFAULT_SETTINGS, bubbleEnabled: false }, callbacks);
    expect(hidden[2]).toMatchObject({ type: "checkbox", checked: false });
    click(hidden[2]!, true);
    expect(callbacks.showBubble).toHaveBeenLastCalledWith(true);
    const shown = trayMenuTemplate({ ...DEFAULT_SETTINGS, bubbleEnabled: true }, callbacks);
    expect(shown[2]).toMatchObject({ checked: true });
    click(shown[2]!, false);
    expect(callbacks.showBubble.mock.calls).toEqual([[true], [false]]);
    expect(trayMenuTemplate({ language: "en" }, callbacks)[2]).toMatchObject({ checked: true });
});

test("Quick capture displays the configured accelerator without registering a second shortcut", () => {
    const callbacks = actions();
    expect(trayMenuTemplate({ language: "en" }, callbacks)[1]).toMatchObject({ accelerator: "CommandOrControl+Shift+Space", registerAccelerator: false });
    expect(trayMenuTemplate({ language: "en", captureShortcut: "CommandOrControl+Shift+J" }, callbacks)[1])
        .toMatchObject({ accelerator: "CommandOrControl+Shift+J", registerAccelerator: false });
    const unset = trayMenuTemplate({ language: "en", captureShortcut: "" }, callbacks)[1]!;
    expect(unset).not.toHaveProperty("accelerator");
    click(unset);
    expect(callbacks.capture).toHaveBeenCalledOnce();
});

test("tray title keeps the native colored symbols and localized count description", () => {
    expect(trayTitle([session("a", { state: "running" }), session("b", { state: "waiting" })])).toBe("🟢1 🟠1");
    expect(attentionTooltip({ running: 2, waiting: 6 }, "en")).toBe("2 running · 6 waiting");
});
