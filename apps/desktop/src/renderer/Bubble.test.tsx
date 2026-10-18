import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { BubbleState, CompactState } from "@aimspan/protocol";
import { session } from "../../test/panel-fixtures";
import { Bubble } from "./Bubble";
import { Compact } from "./Compact";
import { statusSymbols } from "../status-symbols";
test("T21 compact tags, versioned pin/handled actions, header pin and IME-safe Escape", async () => {
    let publish: (state: CompactState) => void = () => {};
    const state: CompactState = { language: "zh", sessions: [session("a", { surface: "desktop", revision: 8 }),
        session("b", { agent: "claude-code", surface: "cli", pinned: true, state: "idle" })], pinned: false };
    window.aimspanCompact = { getState: vi.fn(async () => state), subscribe: callback => { publish = callback; return () => {}; },
        hover: vi.fn(async () => {}), openSession: vi.fn(async () => {}), capture: vi.fn(async () => {}), newSession: vi.fn(async () => {}),
        pinSession: vi.fn(async () => {}), handleSession: vi.fn(async () => {}), togglePinned: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    render(<Compact/>);
    expect(await screen.findByText("Codex 桌面")).toBeVisible();
    expect(screen.getByText("Claude CLI")).toBeVisible();
    const pin = screen.getByRole("button", { name: "钉住 会话 a" });
    fireEvent.click(pin);
    expect(window.aimspanCompact.pinSession).toHaveBeenCalledExactlyOnceWith({ sessionId: "a", pinned: true, expectedRevision: 8, operationId: expect.any(String) });
    expect(window.aimspanCompact.openSession).not.toHaveBeenCalled();
    await waitFor(() => expect(pin).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "取消钉住 会话 b" }));
    expect(window.aimspanCompact.pinSession).toHaveBeenLastCalledWith({ sessionId: "b", pinned: false, expectedRevision: 1, operationId: expect.any(String) });
    const handled = screen.getByRole("button", { name: "标记 会话 a 已处理" });
    expect(screen.queryByRole("button", { name: "标记 会话 b 已处理" })).toBeNull();
    await waitFor(() => expect(handled).not.toBeDisabled());
    fireEvent.click(handled); fireEvent.click(handled);
    expect(window.aimspanCompact.handleSession).toHaveBeenCalledExactlyOnceWith({ sessionId: "a", expectedRevision: 8, operationId: expect.any(String) });
    fireEvent.click(screen.getByRole("button", { name: "钉住紧凑列表" }));
    expect(window.aimspanCompact.togglePinned).toHaveBeenCalledOnce();
    act(() => publish({ ...state, pinned: true, sessions: state.sessions.map(s => ({ ...s, state: "idle" })) }));
    expect(screen.getByRole("button", { name: "取消钉住紧凑列表" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "标记 会话 a 已处理" })).toBeNull();
    fireEvent.keyDown(pin, { key: "Escape", isComposing: true });
    fireEvent.keyDown(pin, { key: "Escape", keyCode: 229 });
    fireEvent.compositionStart(pin); fireEvent.keyDown(pin, { key: "Escape" });
    expect(window.aimspanCompact.close).not.toHaveBeenCalled();
    fireEvent.compositionEnd(pin); fireEvent.keyDown(pin, { key: "Escape" });
    expect(window.aimspanCompact.close).toHaveBeenCalledOnce();
});

test("failed compact mutations remain visible with a retryable error", async () => {
    const state: CompactState = { language: "zh", sessions: [session()], pinned: false };
    window.aimspanCompact = { getState: vi.fn(async () => state), subscribe: () => () => {},
        hover: vi.fn(async () => {}), openSession: vi.fn(async () => {}), capture: vi.fn(async () => {}), newSession: vi.fn(async () => {}),
        pinSession: vi.fn(async () => { throw new Error("core.errorRecordChangedReloadBeforeSaving"); }), handleSession: vi.fn(async () => {}), togglePinned: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    render(<Compact/>);
    const pin = await screen.findByRole("button", { name: "钉住 会话 a" });
    fireEvent.click(pin);
    expect(await screen.findByRole("alert")).toHaveTextContent("记录已变化，请重新读取后保存");
    expect(pin).not.toBeDisabled();
    expect(window.aimspanCompact.close).not.toHaveBeenCalled();
});
test("bubble updates counts/ring/pulse from Main, with zero hidden and hover independent of focus", async () => {
    let publish: (state: BubbleState) => void = () => {};
    const initial: BubbleState = { language: "zh", waiting: 0, running: 0, pulse: 0, side: "right", circleX: 84, revealed: false, open: false, pinned: false };
    window.aimspanBubble = { getState: vi.fn(async () => initial), subscribe: callback => { publish = callback; return () => {}; },
        hover: vi.fn(async () => {}), pointer: vi.fn(async () => {}), toggle: vi.fn(async () => {}), menu: vi.fn(async () => {}) };
    const { container } = render(<Bubble/>);
    const button = await screen.findByRole("button", { name: "0 个运行中 · 0 个等你" });
    expect(button).toHaveClass("dimmed"); expect(button).toHaveTextContent("");
    fireEvent.mouseEnter(button); expect(window.aimspanBubble.hover).toHaveBeenCalledWith(true);
    act(() => publish({ ...initial, waiting: 3, running: 1, pulse: 42, circleX: 56, revealed: true, open: true }));
    expect(button).toHaveAccessibleName("1 个运行中 · 3 个等你"); expect(Array.from(container.querySelectorAll(".bubble-count"), node => node.textContent)).toEqual(["1", "3"]); expect(button).not.toHaveClass("dimmed");
    expect(button).toHaveClass("waiting"); expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveAttribute("title", "1 个运行中 · 3 个等你");
    expect(container.querySelector(".bubble-count.running")).toHaveStyle({ color: statusSymbols.running.color });
    expect(container.querySelector(".bubble-count.waiting")).toHaveStyle({ color: statusSymbols.waiting.color });
    expect(container.querySelector(".bubble-ring")).toHaveClass("running"); expect(container.querySelector(".bubble-pulse")).not.toBeNull();
    act(() => publish({ ...initial, running: 2 }));
    expect(button).toHaveAccessibleName("2 个运行中 · 0 个等你");
    expect(button).toHaveTextContent("2"); expect(button).not.toHaveClass("dimmed", "waiting");
    expect(container.querySelector(".bubble-ring")).toHaveClass("running");
    act(() => publish({ ...initial, waiting: 1 }));
    expect(button).toHaveTextContent("1"); expect(button).toHaveClass("waiting");
    act(() => publish(initial));
    expect(button).toHaveTextContent(""); expect(button).toHaveClass("dimmed");
    expect(container.querySelector(".bubble-ring")).not.toHaveClass("running");
    fireEvent.mouseLeave(button); expect(window.aimspanBubble.hover).toHaveBeenCalledWith(false);
    fireEvent.contextMenu(button); expect(window.aimspanBubble.menu).toHaveBeenCalledOnce();
});
test("bubble reports buttons on pointer entry, uncaptured moves and non-primary buttons", async () => {
    const state: BubbleState = { language: "zh", waiting: 0, running: 0, pulse: 0, side: "right", circleX: 84, revealed: false, open: false, pinned: false };
    window.aimspanBubble = { getState: vi.fn(async () => state), subscribe: () => () => {},
        hover: vi.fn(async () => {}), pointer: vi.fn(async () => {}), toggle: vi.fn(async () => {}), menu: vi.fn(async () => {}) };
    render(<Bubble/>);
    const button = await screen.findByRole("button", { name: "0 个运行中 · 0 个等你" });
    button.hasPointerCapture = vi.fn(() => false);
    button.setPointerCapture = vi.fn();
    // MouseEvent supplies the standard pointer mouse fields in jsdom.
    const event = (type: string, buttons: number, which = 0) => fireEvent(button, new MouseEvent(type, { bubbles: true, screenX: 1430, screenY: 460, buttons, button: which }));
    event("pointerover", 1);
    expect(window.aimspanBubble.pointer).toHaveBeenLastCalledWith("move", { x: 1430, y: 460, buttons: 1 });
    event("pointermove", 1);
    expect(window.aimspanBubble.pointer).toHaveBeenCalledTimes(2);
    event("pointerdown", 2, 2);
    expect(window.aimspanBubble.pointer).toHaveBeenLastCalledWith("move", { x: 1430, y: 460, buttons: 2 });
    expect(button.setPointerCapture).not.toHaveBeenCalled();
    event("pointerup", 0, 2);
    expect(window.aimspanBubble.pointer).toHaveBeenLastCalledWith("move", { x: 1430, y: 460, buttons: 0 });
});
test("compact row opens the card, plus selects its target without opening the row, and footer explicitly selects inbox", async () => {
    const state: CompactState = { language: "zh", sessions: [session("a", { pendingIdeaCount: 2, lastTurnEndAt: new Date().toISOString() })], pinned: false };
    window.aimspanCompact = { getState: vi.fn(async () => state), subscribe: () => () => {}, hover: vi.fn(async () => {}), openSession: vi.fn(async () => {}), capture: vi.fn(async () => {}), newSession: vi.fn(async () => {}), pinSession: vi.fn(async () => {}), handleSession: vi.fn(async () => {}), togglePinned: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    render(<Compact/>);
    const plus = await screen.findByRole("button", { name: "为 会话 a 记想法" });
    fireEvent.click(plus); expect(window.aimspanCompact.capture).toHaveBeenCalledWith("a"); expect(window.aimspanCompact.openSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("会话 a")); expect(window.aimspanCompact.openSession).toHaveBeenCalledWith("a");
    expect(screen.getByText("会话 a").closest("button")).toHaveTextContent(/等你.*想法 2/);
    fireEvent.click(screen.getByRole("button", { name: "记到收件箱" })); expect(window.aimspanCompact.capture).toHaveBeenCalledWith(null);
    fireEvent.click(screen.getByRole("button", { name: "新会话" })); expect(window.aimspanCompact.newSession).toHaveBeenCalledOnce();
    fireEvent.keyDown(plus, { key: "Escape" }); await waitFor(() => expect(window.aimspanCompact.close).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "关闭紧凑列表" }));
    expect(window.aimspanCompact.close).toHaveBeenCalledTimes(2);
});
test("T11 compact rows share state wording and markers, with new-result emphasis and positive idea counts only", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-16T09:00:00Z"));
    const state: CompactState = { language: "zh", sessions: [
        session("a", { pendingIdeaCount: 2, lastTurnEndAt: "2026-10-16T08:48:00Z" }),
        session("b", { state: "running", hasNewResult: false, lastPromptAt: "2026-10-16T08:54:00Z" }),
    ], pinned: false };
    window.aimspanCompact = { getState: vi.fn(async () => state), subscribe: () => () => {}, hover: vi.fn(async () => {}), openSession: vi.fn(async () => {}), capture: vi.fn(async () => {}), newSession: vi.fn(async () => {}), pinSession: vi.fn(async () => {}), handleSession: vi.fn(async () => {}), togglePinned: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const { container } = render(<Compact/>);
    await screen.findByText("会话 a");
    expect(screen.getByText("会话 a").closest("button")).toHaveTextContent("等你 12 分钟 · 想法 2");
    expect(screen.getByText("会话 b").closest("button")).toHaveTextContent("已运行 6 分钟");
    expect(screen.getByText("会话 a")).toHaveClass("has-new-result");
    expect(screen.getByText("会话 b")).not.toHaveClass("has-new-result");
    expect(container.querySelector('[data-compact-id="a"]')).toHaveClass("needs-you");
    expect(container.querySelector('[data-compact-id="b"]')).not.toHaveClass("needs-you");
    expect(container.querySelector('[data-compact-id="a"] .state-marker')).toHaveClass("waiting");
    expect(container.querySelector('[data-compact-id="b"] .state-marker')).toHaveClass("running");
    expect(container.querySelectorAll(".idea-badge")).toHaveLength(1);
    expect(screen.queryByText(/想法 0/)).toBeNull();
});

test("T15 compact fallback title keeps its tooltip identity and original open/capture destination", async () => {
    const state: CompactState = { language: "zh", sessions: [session("a", { nativeId: "fixture-native", title: "fixture-native" })], pinned: false };
    window.aimspanCompact = { getState: vi.fn(async () => state), subscribe: () => () => {}, hover: vi.fn(async () => {}), openSession: vi.fn(async () => {}), capture: vi.fn(async () => {}), newSession: vi.fn(async () => {}), pinSession: vi.fn(async () => {}), handleSession: vi.fn(async () => {}), togglePinned: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    render(<Compact/>);
    const title = await screen.findByText("未命名会话");
    expect(title).toHaveAttribute("title", "会话 ID：fixture-native");
    expect(screen.queryByText("fixture-native")).toBeNull();
    fireEvent.click(title);
    expect(window.aimspanCompact.openSession).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getByRole("button", { name: "为 未命名会话 记想法" }));
    expect(window.aimspanCompact.capture).toHaveBeenCalledWith("a");
});

test("T23 bubble and compact render English and update while already open", async () => {
    let bubbleChanged: (state: BubbleState) => void = () => {};
    let compactChanged: (state: CompactState) => void = () => {};
    const bubble: BubbleState = { language: "en", waiting: 6, running: 2, pulse: 0, side: "right", circleX: 0, revealed: true, open: true, pinned: false };
    const compact: CompactState = { language: "en", pinned: false, sessions: [session("a", { surface: "desktop", pendingIdeaCount: 2, state: "running", lastPromptAt: new Date(Date.now() - 180_000).toISOString() })] };
    window.aimspanBubble = { getState: async () => bubble, subscribe: callback => { bubbleChanged = callback; return () => {}; }, hover: vi.fn(), pointer: vi.fn(), toggle: vi.fn(), menu: vi.fn() };
    window.aimspanCompact = { getState: async () => compact, subscribe: callback => { compactChanged = callback; return () => {}; }, hover: vi.fn(), openSession: vi.fn(), capture: vi.fn(), newSession: vi.fn(), pinSession: vi.fn(), handleSession: vi.fn(), togglePinned: vi.fn(), close: vi.fn() };
    render(<><Bubble/><Compact/></>);
    expect(await screen.findByRole("button", { name: "2 running · 6 waiting" })).toBeVisible();
    expect(screen.getByText("Codex Desktop")).toBeVisible();
    expect(screen.getByText("· 2 ideas")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save to inbox" })).toBeVisible();
    expect(screen.getByRole("button", { name: "New session" })).toBeVisible();
    act(() => { bubbleChanged({ ...bubble, language: "zh" }); compactChanged({ ...compact, language: "zh" }); });
    expect(screen.getByRole("button", { name: "2 个运行中 · 6 个等你" })).toBeVisible();
    expect(screen.getByText("Codex 桌面")).toBeVisible();
    expect(screen.getByRole("button", { name: "记到收件箱" })).toBeVisible();
});
