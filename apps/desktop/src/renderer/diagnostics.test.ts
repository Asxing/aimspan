import { expect, test } from "vitest";
import { diagnosticView, sourceLabel } from "./diagnostics";

test("diagnostic codes translate and paths abbreviate homes with bounded middle truncation", () => {
    const path = "/Users/__aimspan_fixture__/.codex/sessions/" + "中文目录/".repeat(30) + "rollout-fixture.jsonl.zst";
    const value = diagnosticView({ code: "codex-read", path }, "zh");
    expect(value.label).toBe("Codex 记录暂不可读取");
    expect(value.path).toMatch(/^~\/.codex\/sessions\/.*….*rollout-fixture.jsonl.zst$/);
    expect(Array.from(value.path!)).toHaveLength(72);
    expect(diagnosticView({ code: "watch-fallback", path: "/Users/__aimspan_fixture__/.claude/projects" }, "zh")).toEqual({ label: "来源暂无法实时监测，将定期刷新", path: "~/.claude/projects" });
    expect(diagnosticView({ code: "claude.source.uncertain" }).label).toBe("Some Claude sources could not be confirmed");
    expect(diagnosticView({ code: "discovery.read" }, "zh").label).toBe("来源暂不可读取，已保留现有记录");
    expect(sourceLabel("user")).toBe("User message");
    expect(sourceLabel("agent", "zh")).toBe("Agent 输出");
});
