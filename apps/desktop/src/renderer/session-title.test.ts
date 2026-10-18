import { expect, test } from "vitest";
import { sessionTitle } from "./session-title";

test("missing titles and exact native/internal ID fallbacks never become readable titles", () => {
    const nativeId = "00000000-0000-4000-8000-000000000015", id = "local-session-15";
    for (const title of ["", " \n ", nativeId, ` ${nativeId} `, id]) {
        expect(sessionTitle({ id, nativeId, title }, "zh")).toBe("未命名会话");
    }
    const longId = "fixture-".repeat(20);
    expect(sessionTitle({ id, nativeId: longId, title: longId.slice(0, 120) }, "zh")).toBe("未命名会话");
    for (const title of ["修复导航", "  自定义标题  ", `排查 ${nativeId}`]) {
        expect(sessionTitle({ id, nativeId, title }, "zh")).toBe(title);
    }
});
