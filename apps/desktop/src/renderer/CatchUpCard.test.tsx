import type { ReactElement, ReactNode } from "react";
import { LanguageContext } from "../shared/i18n/react";
import { fireEvent, render as renderUI, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { CatchUp } from "@aimspan/protocol";
import { CatchUpCard, Reply } from "./CatchUpCard";
import { IdeaEditor } from "./IdeasView";
import { session } from "../../test/panel-fixtures";
const catchup: CatchUp = { activity: [], activityIncomplete: false, anchor: "2026-10-16T08:00:00Z", state: "waiting", durationMsOfCurrentOrLastTurn: 360000, turnsSinceAnchor: 2,
    pendingIdeas: [], awaySummary: "离开时完成了检查", lastAgentMessage: { body: "**完成**", fromBeforeAnchor: true }, truncated: true, factsIncomplete: true,
    errors: ["本轮中断"], changedFiles: ["src/example.ts"], failedCommands: ["pnpm test"] };

beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
const cardProps = { session: session("a", { lastTurnEndAt: "2026-10-16T08:00:00Z" }), now: Date.parse("2026-10-16T08:08:00Z"), ideas: <p>待用原文</p>, onLink: vi.fn() };

test("T22 waiting card leads with the result below the away summary and collapses activity", () => {
    const activity: CatchUp["activity"] = [
        { at: "2026-10-16T08:07:00Z", kind: "message", text: "正在检查键盘操作\n第二行不显示" },
        { at: "2026-10-16T08:06:00Z", kind: "command", text: "pnpm test", failed: true },
        { at: "2026-10-16T08:05:00Z", kind: "file", text: "src/example.ts" },
        { at: "2026-10-16T08:04:00Z", kind: "error", text: "本轮中断" },
        { at: "2026-10-16T08:03:00Z", kind: "command", text: "pnpm typecheck", failed: false },
        { at: "2026-10-16T08:02:00Z", kind: "message", text: "第六条不显示" },
    ];
    const { container } = render(<CatchUpCard {...cardProps} catchup={{ ...catchup, activity, activityIncomplete: true }}/>);
    expect(Array.from(container.querySelectorAll("[data-section]"), node => node.getAttribute("data-section"))).toEqual(["ideas", "result", "away", "reply", "activity"]);
    expect(screen.queryByRole("heading", { name: "最近动态" })).toBeNull();
    expect(screen.getByText("完成")).toBeVisible();
    expect(screen.getByText("pnpm test")).not.toBeVisible();
    expect(container.querySelector("details[data-section=activity]")).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("过程 · 5 条"));
    expect(screen.getByRole("heading", { name: "执行结果" })).toBeVisible();
    expect(screen.getByText("耗时 6 分钟")).toBeVisible();
    expect(container.querySelectorAll(".activity-list li")).toHaveLength(5);
    expect(Array.from(container.querySelectorAll(".activity-list time"), node => node.textContent)).toEqual(["1 分钟前", "2 分钟前", "3 分钟前", "4 分钟前", "5 分钟前"]);
    for (const name of ["消息", "命令", "文件", "错误或中断"]) expect(screen.getAllByRole("img", { name }).length).toBeGreaterThan(0);
    expect(screen.getByText("pnpm test").closest("li")).toHaveClass("activity-failed");
    expect(screen.getByText("pnpm typecheck").closest("li")).not.toHaveClass("activity-failed");
    expect(screen.getAllByText("失败")).toHaveLength(1);
    expect(screen.queryByText(/第二行不显示|第六条不显示/)).toBeNull();
    expect(screen.getByText("更早的动态未读取")).toBeVisible();
    expect(container.textContent).not.toMatch(/锚点|上次查看后|当前状态|改了 1 个文件|1 个命令失败|1 个错误/);
    expect(screen.getByText("离开摘要 · Claude 生成")).toBeVisible();
    expect(container.querySelector("strong")).toHaveTextContent("完成");
    expect(screen.getByText("完成")).toBeVisible();
    expect(screen.getByText("回复已截断，完整内容请在原 App 查看")).toBeVisible();
});
test("activity message preview is the first 80 Unicode characters", () => {
    render(<CatchUpCard {...cardProps} catchup={{ ...catchup, activity: [{ kind: "message", at: catchup.anchor!, text: "😀".repeat(81) + "\n第二行" }] }}/>);
    fireEvent.click(screen.getByText("过程 · 1 条"));
    expect(screen.getByText("😀".repeat(80))).toBeVisible();
    expect(screen.queryByText(/第二行/)).toBeNull();
});
test.each([30_000, 360_000])("T24 running activity never shows the previous result or duration at %i ms", duration => {
    const running = session("a", { state: "running", lastPromptAt: new Date(cardProps.now - duration).toISOString(), lastTurnEndAt: "2026-10-16T07:00:00Z" });
    const value = { ...catchup, state: "running" as const, durationMsOfCurrentOrLastTurn: duration, errors: [], changedFiles: [], failedCommands: [] };
    const { container } = render(<CatchUpCard {...cardProps} session={running} catchup={value}/>);
    expect(screen.getByRole("heading", { name: "最近动态" })).toBeVisible();
    expect(screen.queryByText(/耗时/)).toBeNull();
    expect(screen.queryByText("完成")).toBeNull();
    expect(screen.queryByText("离开摘要 · Claude 生成")).toBeNull();
    expect(container.querySelector("details")).toBeNull();
    expect(screen.getByText("暂无可读取的动态")).toBeVisible();
});
test.each(["waiting", "idle"] as const)("T13 R3 ended %s turn retains its duration", state => {
    const { container } = render(<CatchUpCard {...cardProps} session={{ ...cardProps.session, state }} catchup={{ ...catchup, state }}/>);
    expect(container.querySelector(".result-heading")).toHaveTextContent("耗时 6 分钟");
    expect(screen.getByText("完成")).toBeVisible();
    expect(container.querySelector("details[data-section=activity]")).not.toHaveAttribute("open");
});
test.each(["lines", "paragraph"])("reply clamps rendered height, including a long %s, and preserves safe Markdown", kind => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(240);
    const body = kind === "lines" ? Array.from({ length: 9 }, (_, i) => `第 ${i + 1} 行`).join("\n\n") : "没有换行的长段落。".repeat(80);
    const { container } = render(<Reply body={body + '\n<script>alert(1)</script>\n<img src="https://example.com/a.png">\n![external](https://example.com/b.png)'} onLink={vi.fn()}/>);
    expect(container.querySelector(".reply-body")).toHaveClass("reply-clamped");
    expect(container.querySelector(".reply-body")).toHaveClass("reply-faded");
    expect(screen.getByRole("button", { name: "展开全文" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "展开全文" }));
    expect(container.querySelector(".reply-body")).not.toHaveClass("reply-clamped");
    expect(container.querySelector("script, img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "收起全文" }));
    expect(container.querySelector(".reply-body")).toHaveClass("reply-clamped");
});
test("reply is bounded to 20,000 characters without splitting emoji; short replies need no toggle", () => {
    const { container, rerender } = render(<Reply body={"😀".repeat(20_000) + "超出上限"} onLink={vi.fn()}/>);
    expect(container.querySelector(".reply-body")?.textContent).toBe("😀".repeat(20_000));
    rerender(<Reply body="简短回复" onLink={vi.fn()}/>);
    expect(screen.queryByRole("button", { name: "展开全文" })).toBeNull();
    // A reply that fits is never faded.
    expect(container.querySelector(".reply-body")).not.toHaveClass("reply-faded");
});
test("focusing a link reveals clipped content without opening the link", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(240);
    const open = vi.fn();
    render(<Reply body={"长段落。".repeat(80) + "\n\n[链接](https://example.com)"} onLink={open}/>);
    fireEvent.focus(screen.getByRole("link", { name: "链接" }));
    expect(screen.getByRole("button", { name: "收起全文" })).toHaveAttribute("aria-expanded", "true");
    expect(open).not.toHaveBeenCalled();
});
test("T21 empty activity has an explicit empty state, no progress/counters and no inferred gap note", () => {
    const { lastAgentMessage: _reply, ...empty } = catchup;
    const { container } = render(<CatchUpCard {...cardProps} catchup={{ ...empty, awaySummary: "", durationMsOfCurrentOrLastTurn: null }}/>);
    expect(screen.getByText("尚无可读取的回复")).toBeVisible();
    expect(screen.getByText("暂无可读取的动态")).not.toBeVisible();
    fireEvent.click(screen.getByText("过程 · 0 条"));
    expect(screen.getByText("暂无可读取的动态")).toBeVisible();
    expect(screen.queryByText(/上次查看后|更早的动态未读取|详情/)).toBeNull();
    expect(container.querySelector(".result-heading")).toHaveTextContent(/^执行结果$/);
    expect(container.querySelector('[data-section=away]')).toBeNull();
    expect(screen.getByText("尚无可读取的回复")).toBeVisible();
});
test("activity loading never reports an empty history", () => {
    render(<CatchUpCard {...cardProps} catchup={null}/>);
    expect(screen.getByText("正在读取衔接卡…")).toBeVisible();
    expect(screen.queryByText("暂无可读取的动态")).toBeNull();
});
test("links cross the Main API only on click with allowed schemes", () => {
    const open = vi.fn();
    render(<Reply body={'[网站](https://example.com) [线程](codex://threads/a) [Claude](claude://test) [文件](file:///tmp/test) [脚本](javascript:alert)'} onLink={open}/>);
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: "线程" }));
    expect(open).toHaveBeenCalledExactlyOnceWith("codex://threads/a");
    expect(screen.queryByRole("link", { name: "文件" })).toBeNull();
    expect(screen.queryByRole("link", { name: "脚本" })).toBeNull();
});
test("Enter saves, Shift Enter and every IME indicator leave composition untouched", () => {
    const save = vi.fn();
    render(<IdeaEditor body="中文想法" editing={false} saving={false} onDraft={vi.fn()} onSave={save} onCancel={vi.fn()}/>);
    const input = screen.getByRole("textbox", { name: "添加想法" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    fireEvent.compositionStart(input); fireEvent.keyDown(input, { key: "Enter" });
    expect(save).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input); fireEvent.keyDown(input, { key: "Enter" });
    expect(save).toHaveBeenCalledOnce();
});

test("T22 running shows only the newest five activities; waiting reveals the result and collapses the process", () => {
    const activity: CatchUp["activity"] = Array.from({ length: 6 }, (_, index) => ({ kind: "message", at: `2026-10-16T08:0${7 - index}:00Z`, text: `动态 ${index}` }));
    const { container, rerender } = render(<CatchUpCard {...cardProps} session={{ ...cardProps.session, state: "running" }} catchup={{ ...catchup, activity, activityIncomplete: true }}/>);
    expect(screen.getByText("动态 0")).toBeVisible();
    expect(screen.getByText("动态 4")).toBeVisible();
    expect(screen.queryByText("动态 5")).toBeNull();
    expect(container.querySelectorAll(".activity-list li")).toHaveLength(5);
    expect(screen.queryByText("完成")).toBeNull();
    expect(screen.getByRole("heading", { name: "最近动态" })).toBeVisible();
    expect(screen.getByText("更早的动态未读取")).toBeVisible();
    rerender(<CatchUpCard {...cardProps} catchup={{ ...catchup, activity }}/>);
    expect(screen.getByText("完成")).toBeVisible();
    expect(screen.getByText("动态 0")).not.toBeVisible();
    expect(screen.getByText("过程 · 5 条")).toBeVisible();
    expect(screen.getByRole("heading", { name: "执行结果" })).toBeVisible();
});

test("T24 unknown keeps a readable known result without claiming completion or a duration", () => {
    const { container } = render(<CatchUpCard {...cardProps} session={{ ...cardProps.session, state: "unknown" }} catchup={catchup}/>);
    expect(container.querySelector(".result-heading")).toHaveTextContent(/^执行结果$/);
    expect(screen.queryByText(/耗时/)).toBeNull();
    expect(screen.getByText("完成")).toBeVisible();
    expect(container.querySelector("details[data-section=activity]")).not.toHaveAttribute("open");
});

test("T24 waiting for input in an open turn never presents the previous turn's duration as its result", () => {
    const { container } = render(<CatchUpCard {...cardProps} session={{ ...cardProps.session, lastPromptAt: "2026-10-16T08:05:00Z" }} catchup={catchup}/>);
    expect(container.querySelector(".result-heading")).toHaveTextContent(/^执行结果$/);
    expect(screen.queryByText(/耗时/)).toBeNull();
    expect(screen.getByText("完成")).toBeVisible();
});

test("T22 replies fit through eight rendered lines and expand above that boundary", () => {
    const computedStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation(element => {
        const style = computedStyle(element); style.lineHeight = "20px"; style.fontSize = "14px"; return style;
    });
    const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(160);
    const { rerender } = render(<Reply body="八行以内" onLink={vi.fn()}/>);
    expect(screen.queryByRole("button", { name: "展开全文" })).toBeNull();
    height.mockReturnValue(180);
    rerender(<Reply body="九行内容" onLink={vi.fn()}/>);
    expect(screen.getByRole("button", { name: "展开全文" })).toBeVisible();
});

function render(ui: ReactElement) { return renderUI(ui, { wrapper: ({ children }: { children: ReactNode }) => <LanguageContext.Provider value="zh">{children}</LanguageContext.Provider> }); }
