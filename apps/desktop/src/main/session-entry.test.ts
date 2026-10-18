// @vitest-environment node
import { expect, test, vi } from "vitest";
import { newSessionHint, openNewSession } from "./session-entry";

test("Codex opens its registered desktop bundle and explains the manual new-session step", async () => {
    const shell = { openExternal: vi.fn(async () => {}) }, openBundle = vi.fn(async () => {});
    expect(await openNewSession("codex", shell, openBundle, "zh")).toEqual(newSessionHint("codex", "zh"));
    expect(newSessionHint("codex", "zh").message).toContain("⌘N");
    expect(openBundle).toHaveBeenCalledExactlyOnceWith("com.openai.codex");
    expect(shell.openExternal).not.toHaveBeenCalled();
});
test("Claude uses the explicit new-code entry and falls back to its bundle only on rejection", async () => {
    const shell = { openExternal: vi.fn(async () => {}) }, openBundle = vi.fn(async () => {});
    expect(await openNewSession("claude", shell, openBundle, "zh")).toEqual(newSessionHint("claude", "zh"));
    expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith("claude://code/new?source=desktop_action");
    expect(openBundle).not.toHaveBeenCalled();
    shell.openExternal.mockRejectedValue(new Error("No URL handler"));
    expect((await openNewSession("claude", shell, openBundle, "zh")).message).toContain("请手动新建");
    expect(openBundle).toHaveBeenCalledExactlyOnceWith("com.anthropic.claudefordesktop");
});
test.each(["codex", "claude"] as const)("%s launch failure still gives an honest clipboard/manual-open receipt", async app => {
    const shell = { openExternal: vi.fn(async () => { throw new Error("No URL handler"); }) };
    expect((await openNewSession(app, shell, async () => { throw new Error("App missing"); }, "zh")).message).toMatch(/已复制，无法打开 .* App，请手动新建/);
});

test("T23 R1 new-session success, manual entry and failures carry translatable references", async () => {
    const { renderMessage } = await import("../shared/i18n/messages");
    const shell = { openExternal: vi.fn(async () => { throw new Error("No handler"); }) };
    const fallback = await openNewSession("claude", shell, async () => {}, "zh");
    expect(fallback.messageRef).toEqual({ key: "newSessionManual", params: [{ key: "newClaudeHint" }] });
    expect(renderMessage("en", fallback)).toBe("Copied. Paste in Claude and press Enter (App opened; create a session manually)");
    const failed = await openNewSession("codex", shell, async () => { throw new Error("Missing app"); }, "zh");
    expect(failed.messageRef).toEqual({ key: "newSessionOpenFailed", params: [{ key: "codex" }] });
    expect(renderMessage("en", failed)).toBe("Copied. Could not open Codex. Create a session manually, paste and press Enter");
    expect(renderMessage("en", newSessionHint("claude", "zh"))).toBe("Copied. Paste in Claude and press Enter");
});
