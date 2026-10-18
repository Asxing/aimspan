// @vitest-environment node
import { expect, test } from "vitest";
import { resolveSourceRoots } from "./source-roots";

test("T7 F1 default source roots are agent homes and explicit fixture roots override independently", () => {
    const home = "/Users/__aimspan_fixture__";
    expect(resolveSourceRoots(home)).toEqual({ codex: `${home}/.codex`, claude: `${home}/.claude` });
    expect(resolveSourceRoots(home, { AIMSPAN_CODEX_ROOT: "/__aimspan_fixture__/codex" })).toEqual({ codex: "/__aimspan_fixture__/codex", claude: `${home}/.claude` });
    expect(resolveSourceRoots(home, { AIMSPAN_CLAUDE_ROOT: "/__aimspan_fixture__/claude" })).toEqual({ codex: `${home}/.codex`, claude: "/__aimspan_fixture__/claude" });
});
