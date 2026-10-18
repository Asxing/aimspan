import { expect, test } from "vitest";
import { messageRef, messageResult, renderMessage } from "./messages";

test("message references keep fallback copy and translate nested refs without interpreting user text", () => {
    const result = messageResult("zh", messageRef("ideasCopied", 1,
        messageRef("claudeSessionHint", "settings 用户原文", "/__aimspan_fixture__/project")));
    expect(result.message).toBe("已复制 1 条想法，尚未发送。切到 Claude 会话：settings 用户原文 · /__aimspan_fixture__/project");
    expect(renderMessage("en", structuredClone(result))).toBe("Copied 1 idea; not sent. Switch to Claude session: settings 用户原文 · /__aimspan_fixture__/project");
    expect(renderMessage("zh-CN", result)).toBe(result.message);
    // @ts-expect-error References use catalog keys, not arbitrary strings.
    if (false) messageRef("missing.key");
    // @ts-expect-error Count parameters cannot be message references.
    if (false) messageRef("ideasCopied", messageRef("codex"), "opened");
    // @ts-expect-error Required parameters remain required for references.
    if (false) messageRef("ideasCopied", 1);
});

test("fallback-only and incompatible message references retain the fallback", () => {
    expect(renderMessage("en", { message: "fallback" })).toBe("fallback");
    expect(renderMessage("en", { message: "fallback", messageRef: { key: "future.catalog.key" } })).toBe("fallback");
    expect(renderMessage("en", { message: "fallback", messageRef: { key: "ideasCopied", params: [1, { key: "future.key" }] } })).toBe("fallback");
    expect(renderMessage("en", { message: "fallback", messageRef: { key: "ideasCopied", params: [1] } })).toBe("fallback");
});
