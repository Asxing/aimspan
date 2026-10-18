import { expect, test } from "vitest";
import { session } from "../../test/panel-fixtures";
import { cardStatusLabel, elapsedLabel, sessionTimeLabel, timeAgo } from "./time-wording";

const now = Date.parse("2026-10-16T09:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

test("T19 card wording includes state, start clock or completion age, without inventing unknown evidence", () => {
    const localStart = new Date(2026, 9, 18, 14, 12), localNow = +localStart + 13 * 60_000;
    expect(cardStatusLabel(session("a", { state: "running", lastPromptAt: localStart.toISOString() }), 780_000, localNow, "zh"))
        .toBe("运行中 · 已运行 13 分钟（14:12 开始）");
    expect(cardStatusLabel(session("a", { state: "waiting", lastTurnEndAt: ago(480_000) }), 720_000, now, "zh")).toBe("等你 · 8 分钟前结束，耗时 12 分钟");
    expect(cardStatusLabel(session("a", { state: "idle", lastTurnEndAt: ago(7_200_000) }), null, now, "zh")).toBe("空闲 · 2 小时前结束");
    expect(cardStatusLabel(session("a", { state: "unknown", lastTurnEndAt: ago(480_000) }), 720_000, now, "zh")).toBe("状态待确认");
    expect(cardStatusLabel(session("a", { state: "running", lastPromptAt: "invalid" }), null, now, "zh")).toBe("运行中 · 时长待确认");
    expect(cardStatusLabel(session("a", { state: "waiting", lastActivityAt: ago(480_000) }), 720_000, now, "zh")).toBe("等你 8 分钟");
});

test.each([
    [0, "不到 1 分钟", "刚刚"], [59_999, "不到 1 分钟", "刚刚"],
    [60_000, "1 分钟", "1 分钟前"], [3_599_999, "59 分钟", "59 分钟前"],
    [3_600_000, "1 小时", "1 小时前"], [86_399_999, "23 小时", "23 小时前"],
    [86_400_000, "1 天", "1 天前"], [172_800_000, "2 天", "2 天前"],
])("duration and timestamp wording at %i ms", (ms, duration, relative) => {
    expect(elapsedLabel(ms, "zh")).toBe(duration);
    expect(timeAgo(ago(ms), now, "zh")).toBe(relative);
});

test("future timestamps clamp to just now; missing evidence stays unconfirmed", () => {
    expect(timeAgo(ago(-3_600_000), now, "zh")).toBe("刚刚");
    expect(elapsedLabel(-3_600_000, "zh")).toBe("不到 1 分钟");
    expect(timeAgo(undefined, now, "zh")).toBe("时间待确认");
    expect(timeAgo("invalid", now, "zh")).toBe("时间待确认");
    expect(elapsedLabel(NaN, "zh")).toBe("时长待确认");
    expect(timeAgo("1970-01-01T00:00:00Z", 0, "zh")).toBe("刚刚");
});

test("rows use prompt for running, end for waiting/idle, and no time for unknown", () => {
    expect(sessionTimeLabel(session("a", { state: "running", lastPromptAt: ago(360_000) }), now, "zh")).toBe("已运行 6 分钟");
    expect(sessionTimeLabel(session("a", { lastTurnEndAt: ago(720_000) }), now, "zh")).toBe("等你 12 分钟");
    expect(sessionTimeLabel(session("a", { state: "idle", lastTurnEndAt: ago(7_200_000), lastActivityAt: ago(0) }), now, "zh")).toBe("2 小时前结束");
    expect(sessionTimeLabel(session("a", { state: "unknown", lastTurnEndAt: ago(60_000) }), now, "zh")).toBe("状态待确认");
    expect(sessionTimeLabel(session("a", { state: "running" }), now, "zh")).toBe("运行中 · 时长待确认");
    expect(sessionTimeLabel(session("a", { state: "idle", lastActivityAt: ago(60_000) }), now, "zh")).toBe("空闲 · 结束时间待确认");
    expect(sessionTimeLabel(session("a", { lastActivityAt: ago(60_000) }), now, "zh")).toBe("等你 1 分钟");
    expect(sessionTimeLabel(session("a", { lastActivityAt: undefined, observedAt: ago(120_000) }), now, "zh")).toBe("等你 2 分钟");
});

test.each([0, -3_600_000])("recent and future rows stay grammatical (%i)", ms => {
    expect(sessionTimeLabel(session("a", { state: "running", lastPromptAt: ago(ms) }), now, "zh")).toBe("刚刚开始运行");
    expect(sessionTimeLabel(session("a", { lastTurnEndAt: ago(ms) }), now, "zh")).toBe("刚刚开始等你");
    expect(sessionTimeLabel(session("a", { state: "idle", lastTurnEndAt: ago(ms) }), now, "zh")).toBe("刚刚结束");
});

test("T19 review: waiting inside an open turn never claims the previous turn's completion", () => {
    const now = Date.parse("2026-10-18T14:12:00Z");
    const label = cardStatusLabel({ state: "waiting", lastPromptAt: "2026-10-18T14:10:00Z", lastTurnEndAt: "2026-10-18T14:00:00Z" } as never, 120_000, now, "zh");
    expect(label).toBe("等你 · 等待输入或批准（本轮已进行 2 分钟）");
    expect(cardStatusLabel({ state: "waiting", lastPromptAt: "2026-10-18T13:50:00Z", lastTurnEndAt: "2026-10-18T14:00:00Z" } as never, 600_000, now, "zh")).toMatch(/^等你 · 12 分钟前结束，耗时 10 分钟$/);
});

test("T23 English row and card wording matches the design", () => {
    const running = session("a", { state: "running", lastPromptAt: ago(180_000) });
    const waiting = session("b", { state: "waiting", lastTurnEndAt: ago(480_000) });
    const idle = session("c", { state: "idle", lastTurnEndAt: ago(7_200_000) });
    expect(sessionTimeLabel(running, now, "en")).toBe("Running · 3 min");
    expect(cardStatusLabel(running, null, now, "en")).toBe("Running · 3 min");
    expect(sessionTimeLabel(waiting, now, "en")).toBe("Waiting · ended 8 min ago");
    expect(cardStatusLabel(waiting, 720_000, now, "en")).toBe("Waiting · ended 8 min ago");
    expect(sessionTimeLabel(idle, now, "en")).toBe("Ended 2 h ago");
    expect(cardStatusLabel(idle, 720_000, now, "en")).toBe("Idle · 2 h ago");
    expect(sessionTimeLabel({ ...waiting, lastTurnEndAt: "invalid" }, now, "en")).toBe("Waiting · duration unknown");
    expect(sessionTimeLabel({ ...waiting, lastPromptAt: "2026-10-16T10:00:00+02:00" }, now, "en")).toBe("Waiting · ended 8 min ago");
});
