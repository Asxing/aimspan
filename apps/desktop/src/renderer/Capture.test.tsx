import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CAPTURE_DRAFT_KEY, CAPTURE_STALE_OPEN, NEW_SESSION_TARGETS, captureDraftKey, type CaptureApi, type CaptureContext } from "@aimspan/protocol";
import { session } from "../../test/panel-fixtures";
import { Capture } from "./Capture";
import { activeCaptureTargets, cycleCaptureTarget, defaultCaptureTarget, filterCaptureTargets } from "./capture-targets";

let context: CaptureContext, api: CaptureApi;
beforeEach(() => {
    context = { language: "zh", openId: 1, sessions: [session("a", { state: "running", lastPromptAt: new Date().toISOString() }), session("b"), session("old", { active: false })], inboxIdeaCount: 0, drafts: {} };
    api = { onLanguage: () => () => {}, newSession: vi.fn(async request => ({ message: `已复制，在 ${request.app === "codex" ? "Codex" : "Claude"} 中粘贴后回车`, brought: 1 })), getContext: vi.fn(async () => structuredClone(context)), saveIdea: vi.fn(async request => ({ ...request, id: "saved", status: "pending", revision: 1, createdAt: "2026-10-16", updatedAt: "2026-10-16" })),
        saveDraft: vi.fn(async request => { const key = CAPTURE_DRAFT_KEY; context.drafts[key] = { target: key, body: request.body, revision: (context.drafts[key]?.revision ?? 0) + 1, updatedAt: "2026-10-16" }; }), close: vi.fn(async () => {}) };
    window.aimspanCapture = api;
});
afterEach(() => vi.useRealTimers());
async function input() { render(<Capture/>); const input = await screen.findByRole("textbox", { name: "快捷记录想法" }); await waitFor(() => expect(input).toBeEnabled()); return input; }
test("default uses the latest running prompt within 30 minutes, with an inclusive boundary and no future/invalid timestamps", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-16T08:00:00Z"));
    const old = session("old", { state: "running", lastPromptAt: "2026-10-16T07:29:59.999Z" });
    const boundary = session("boundary", { state: "running", lastPromptAt: "2026-10-16T07:30:00Z" });
    const newest = session("new", { state: "running", lastPromptAt: "2026-10-16T07:59:00Z" });
    const ignored = [session("waiting", { lastPromptAt: "2026-10-16T08:00:00Z" }), session("future", { state: "running", lastPromptAt: "2026-10-16T08:00:01Z" }), session("bad", { state: "running", lastPromptAt: "invalid" })];
    expect(defaultCaptureTarget([old, ...ignored])).toBeNull();
    expect(defaultCaptureTarget([boundary, ...ignored])).toBe("boundary");
    expect(defaultCaptureTarget([old, newest, boundary, ...ignored])).toBe("new");
});
test("cycling wraps active targets, inbox, Codex and Claude; search includes inactive interactive roots and matches project/title", () => {
    const active = activeCaptureTargets(context.sessions, "zh");
    expect(active.map(t => t.id)).toEqual(["a", "b", null, NEW_SESSION_TARGETS.codex, NEW_SESSION_TARGETS.claude]);
    expect(cycleCaptureTarget(active, "a", -1)).toBe(NEW_SESSION_TARGETS.claude);
    expect(cycleCaptureTarget(active, null, 1)).toBe(NEW_SESSION_TARGETS.codex);
    expect(cycleCaptureTarget(active, NEW_SESSION_TARGETS.codex, 1)).toBe(NEW_SESSION_TARGETS.claude);
    expect(cycleCaptureTarget(active, NEW_SESSION_TARGETS.claude, 1)).toBe("a");
    expect(filterCaptureTargets(context.sessions, "新会话", "zh").map(t => t.id)).toEqual(Object.values(NEW_SESSION_TARGETS));
    expect(filterCaptureTargets(context.sessions, "OLD", "zh").map(t => t.id)).toEqual(["old"]);
    expect(filterCaptureTargets(context.sessions, "project", "zh")).toHaveLength(3);
    expect(filterCaptureTargets(context.sessions, "收件", "zh").map(t => t.id)).toEqual([null]);
});
test("plain multiline caret keys stay native; Command arrows cycle targets without changing the shared text", async () => {
    const editor = await input(), target = screen.getByLabelText("选择目标");
    const body = "  第一行😀\n第二行\n第三行  ";
    fireEvent.change(editor, { target: { value: body } });
    for (const key of ["ArrowDown", "ArrowUp"]) {
        expect(fireEvent.keyDown(editor, { key })).toBe(true);
        expect(fireEvent.keyDown(editor, { key, shiftKey: true })).toBe(true);
        expect(fireEvent.keyDown(editor, { key, ctrlKey: true })).toBe(true);
        expect(target).toHaveTextContent("会话 a");
        expect(editor).toHaveValue(body);
    }
    for (const [key, title] of [["ArrowDown", "会话 b"], ["ArrowDown", "收件箱"], ["ArrowDown", "新会话 · Codex"], ["ArrowDown", "新会话 · Claude"], ["ArrowDown", "会话 a"], ["ArrowUp", "新会话 · Claude"], ["ArrowUp", "新会话 · Codex"], ["ArrowUp", "收件箱"], ["ArrowUp", "会话 b"]]) {
        expect(fireEvent.keyDown(editor, { key, metaKey: true })).toBe(false);
        expect(target).toHaveTextContent(title!);
        expect(editor).toHaveValue(body);
    }
    expect(api.saveDraft).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(editor, { key: "Enter" });
    await screen.findByRole("status");
    expect(api.saveIdea).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "b", body }), expect.any(Number));
});
test("@ search keeps its arrow/Enter navigation and preserves shared text; Escape cancels only the filter", async () => {
    context.drafts[captureDraftKey("b")] = { target: captureDraftKey("b"), body: "b 的草稿", revision: 2, updatedAt: "2026-10-16" };
    const editor = await input();
    fireEvent.change(editor, { target: { value: "a 的草稿" } });
    fireEvent.keyDown(editor, { key: "@" });
    let filter = screen.getByRole("textbox", { name: "筛选目标" });
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "会话 b" })).toHaveAttribute("aria-selected", "true");
    fireEvent.change(filter, { target: { value: "old" } });
    fireEvent.keyDown(filter, { key: "Enter", isComposing: true });
    expect(screen.getByRole("textbox", { name: "筛选目标" })).toBeVisible();
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(screen.getByRole("button", { name: "选择目标" })).toHaveTextContent("会话 old");
    expect(screen.getByRole("textbox", { name: "快捷记录想法" })).toHaveValue("a 的草稿");
    expect(api.saveIdea).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "快捷记录想法" }), { key: "@" });
    filter = screen.getByRole("textbox", { name: "筛选目标" });
    fireEvent.keyDown(filter, { key: "Escape" });
    expect(api.close).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "快捷记录想法" }), { key: "Escape" });
    expect(api.close).toHaveBeenCalledWith(1);
    expect(api.saveDraft).toHaveBeenCalledWith({ body: "a 的草稿", operationId: expect.any(String) });
});
test("IME and Shift Enter never submit; ordinary Enter saves verbatim and hides after one second", async () => {
    const editor = await input();
    fireEvent.change(editor, { target: { value: "  中文😀\n保留空格  " } });
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(editor, { key: "Enter", isComposing: true });
    fireEvent.keyDown(editor, { key: "Enter", keyCode: 229 });
    fireEvent.compositionStart(editor); fireEvent.keyDown(editor, { key: "Enter" });
    expect(api.saveIdea).not.toHaveBeenCalled();
    fireEvent.compositionEnd(editor);
    vi.useFakeTimers();
    await act(async () => fireEvent.keyDown(editor, { key: "Enter" }));
    expect(api.saveIdea).toHaveBeenCalledExactlyOnceWith({ sessionId: "a", body: "  中文😀\n保留空格  ", expectedRevision: 0, operationId: expect.any(String) }, expect.any(Number));
    expect(screen.getByRole("status")).toHaveTextContent("已记到 会话 a");
    expect(api.saveDraft).toHaveBeenLastCalledWith({ body: "", operationId: expect.any(String) });
    await act(() => vi.advanceTimersByTimeAsync(999)); expect(api.close).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1)); expect(api.close).toHaveBeenCalledWith(1);
});
test("empty bodies and 4001 code points do not save; 4000 emoji do", async () => {
    context.sessions = [];
    const editor = await input();
    for (const body of ["", " \n ", "😀".repeat(4001)]) { fireEvent.change(editor, { target: { value: body } }); fireEvent.keyDown(editor, { key: "Enter" }); }
    expect(api.saveIdea).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("最多 4000 字");
    expect(editor).toHaveValue(" \n ");
    expect(vi.mocked(api.saveDraft).mock.calls.every(([r]) => Array.from(r.body).length <= 4000)).toBe(true);
    fireEvent.change(editor, { target: { value: "😀".repeat(4000) } });
    expect(screen.getByLabelText("字数")).toHaveTextContent("4000 / 4000");
    fireEvent.keyDown(editor, { key: "Enter" });
    await screen.findByRole("status");
    expect(api.saveIdea).toHaveBeenCalledWith(expect.objectContaining({ sessionId: null, body: "😀".repeat(4000) }), expect.any(Number));
});
test("save failure retains the draft and retry reuses the operation ID", async () => {
    vi.mocked(api.saveIdea).mockRejectedValueOnce(new Error("保存暂不可用"));
    const editor = await input();
    fireEvent.change(editor, { target: { value: "不能丢失" } }); fireEvent.keyDown(editor, { key: "Enter" });
    await screen.findByRole("alert");
    expect(editor).toHaveValue("不能丢失");
    expect(api.close).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: "Enter" });
    await screen.findByRole("status");
    const calls = vi.mocked(api.saveIdea).mock.calls;
    expect(calls[0]![0].operationId).toBe(calls[1]![0].operationId);
});
test("reopening recomputes the default, restores the shared draft, and cancels a previous success timer", async () => {
    const editor = await input();
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "保存一次" } });
    await act(async () => fireEvent.keyDown(editor, { key: "Enter" }));
    context.openId++;
    context.sessions = [];
    context.drafts[CAPTURE_DRAFT_KEY] = { target: CAPTURE_DRAFT_KEY, body: "收件箱草稿", revision: 4, updatedAt: "2026-10-16" };
    await act(async () => fireEvent.focus(window));
    expect(editor).toHaveValue("收件箱草稿");
    expect(editor).toBeEnabled();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(api.close).not.toHaveBeenCalled();
});

test("Escape leaves the shared draft intact when the next open defaults to a different target", async () => {
    const editor = await input();
    fireEvent.change(editor, { target: { value: "  未保存的想法😀  " } });
    fireEvent.keyDown(editor, { key: "Escape" });
    context.openId++; context.sessions = [];
    await act(async () => fireEvent.focus(window));
    expect(editor).toHaveValue("  未保存的想法😀  ");
    expect(screen.getByLabelText("选择目标")).toHaveTextContent("收件箱");
    expect(api.saveIdea).not.toHaveBeenCalled();
});
test("closing right after a reopen targets the newest open ID announced by Main, before its context loads", async () => {
    await input();
    let release: () => void = () => {};
    vi.mocked(api.getContext).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ ...structuredClone(context), openId: 2 }); }));
    act(() => { window.dispatchEvent(new CustomEvent("aimspan-capture-opened", { detail: 2 })); });
    fireEvent.click(screen.getByRole("button", { name: "关闭快捷记录" }));
    expect(api.close).toHaveBeenLastCalledWith(2);
    release();
});
test("Main preselection and explicit inbox share one draft without a DOM focus event; old rows are ignored", async () => {
    context.preselectedTarget = "b";
    context.drafts[CAPTURE_DRAFT_KEY] = { target: CAPTURE_DRAFT_KEY, body: "浮窗草稿", revision: 1, updatedAt: "2026-10-16" };
    context.drafts[captureDraftKey("b")] = { target: captureDraftKey("b"), body: "b 的草稿", revision: 1, updatedAt: "2026-10-16" };
    const editor = await input();
    expect(screen.getByLabelText("选择目标")).toHaveTextContent("会话 b");
    expect(editor).toHaveValue("浮窗草稿");
    context.openId++; context.preselectedTarget = null;
    await act(async () => window.dispatchEvent(new CustomEvent("aimspan-capture-opened", { detail: context.openId })));
    expect(screen.getByLabelText("选择目标")).toHaveTextContent("收件箱");
    expect(editor).toHaveValue("浮窗草稿");
});

test("target row includes app, project, title, T11 wording, state marker and only positive pending counts", async () => {
    context.sessions = [session("a", { state: "running", lastPromptAt: new Date(Date.now() - 3 * 60_000).toISOString(), pendingIdeaCount: 2 }),
        session("b", { agent: "claude-code", state: "idle", lastTurnEndAt: new Date(Date.now() - 8 * 60_000).toISOString(), hasNewResult: false }),
        session("c", { state: "waiting", lastTurnEndAt: new Date(Date.now() - 12 * 60_000).toISOString(), pendingIdeaCount: 1 }), session("d", { state: "unknown" })];
    context.inboxIdeaCount = 4;
    const editor = await input(), target = screen.getByLabelText("选择目标");
    expect(target).toHaveTextContent("Codex · project");
    expect(target).toHaveTextContent("会话 a");
    expect(target).toHaveTextContent("已运行 3 分钟");
    expect(target).toHaveTextContent("想法 2");
    expect(target.querySelector(".agent-icon")).toBeNull();
    expect(target.querySelector(".state-marker.running")).not.toBeNull();
    expect(screen.getByText("Enter 保存 · ⌘↑↓ 换目标 · Esc 关闭 · 仅保存到本机")).toBeVisible();
    fireEvent.keyDown(editor, { key: "ArrowDown", metaKey: true });
    expect(target).toHaveTextContent("Claude · project");
    expect(target).toHaveTextContent("8 分钟前结束");
    expect(target.querySelector(".agent-icon")).toBeNull();
    expect(target.querySelector(".state-marker")).toHaveClass("idle");
    expect(target).not.toHaveTextContent("想法");
    fireEvent.keyDown(editor, { key: "ArrowDown", metaKey: true });
    expect(target).toHaveTextContent("等你 12 分钟");
    expect(target.querySelector(".state-marker.waiting")).not.toBeNull();
    expect(target.closest(".capture-target")).toHaveClass("waiting");
    expect(target.querySelector(".session-title")).toHaveClass("has-new-result");
    fireEvent.keyDown(editor, { key: "ArrowDown", metaKey: true });
    expect(target).toHaveTextContent("状态待确认");
    expect(target.querySelector(".state-marker.unknown")).not.toBeNull();
    fireEvent.keyDown(editor, { key: "ArrowDown", metaKey: true });
    expect(target).toHaveTextContent("收件箱");
    expect(target).toHaveTextContent("想法 4");
    expect(target.querySelector(".agent-icon, .state-marker, .capture-time")).toBeNull();
});

test("an empty inbox has no count badge and live time wording advances", async () => {
    context.preselectedTarget = null;
    vi.useFakeTimers();
    await act(async () => { render(<Capture/>); });
    const editor = screen.getByRole("textbox", { name: "快捷记录想法" }), target = screen.getByLabelText("选择目标");
    expect(target).not.toHaveTextContent("想法");
    fireEvent.keyDown(editor, { key: "ArrowDown", metaKey: true });
    fireEvent.keyDown(editor, { key: "ArrowDown", metaKey: true });
    fireEvent.keyDown(editor, { key: "ArrowDown", metaKey: true });
    expect(target).toHaveTextContent("刚刚开始运行");
    await act(() => vi.advanceTimersByTimeAsync(3 * 60_000));
    expect(target).toHaveTextContent("已运行 3 分钟");
});

test("T15 capture target, search and saved notice use a readable fallback without changing the destination", async () => {
    context.sessions = [session("a", { nativeId: "fixture-native", title: "fixture-native", state: "running", lastPromptAt: new Date().toISOString() })];
    const editor = await input();
    expect(editor).toHaveFocus();
    expect(screen.getByTitle("会话 ID：fixture-native")).toHaveTextContent("未命名会话");
    expect(screen.queryByText("fixture-native")).toBeNull();
    fireEvent.keyDown(editor, { key: "@" });
    const filter = screen.getByRole("textbox", { name: "筛选目标" });
    fireEvent.change(filter, { target: { value: "未命名" } });
    fireEvent.click(screen.getByRole("option", { name: "未命名会话" }));
    const restored = screen.getByRole("textbox", { name: "快捷记录想法" });
    expect(restored).toHaveFocus();
    fireEvent.change(restored, { target: { value: "保留目标与原文" } });
    fireEvent.keyDown(restored, { key: "Enter" });
    expect(await screen.findByRole("status")).toHaveTextContent("已记到 未命名会话");
    expect(api.saveIdea).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "a", body: "保留目标与原文" }), expect.any(Number));
    fireEvent.click(screen.getByRole("button", { name: "关闭快捷记录" }));
    expect(api.close).toHaveBeenCalledWith(1);
});
test("a focus refresh of the same open never disables the input or swallows Enter", async () => {
    const editor = await input();
    let release: () => void = () => {};
    vi.mocked(api.getContext).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(structuredClone(context)); }));
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(editor).toBeEnabled();
    fireEvent.change(editor, { target: { value: "刷新期间也能保存" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(api.saveIdea).toHaveBeenCalledWith(expect.objectContaining({ body: "刷新期间也能保存" }), expect.any(Number)));
    release();
});
test("a save rejected as a superseded open reloads the current context instead of retrying the old target", async () => {
    const editor = await input();
    const before = vi.mocked(api.getContext).mock.calls.length;
    vi.mocked(api.saveIdea).mockRejectedValueOnce(new Error(CAPTURE_STALE_OPEN));
    fireEvent.change(editor, { target: { value: "重开后再确认" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(vi.mocked(api.getContext).mock.calls.length).toBeGreaterThan(before));
    expect(api.saveIdea).toHaveBeenCalledTimes(1);
});
test("the save uses the open ID of the rendered context, so the shown target and open ID always match", async () => {
    const editor = await input();
    fireEvent.change(editor, { target: { value: "与显示的目标一致" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(api.saveIdea).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "a" }), context.openId));
});

test.each(["codex", "claude"] as const)("T18 @ selects %s; IME stays local and Enter uses the committed open with a 1.5 second receipt", async app => {
    const editor = await input();
    const body = "  新想法😀\n保留原文  ";
    fireEvent.change(editor, { target: { value: body } });
    fireEvent.keyDown(editor, { key: "@" });
    fireEvent.change(screen.getByRole("textbox", { name: "筛选目标" }), { target: { value: app } });
    fireEvent.click(screen.getByRole("option", { name: `新会话 · ${app === "codex" ? "Codex" : "Claude"}` }));
    const selected = screen.getByRole("textbox", { name: "快捷记录想法" });
    expect(selected).toHaveValue(body);
    for (const flags of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) fireEvent.keyDown(selected, { key: "Enter", ...flags });
    fireEvent.compositionStart(selected); fireEvent.keyDown(selected, { key: "Enter" });
    expect(api.newSession).not.toHaveBeenCalled(); expect(api.saveIdea).not.toHaveBeenCalled();
    fireEvent.compositionEnd(selected);
    vi.useFakeTimers();
    await act(async () => fireEvent.keyDown(selected, { key: "Enter" }));
    expect(api.newSession).toHaveBeenCalledExactlyOnceWith({ kind: "capture", app, body, expectedRevision: 0, operationId: expect.any(String) }, context.openId);
    expect(api.saveIdea).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(`已复制，在 ${app === "codex" ? "Codex" : "Claude"} 中粘贴后回车`);
    expect(api.saveDraft).toHaveBeenLastCalledWith({ body: "", operationId: expect.any(String) });
    await act(() => vi.advanceTimersByTimeAsync(1499)); expect(api.close).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1)); expect(api.close).toHaveBeenCalledExactlyOnceWith(context.openId);
});
test("T18 stale new-session save refreshes context, and a reopened capture cancels the old receipt timer", async () => {
    context.preselectedTarget = NEW_SESSION_TARGETS.codex;
    const editor = await input();
    vi.mocked(api.newSession).mockRejectedValueOnce(new Error(CAPTURE_STALE_OPEN));
    const before = vi.mocked(api.getContext).mock.calls.length;
    fireEvent.change(editor, { target: { value: "不能丢失" } }); fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(vi.mocked(api.getContext).mock.calls.length).toBeGreaterThan(before));
    expect(editor).toHaveValue("不能丢失");
    vi.useFakeTimers();
    await act(async () => fireEvent.keyDown(editor, { key: "Enter" }));
    expect(vi.mocked(api.newSession).mock.calls[0]![0].operationId).toBe(vi.mocked(api.newSession).mock.calls[1]![0].operationId);
    context.openId++; context.preselectedTarget = NEW_SESSION_TARGETS.claude;
    await act(async () => window.dispatchEvent(new CustomEvent("aimspan-capture-opened", { detail: context.openId })));
    expect(screen.getByLabelText("选择目标")).toHaveTextContent("新会话 · Claude");
    await act(() => vi.advanceTimersByTimeAsync(1500)); expect(api.close).not.toHaveBeenCalled();
});
test("the footer hint tells the truth for new-session targets", async () => {
    const editor = await input();
    expect(screen.getByText(/仅保存到本机/)).toBeInTheDocument();
    for (let k = 0; k < 6 && !screen.queryByText(/复制并打开 Codex/); k++) fireEvent.keyDown(editor, { key: "ArrowDown", metaKey: true });
    expect(screen.getByText(/Enter 复制并打开 Codex.*不会自动发送/)).toBeInTheDocument();
});

test("T22 chips and Command 1–5 select visible targets, preserve text and follow the target in the footer", async () => {
    let editor = await input();
    const body = "  写到一半\n继续想😀  ";
    fireEvent.change(editor, { target: { value: body } });
    expect(screen.getByRole("button", { name: "当前会话" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "当前会话" })).toHaveAccessibleDescription(/Codex.*project.*会话 a/);
    const labels = ["当前会话", "收件箱", "新 Codex", "新 Claude"];
    for (const [index, label] of labels.entries()) {
        fireEvent.click(screen.getByRole("button", { name: label }));
        expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "true");
        expect(editor).toHaveValue(body);
        expect(editor).toHaveFocus();
        if (index >= 2) expect(screen.getByText(`Enter 复制并打开 ${index === 2 ? "Codex" : "Claude"} · ⌘↑↓ 换目标 · Esc 关闭 · 不会自动发送`)).toBeVisible();
        else expect(screen.getByText(/Enter 保存.*仅保存到本机/)).toBeVisible();
        fireEvent.keyDown(editor, { key: "5", metaKey: true });
        expect(screen.getByRole("textbox", { name: "筛选目标" })).toHaveFocus();
        fireEvent.keyDown(screen.getByRole("textbox", { name: "筛选目标" }), { key: String(index + 1), metaKey: true });
        expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "true");
        editor = screen.getByRole("textbox", { name: "快捷记录想法" });
        expect(editor).toHaveValue(body);
    }
    fireEvent.click(screen.getByRole("button", { name: "其他会话…" }));
    const filter = screen.getByRole("textbox", { name: "筛选目标" });
    fireEvent.change(filter, { target: { value: "old" } });
    fireEvent.click(screen.getByRole("option", { name: "会话 old" }));
    expect(screen.getByRole("button", { name: "其他会话…" })).toHaveAttribute("aria-pressed", "true");
    const restored = screen.getByRole("textbox", { name: "快捷记录想法" });
    expect(restored).toHaveValue(body);
    fireEvent.keyDown(restored, { key: "1", metaKey: true });
    expect(screen.getByLabelText("选择目标")).toHaveTextContent("会话 a");
    expect(api.saveIdea).not.toHaveBeenCalled(); expect(api.newSession).not.toHaveBeenCalled();
});

test("T22 chip shortcuts honor every IME indicator and do not intercept ordinary digits", async () => {
    const editor = await input();
    for (const flags of [{ isComposing: true }, { keyCode: 229 }]) for (const key of ["2", "3", "4", "5"])
        expect(fireEvent.keyDown(editor, { key, metaKey: true, ...flags })).toBe(true);
    fireEvent.compositionStart(editor);
    for (const key of ["2", "3", "4", "5"]) fireEvent.keyDown(editor, { key, metaKey: true });
    expect(screen.queryByRole("textbox", { name: "筛选目标" })).toBeNull();
    expect(screen.getByRole("button", { name: "当前会话" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.compositionEnd(editor);
    expect(fireEvent.keyDown(editor, { key: "3" })).toBe(true);
    fireEvent.keyDown(editor, { key: "3", metaKey: true });
    expect(screen.getByRole("button", { name: "新 Codex" })).toHaveAttribute("aria-pressed", "true");
    expect(api.saveIdea).not.toHaveBeenCalled(); expect(api.newSession).not.toHaveBeenCalled();
});

test("T22 current-session chip respects explicit session preselection; absent recent sessions default to inbox", async () => {
    context.preselectedTarget = "b";
    const editor = await input();
    fireEvent.keyDown(editor, { key: "2", metaKey: true });
    fireEvent.keyDown(editor, { key: "1", metaKey: true });
    expect(screen.getByLabelText("选择目标")).toHaveTextContent("会话 b");
    context.openId++; context.sessions = []; delete context.preselectedTarget;
    await act(async () => window.dispatchEvent(new CustomEvent("aimspan-capture-opened", { detail: context.openId })));
    expect(screen.getByRole("button", { name: "收件箱" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(editor, { key: "1", metaKey: true });
    expect(screen.getByRole("button", { name: "收件箱" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "当前会话" })).toHaveAttribute("title", expect.stringContaining("没有最近运行的会话"));
});

test.each(["codex", "claude"] as const)("T22 %s chip submits through the existing open-ID guarded new-session path", async app => {
    const editor = await input();
    fireEvent.change(editor, { target: { value: "  原文😀\n继续  " } });
    fireEvent.click(screen.getByRole("button", { name: app === "codex" ? "新 Codex" : "新 Claude" }));
    fireEvent.keyDown(editor, { key: "Enter" });
    await screen.findByRole("status");
    expect(api.newSession).toHaveBeenCalledExactlyOnceWith({ kind: "capture", app, body: "  原文😀\n继续  ", expectedRevision: 0, operationId: expect.any(String) }, context.openId);
    expect(api.saveIdea).not.toHaveBeenCalled();
});

test("T23 capture switches an already-open draft and its chips/footer without losing the destination", async () => {
    let languageChanged: (language: "en" | "zh") => void = () => {};
    api.onLanguage = callback => { languageChanged = callback; return () => {}; };
    const editor = await input();
    fireEvent.change(editor, { target: { value: "  中文草稿\nkeep me  " } });
    fireEvent.click(screen.getByRole("button", { name: "新 Claude" }));
    act(() => languageChanged("en"));
    expect(screen.getByRole("button", { name: "New Claude" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: "Quick capture idea" })).toHaveValue("  中文草稿\nkeep me  ");
    expect(screen.getByText("Enter Copy and open Claude · ⌘↑↓ Switch target · Esc Close · Never sent automatically")).toBeVisible();
    expect(document.documentElement.lang).toBe("en");
    fireEvent.click(screen.getByRole("button", { name: "Inbox" }));
    expect(screen.getByText("Enter Save · ⌘↑↓ Switch target · Esc Close · Stays on this Mac")).toBeVisible();
    act(() => languageChanged("zh"));
    expect(screen.getByRole("button", { name: "收件箱" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: "快捷记录想法" })).toHaveValue("  中文草稿\nkeep me  ");
    expect(api.saveIdea).not.toHaveBeenCalled();
});

test("T23 English capture renders translated stale-open errors while matching the stable code", async () => {
    context.language = "en";
    render(<Capture/>);
    const editor = await screen.findByRole("textbox", { name: "Quick capture idea" });
    await waitFor(() => expect(editor).toBeEnabled());
    fireEvent.change(editor, { target: { value: "preserve" } });
    vi.mocked(api.saveIdea).mockRejectedValueOnce(new Error(`Error invoking remote method 'capture:idea': Error: ${CAPTURE_STALE_OPEN}`));
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Quick capture was reopened. Confirm the target before saving");
    expect(editor).toHaveValue("preserve");
});

test("T23 a language push arriving before initial capture context wins over the older response", async () => {
    let changed: (language: "en" | "zh") => void = () => {};
    api.onLanguage = callback => { changed = callback; return () => {}; };
    let resolve!: (value: CaptureContext) => void;
    vi.mocked(api.getContext).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    render(<Capture/>);
    act(() => changed("en"));
    await act(async () => resolve(context));
    expect(screen.getByRole("button", { name: "This session" })).toBeVisible();
    expect(document.documentElement.lang).toBe("en");
});

test("T23 R1 an on-screen new-session capture receipt retranslates without reopening the app", async () => {
    const { openNewSession } = await import("../main/session-entry");
    const shell = { openExternal: vi.fn(async () => {}) };
    let changed: (language: "en" | "zh") => void = () => {};
    api.onLanguage = callback => { changed = callback; return () => {}; };
    api.newSession = vi.fn(async () => ({ ...await openNewSession("claude", shell, undefined, "zh"), brought: 1 }));
    context.preselectedTarget = NEW_SESSION_TARGETS.claude;
    const editor = await input();
    fireEvent.change(editor, { target: { value: "  原文 keep  " } });
    vi.useFakeTimers();
    await act(async () => fireEvent.keyDown(editor, { key: "Enter" }));
    expect(screen.getByRole("status")).toHaveTextContent("已复制，在 Claude 中粘贴后回车");
    act(() => changed("en"));
    expect(screen.getByRole("status")).toHaveTextContent("Copied. Paste in Claude and press Enter");
    expect(shell.openExternal).toHaveBeenCalledOnce();
    expect(api.newSession).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(api.close).toHaveBeenCalledExactlyOnceWith(context.openId);
});
