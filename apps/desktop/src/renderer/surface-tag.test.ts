import { expect, test } from "vitest";
import { session } from "../../test/panel-fixtures";
import { surfaceTag } from "./surface-tag";

test.each(["codex", "claude-code"] as const)("surface tags for %s", agent => {
    const app = agent === "codex" ? "Codex" : "Claude";
    for (const [surface, suffix] of [["desktop", "桌面"], ["cli", "CLI"], ["vscode", "VS Code"], ["unknown", ""]] as const) {
        expect(surfaceTag(session("a", { agent, surface }), "zh")).toBe(suffix ? `${app} ${suffix}` : app);
    }
    expect(surfaceTag(session("a", { agent, surface: "automation" }), "zh")).toBe("自动");
    expect(surfaceTag(session("a", { agent, interactive: false }), "zh")).toBe("自动");
});
test.each([["openclaw", "OpenClaw"], ["aimspan", "AimSpan"], ["codex-chrome-extension-sidepanel", "Chrome 扩展"]])("client %s overrides generic surfaces", (entrypoint, label) => {
    for (const surface of ["unknown", "desktop", "cli", "vscode", "automation"] as const) {
        expect(surfaceTag(session("a", { entrypoint, surface }), "zh")).toBe(label);
    }
    expect(surfaceTag(session("a", { agent: "claude-code", entrypoint, surface: "cli" }), "zh")).toBe("Claude CLI");
});
test("unknown identifiers never leak raw entrypoints or inherited object properties", () => {
    for (const entrypoint of [undefined, "unrecognized-client", "toString", "constructor", "__proto__"]) {
        expect(surfaceTag(session("a", { entrypoint }), "zh")).toBe("Codex");
    }
    expect(surfaceTag(session("a", { entrypoint: "codex_exec" }), "zh")).toBe("自动");
});
