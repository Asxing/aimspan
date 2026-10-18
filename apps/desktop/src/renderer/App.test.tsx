import { BringBack, openSession } from "../main/bring-back";
import type { ReactElement, ReactNode } from "react";
import { LanguageContext } from "../shared/i18n/react";
import { act, fireEvent, render as renderUI, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import type { PanelTarget, CoreRequest, Workspace, DesktopApi, CatchUp } from "@aimspan/protocol";
import { DEFAULT_SETTINGS, isActiveSession } from "@aimspan/protocol";
import { App } from "./App";
import { VirtualList, layoutRows } from "./VirtualList";
let calls: CoreRequest[];
let workspace: Workspace;
let openPanel: (target: PanelTarget) => void;
let publish: (value: Workspace) => void;
const emptyCatchUp: CatchUp = { activity: [], activityIncomplete: false, anchor: null, state: "waiting", durationMsOfCurrentOrLastTurn: 60000, turnsSinceAnchor: 1, pendingIdeas: [], truncated: false, factsIncomplete: false, errors: [], changedFiles: [], failedCommands: [] };
beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class {
        observe() { }
        unobserve() { }
        disconnect() { }
    });
    calls = [];
    workspace = { sessions: ["a", "b"].map(id => ({ surface: "unknown", activity: [], activityIncomplete: false, id, revision: 1, updatedAt: "2026-10-12", deviceId: "d", agent: "codex", nativeId: id, title: `会话 ${id}`, project: "project", state: "waiting", observedAt: "2026-10-12", confidence: "explicit", sourceVersion: "v", references: [], archived: false, active: true, hasNewResult: false, pinned: false, subagentRunning: false, pendingIdeaCount: 0, interactive: true })), ideas: [], inboxIdeaCount: 0, drafts: {}, settings: { ...DEFAULT_SETTINGS, language: "zh" }, seq: 1, deviceId: "d", diagnostics: [] };
    const api: DesktopApi = { hide: vi.fn(async () => {}), call: async (r) => { calls.push(r); return r.method === "workspace" ? workspace : r.method === "catchup" ? { ...emptyCatchUp, pendingIdeas: workspace.ideas.filter(i => i.sessionId === r.sessionId && i.status === "pending") } : r.method === "draft.save" ? { target: r.target, body: r.body, revision: r.expectedRevision + 1, updatedAt: "2026-10-16" } : null; }, subscribe: callback => { publish = callback; return () => { }; }, onFlushDrafts: () => () => { }, onOpen: callback => { openPanel = callback; return () => {}; }, reveal: vi.fn(async () => ({ message: "opened" })), chooseRoot: vi.fn(async () => { }), exportLegacy: vi.fn(async () => null), openLink: vi.fn(async () => {}), newSession: vi.fn(async () => ({ message: "已复制，在 Codex 中粘贴后回车", brought: 1, undoToken: "new-undo", undoExpiresAt: Date.now() + 5000 })), bringBack: vi.fn(async () => ({ message: "已复制，尚未发送", brought: 1, undoToken: "undo", undoExpiresAt: Date.now() + 5000 })), undoBringBack: vi.fn(async () => {}) };
    window.aimspan = api;
});
test("opening a row marks the session viewed and shows ideas", async () => {
    render(<App />);
    fireEvent.click(await screen.findByText("会话 a"));
    await waitFor(() => expect(calls.map(r => r.method)).toEqual(["workspace", "catchup", "session.viewed"]));
    expect(screen.getByRole("textbox", { name: "添加想法" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "我的想法" })).toBeVisible();
    expect(screen.getByRole("button", { name: "打开原会话" })).toHaveClass("primary-action");
    fireEvent.click(screen.getByRole("button", { name: "打开原会话" }));
    await waitFor(() => expect(window.aimspan.reveal).toHaveBeenCalledExactlyOnceWith("a"));
    expect(window.aimspan.bringBack).not.toHaveBeenCalled();
});
test("T21 viewing only clears the new-result dot; waiting persists until an explicit handled action", async () => {
    workspace.sessions[0] = { ...workspace.sessions[0]!, surface: "desktop", hasNewResult: true, lastTurnEndAt: "2026-10-18T08:00:00Z" };
    workspace.sessions[1] = { ...workspace.sessions[1]!, entrypoint: "openclaw", surface: "cli", state: "running" };
    const original = window.aimspan.call;
    window.aimspan.call = async request => {
        const result = await original(request);
        if (request.method === "session.viewed" || request.method === "session.handled") {
            workspace = { ...workspace, sessions: workspace.sessions.map(s => s.id !== request.sessionId ? s : {
                ...s, revision: s.revision + 1, ...(request.method === "session.viewed"
                    ? { hasNewResult: false, lastViewedAt: request.at }
                    : { state: "idle" as const, handledAt: new Date().toISOString() }),
            }) };
            publish(workspace);
        }
        return result;
    };
    render(<App/>);
    const title = await screen.findByText("会话 a");
    expect(screen.getByText("Codex 桌面")).toBeVisible(); expect(screen.getByText("OpenClaw")).toBeVisible();
    expect(screen.queryByRole("button", { name: "标记 会话 b 已处理" })).toBeNull();
    fireEvent.click(title);
    await waitFor(() => expect(title).not.toHaveClass("has-new-result"));
    expect(title.closest("article")).toHaveClass("needs-you");
    expect(calls.filter(r => r.method === "session.handled")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "更多会话操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "已处理" }));
    await waitFor(() => expect(title.closest("article")).not.toHaveClass("needs-you"));
    expect(calls.at(-1)).toMatchObject({ method: "session.handled", sessionId: "a", expectedRevision: 2, operationId: expect.any(String) });
    expect(document.querySelector(".catchup-summary")).toHaveTextContent(/^空闲/);
    fireEvent.click(screen.getByRole("button", { name: "更多会话操作" }));
    expect(screen.queryByRole("menuitem", { name: "已处理" })).toBeNull();
});
test("T21 panel row handled action uses its revision without opening or viewing the card", async () => {
    render(<App/>);
    fireEvent.click(await screen.findByRole("button", { name: "标记 会话 a 已处理" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "session.handled", sessionId: "a", expectedRevision: 1, operationId: expect.any(String) }));
    expect(calls.some(r => r.method === "session.viewed" || r.method === "catchup")).toBe(false);
    expect(screen.queryByLabelText("衔接卡")).toBeNull();
});
test("T11 panel rows encode all states, bold only new results, and omit zero idea badges", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-16T09:00:00Z"));
    const base = workspace.sessions[0]!;
    workspace.sessions = [
        { ...base, state: "waiting", lastTurnEndAt: "2026-10-16T08:48:00Z", hasNewResult: true, pendingIdeaCount: 2 },
        { ...base, id: "b", nativeId: "b", title: "运行会话", state: "running", lastPromptAt: "2026-10-16T08:54:00Z" },
        { ...base, id: "c", nativeId: "c", title: "空闲会话", state: "idle", lastTurnEndAt: "2026-10-16T08:52:00Z", lastActivityAt: "2026-10-16T08:59:00Z" },
        { ...base, id: "d", nativeId: "d", title: "未知会话", state: "unknown" },
    ];
    const { container } = render(<App/>);
    await screen.findByText("会话 a");
    expect(screen.getByText("等你 12 分钟")).toBeVisible();
    expect(screen.getByText("已运行 6 分钟")).toBeVisible();
    expect(screen.getByText("8 分钟前结束")).toBeVisible();
    expect(screen.getByText("状态待确认")).toBeVisible();
    const row = (id: string) => container.querySelector(`[data-row-id="${id}"]`)!;
    expect(row("a").querySelector("article")).toHaveClass("needs-you");
    expect(row("a").querySelector(".state-marker")).toHaveClass("waiting");
    expect(screen.getByText("会话 a")).toHaveClass("has-new-result");
    expect(row("b").querySelector(".state-marker")).toHaveClass("running");
    expect(screen.getByText("运行会话")).not.toHaveClass("has-new-result");
    expect(row("c").querySelector(".state-marker")).toHaveClass("idle");
    expect(screen.getByText("空闲会话")).toHaveClass("muted");
    expect(row("d").querySelector(".state-marker")).toHaveClass("unknown");
    expect(container.querySelectorAll(".idea-badge")).toHaveLength(1);
    expect(screen.getByText("想法 2")).toBeVisible();
    expect(screen.queryByText("想法 0")).toBeNull();
});
test("T11 idea input follows pending ideas before the away summary and stays when all ideas are brought", async () => {
    workspace.ideas = [{ id: "one", body: "待用想法原文", sessionId: "a", revision: 1, status: "pending", createdAt: "2026-10-16", updatedAt: "2026-10-16" }];
    const original = window.aimspan.call;
    window.aimspan.call = request => request.method === "catchup" ? Promise.resolve({ ...emptyCatchUp, awaySummary: "离开期间的摘要", lastAgentMessage: { body: "最后一条回复", fromBeforeAnchor: false } }) : original(request);
    render(<App/>);
    fireEvent.click(await screen.findByText("会话 a"));
    await screen.findByText("离开期间的摘要");
    const input = screen.getByRole("textbox", { name: "添加想法" });
    const before = (a: Element, b: Element) => expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    before(screen.getByRole("heading", { name: "我的想法" }), screen.getByText("待用想法原文"));
    before(screen.getByText("待用想法原文"), input);
    before(input, screen.getByText("离开期间的摘要"));
    before(screen.getByText("离开期间的摘要"), screen.getByText("最后一条回复"));
    expect(screen.getByText("最后一条回复")).toBeVisible();
    act(() => publish({ ...workspace, ideas: workspace.ideas.map(idea => ({ ...idea, status: "brought" })) }));
    expect(screen.getByRole("heading", { name: "我的想法" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "添加想法" })).toBe(input);
    expect(screen.getByRole("button", { name: "打开原会话" })).toHaveClass("primary-action");
    fireEvent.click(screen.getByText("已带回 · 1"));
    expect(screen.getByText("待用想法原文")).toBeVisible();
});
test("draft survives row collapse and search switches", async () => { render(<App />); fireEvent.click(await screen.findByText("会话 a")); fireEvent.change(screen.getByRole("textbox", { name: "添加想法" }), { target: { value: "检查键盘操作" } }); fireEvent.click(screen.getByText("会话 a")); fireEvent.click(screen.getByText("会话 a")); expect(screen.getByRole("textbox", { name: "添加想法" })).toHaveValue("检查键盘操作"); fireEvent.change(screen.getByRole("textbox", { name: "搜索完整会话和想法" }), { target: { value: "不存在" } }); fireEvent.change(screen.getByRole("textbox", { name: "搜索完整会话和想法" }), { target: { value: "" } }); expect(screen.getByRole("textbox", { name: "添加想法" })).toHaveValue("检查键盘操作"); });
test("virtual list renders a bounded viewport but exposes complete count", () => { render(<VirtualList ids={Array.from({ length: 1000 }, (_, i) => String(i))} expanded={null} render={id => <span>{id}</span>}/>); expect(screen.getAllByRole("listitem").length).toBeLessThan(15); expect(screen.getByRole("list")).toHaveAccessibleName("会话列表，共 1000 个会话"); expect(layoutRows(["a", "b", "c"], new Map([["a", 500]]))[1]!.top).toBe(500); });
test("failure to read workspace is shown as error rather than empty inbox", async () => { window.aimspan.call = async () => { throw new Error("core.errorCoreIsStopping"); }; render(<App />); expect(await screen.findByText(/后台正在停止/)).toBeVisible(); expect(screen.queryByText("还没有匹配的会话")).toBeNull(); });
test("ideas save and edit locally, discard with revisions, and open the source only on click", async () => {
    workspace.ideas = [{ id: "plan", sessionId: "a", revision: 1, updatedAt: "2026-10-14", createdAt: "2026-10-14", status: "pending", body: "下一步检查键盘操作" }];
    const originalCall = window.aimspan.call;
    window.aimspan.call = async request => {
        const result = await originalCall(request);
        return request.method === "idea.save" ? { ...workspace.ideas[0], ...request } : result;
    };
    render(<App />);
    fireEvent.click(await screen.findByText("会话 a"));
    const input = screen.getByRole("textbox", { name: "添加想法" });
    fireEvent.change(input, { target: { value: "  新想法\n第二行  " } });
    fireEvent.click(screen.getByRole("button", { name: "保存想法" }));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(calls.find(r => r.method === "idea.save")).toMatchObject({ sessionId: "a", body: "  新想法\n第二行  ", expectedRevision: 0 });
    fireEvent.click(screen.getByRole("button", { name: "编辑想法 下一步检查键盘操作" }));
    const edit = screen.getByRole("textbox", { name: "编辑想法 下一步检查键盘操作" });
    expect(edit).toHaveValue("下一步检查键盘操作");
    expect(input).toHaveValue("");
    fireEvent.change(edit, { target: { value: "修订想法" } });
    fireEvent.keyDown(edit, { key: "Enter" });
    await waitFor(() => expect(edit).not.toBeInTheDocument());
    expect(calls.filter(r => r.method === "idea.save").at(-1)).toMatchObject({ id: "plan", sessionId: "a", body: "修订想法", expectedRevision: 1 });
    fireEvent.click(screen.getByRole("button", { name: "删除想法 下一步检查键盘操作" }));
    expect(calls.at(-1)).toMatchObject({ method: "idea.setStatus", status: "discarded", id: "plan", expectedRevision: 1 });
    expect(window.aimspan.reveal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "更多会话操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "只打开原会话" }));
    await waitFor(() => expect(window.aimspan.reveal).toHaveBeenCalledExactlyOnceWith("a"));
    expect(Object.keys(window.aimspan).sort()).toEqual(["bringBack", "call", "chooseRoot", "exportLegacy", "hide", "newSession", "onFlushDrafts", "onOpen", "openLink", "reveal", "subscribe", "undoBringBack"]);
});

test("settings expose only the local workflow",async()=>{
    render(<App/>);fireEvent.click(await screen.findByRole("button",{name:"设置"}));
    expect(screen.getByText("会话来源")).toBeVisible();
    expect(screen.getAllByRole("checkbox")).toHaveLength(4);
    fireEvent.click(screen.getByRole("checkbox", { name: "会话有新进展时通知我" }));
    expect(calls.at(-1)).toMatchObject({ method: "settings.save", settings: { notifications: true, notificationsExplicit: true } });
    fireEvent.click(screen.getByRole("button", { name: "选择项目目录" }));
    expect(window.aimspan.chooseRoot).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "固定为窗口" }));
    expect(calls.at(-1)).toMatchObject({ method: "settings.save", settings: { pinned: true } });
});
test("Main opens a requested card despite search/settings, and repeated open never collapses it", async () => {
    render(<App/>);
    fireEvent.change(await screen.findByRole("textbox", { name: "搜索完整会话和想法" }), { target: { value: "not-matching" } });
    act(() => openPanel({ kind: "settings" }));
    expect(screen.getByText("会话来源")).toBeVisible();
    act(() => openPanel({ kind: "session", sessionId: "b" }));
    await waitFor(() => expect(calls.some(r => r.method === "session.viewed" && r.sessionId === "b")).toBe(true));
    expect(screen.getByRole("textbox", { name: "搜索完整会话和想法" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "全部 2" })).toHaveClass("selected");
    expect(screen.getByText("会话 b").closest("button")).toHaveAttribute("aria-expanded", "true");
    act(() => openPanel({ kind: "session", sessionId: "b" }));
    await waitFor(() => expect(calls.filter(r => r.method === "session.viewed" && r.sessionId === "b")).toHaveLength(2));
    expect(screen.getByText("会话 b").closest("button")).toHaveAttribute("aria-expanded", "true");
});
test("T13 R2 explicit navigation keeps Active and matching search when the target is visible", async () => {
    render(<App/>);
    fireEvent.change(await screen.findByRole("textbox", { name: "搜索完整会话和想法" }), { target: { value: "会话 b" } });
    act(() => openPanel({ kind: "session", sessionId: "b" }));
    await waitFor(() => expect(calls.some(r => r.method === "session.viewed" && r.sessionId === "b")).toBe(true));
    expect(screen.getByRole("button", { name: "活跃 1" })).toHaveClass("selected");
    expect(screen.getByRole("textbox", { name: "搜索完整会话和想法" })).toHaveValue("会话 b");
    expect(screen.getByText("会话 b").closest("button")).toHaveAttribute("aria-expanded", "true");
    act(() => openPanel({ kind: "session", sessionId: "b" }));
    await waitFor(() => expect(calls.filter(r => r.method === "session.viewed" && r.sessionId === "b")).toHaveLength(2));
    expect(screen.getByRole("button", { name: "活跃 1" })).toHaveClass("selected");
});
test("T13 R2 explicit navigation keeps All and its matching source filter", async () => {
    workspace.sessions[1]!.agent = "claude-code";
    render(<App/>);
    fireEvent.click(await screen.findByRole("button", { name: "全部 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    act(() => openPanel({ kind: "session", sessionId: "b" }));
    await waitFor(() => expect(calls.some(r => r.method === "session.viewed" && r.sessionId === "b")).toBe(true));
    expect(screen.getByRole("button", { name: "全部 1" })).toHaveClass("selected");
    expect(screen.getByRole("button", { name: "Claude" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("会话 b").closest("button")).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    act(() => openPanel({ kind: "session", sessionId: "b" }));
    await waitFor(() => expect(calls.filter(r => r.method === "session.viewed" && r.sessionId === "b")).toHaveLength(2));
    expect(screen.getByRole("button", { name: "全部 2" })).toHaveClass("selected");
    expect(screen.getByRole("button", { name: "全部 App" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("会话 b").closest("button")).toHaveAttribute("aria-expanded", "true");
});
test("T13 R2 explicit navigation switches to All only for a target excluded from the current view", async () => {
    workspace.sessions[1] = { ...workspace.sessions[1]!, active: false, state: "idle" };
    render(<App/>);
    await screen.findByText("会话 a");
    expect(screen.queryByText("会话 b")).toBeNull();
    act(() => openPanel({ kind: "session", sessionId: "b" }));
    await waitFor(() => expect(calls.some(r => r.method === "session.viewed" && r.sessionId === "b")).toBe(true));
    expect(screen.getByRole("button", { name: "全部 2" })).toHaveClass("selected");
    expect(screen.getByText("会话 b").closest("button")).toHaveAttribute("aria-expanded", "true");
});
test("T13 R2 explicit navigation preserves Active for a parent made visible by its running child", async () => {
    workspace.sessions[0] = { ...workspace.sessions[0]!, state: "idle", active: false };
    workspace.sessions[1] = { ...workspace.sessions[1]!, parentNativeId: "a", state: "running" };
    render(<App/>);
    await screen.findByText("会话 a");
    act(() => openPanel({ kind: "session", sessionId: "a" }));
    await waitFor(() => expect(calls.some(r => r.method === "session.viewed" && r.sessionId === "a")).toBe(true));
    expect(screen.getByRole("button", { name: "活跃 1" })).toHaveClass("selected");
    expect(screen.getByText("会话 a").closest("button")).toHaveAttribute("aria-expanded", "true");
});
test("explicit navigation refreshes an expanded card and marks the new result viewed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
        vi.setSystemTime(new Date("2026-10-16T08:00:00Z"));
        const originalCall = window.aimspan.call;
        let reads = 0;
        const viewed: { at?: string; expectedRevision: number; operationId: string }[] = [];
        let finishRefresh: (value: CatchUp) => void = () => {};
        const refreshed = new Promise<CatchUp>(resolve => { finishRefresh = resolve; });
        window.aimspan.call = async request => {
            const result = await originalCall(request);
            if (request.method === "session.viewed") viewed.push(request);
            if (request.method === "catchup") return ++reads === 1
                ? { ...emptyCatchUp, lastAgentMessage: { body: "上一轮回复", fromBeforeAnchor: false } } : refreshed;
            return result;
        };
        render(<App/>);
        fireEvent.click(await screen.findByText("会话 a"));
        await screen.findByText("上一轮回复");
        await waitFor(() => expect(viewed).toHaveLength(1));
        fireEvent.change(screen.getByRole("textbox", { name: "添加想法" }), { target: { value: "保留中的草稿" } });

        // The panel stays mounted while hidden; a later workspace arrives with a new result.
        vi.setSystemTime(new Date("2026-10-16T08:03:00Z"));
        workspace = { ...workspace, sessions: workspace.sessions.map(s => s.id === "a"
            ? { ...s, revision: 7, hasNewResult: true, lastTurnEndAt: "2026-10-16T08:02:00Z" } : s) };
        act(() => publish(workspace));
        act(() => openPanel({ kind: "session", sessionId: "a" }));
        await waitFor(() => expect(reads).toBe(2));
        expect(screen.getByText("会话 a").closest("button")).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByText("正在读取衔接卡…")).toBeVisible();
        expect(screen.queryByText("上一轮回复")).toBeNull();
        expect(viewed).toHaveLength(1);

        await act(async () => finishRefresh({ ...emptyCatchUp, lastAgentMessage: { body: "新一轮回复", fromBeforeAnchor: false } }));
        expect(screen.getByText("新一轮回复")).toBeVisible();
        expect(screen.getByText("会话 a").closest("button")).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByRole("textbox", { name: "添加想法" })).toHaveValue("保留中的草稿");
        expect(viewed).toHaveLength(2);
        expect(viewed[1]).toMatchObject({ at: "2026-10-16T08:03:00.000Z", expectedRevision: 7 });
        expect(viewed[1]!.operationId).not.toBe(viewed[0]!.operationId);
        expect(calls.filter(r => r.method === "catchup" || r.method === "session.viewed").map(r => r.method))
            .toEqual(["catchup", "session.viewed", "catchup", "session.viewed"]);
    } finally { vi.useRealTimers(); }
});

test("search includes all saved ideas and archived sessions remain in the all view", async () => {
    workspace.sessions[1]!.archived = true;
    workspace.ideas = [{ id: "memo-b", sessionId: "b", revision: 1, updatedAt: "2026-10-14", createdAt: "2026-10-14", status: "pending", body: "键盘专项" }];
    render(<App />);
    await screen.findByText("会话 a");
    expect(screen.queryByText("会话 b")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /全部/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索完整会话和想法" }), { target: { value: "键盘专项" } });
    expect(screen.queryByText("会话 a")).toBeNull();
    fireEvent.click(screen.getByText("会话 b"));
    fireEvent.click(screen.getByRole("button", { name: "更多会话操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "恢复会话" }));
    expect(calls.at(-1)).toMatchObject({ method: "session.archive", sessionId: "b", archived: false });
});

test.each(["running", "waiting"] as const)("an %s child exposes its parent and counts use the rendered set", async state => {
    workspace.sessions[0] = { ...workspace.sessions[0]!, state: "idle", active: false };
    workspace.sessions[1] = { ...workspace.sessions[1]!, parentNativeId: "a", state };
    render(<App />);
    expect(await screen.findByText("会话 a")).toBeVisible();
    expect(screen.queryByText("会话 b")).toBeNull();
    expect(screen.getByRole("button", { name: "活跃 1" })).toBeVisible();
    expect(screen.getByRole("button", { name: "全部 1" })).toBeVisible();
    expect(screen.getByRole("list")).toHaveAccessibleName("会话列表，共 1 个会话");
    fireEvent.change(screen.getByRole("textbox", { name: "搜索完整会话和想法" }), { target: { value: "不存在" } });
    expect(screen.getByRole("button", { name: "活跃 0" })).toBeVisible();
    expect(screen.queryByRole("list")).toBeNull();
});

test("pin and deactivate send revisioned mutations; archived rows are excluded from active counts", async () => {
    workspace.sessions[1]!.archived = true;
    render(<App />);
    fireEvent.click(await screen.findByText("会话 a"));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "session.viewed", sessionId: "a", expectedRevision: 1 }));
    fireEvent.click(screen.getByRole("button", { name: "更多会话操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "钉在活跃列表" }));
    expect(calls.at(-1)).toMatchObject({ method: "session.pin", sessionId: "a", expectedRevision: 1 });
    fireEvent.click(screen.getByRole("button", { name: "更多会话操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "暂时移出活跃（下次发指令后回来）" }));
    expect(calls.at(-1)).toMatchObject({ method: "session.deactivate", sessionId: "a", expectedRevision: 1 });
    fireEvent.click(screen.getByRole("button", { name: "更多会话操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "归档（不再出现在活跃）" }));
    expect(calls.at(-1)).toMatchObject({ method: "session.archive", sessionId: "a", archived: true, operationId: expect.any(String) });
    expect(screen.getByRole("button", { name: "活跃 1" })).toBeVisible();
    expect(screen.getByRole("button", { name: "全部 2" })).toBeVisible();
});

test.each(["codex_exec", "sdk-cli", "sdk-ts", "sdk-py"])("%s sessions appear only in All with their execution state and consistent counts", async entrypoint => {
    workspace.sessions[1] = { ...workspace.sessions[1]!, agent: entrypoint === "codex_exec" ? "codex" : "claude-code", entrypoint, interactive: false, state: "running", active: true };
    render(<App />);
    await screen.findByText("会话 a");
    expect(screen.queryByText("会话 b")).toBeNull();
    expect(screen.getByRole("button", { name: "活跃 1" })).toBeVisible();
    expect(screen.getByRole("button", { name: "全部 2" })).toBeVisible();
    expect(screen.getByRole("list")).toHaveAccessibleName("会话列表，共 1 个会话");
    fireEvent.click(screen.getByRole("button", { name: "全部 2" }));
    expect(screen.getByText("会话 b")).toBeVisible(); expect(screen.getByText("运行中 · 时长待确认")).toBeVisible();
    expect(screen.getByRole("list")).toHaveAccessibleName("会话列表，共 2 个会话");
    fireEvent.click(screen.getByRole("button", { name: "活跃 1" }));
    expect(screen.queryByText("会话 b")).toBeNull();
});

test("automation children stay in All without inflating their parent's active count", async () => {
    workspace.sessions[0] = { ...workspace.sessions[0]!, state: "idle", active: false };
    workspace.sessions[1] = { ...workspace.sessions[1]!, parentNativeId: "a", interactive: false, state: "running", active: false };
    render(<App />);
    expect(await screen.findByText("当前没有活跃会话")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "全部 2" }));
    expect(screen.getByText("会话 b")).toBeVisible();
    expect(screen.getByRole("button", { name: "活跃 0" })).toBeVisible();
    expect(screen.getByRole("button", { name: "全部 2" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "活跃 0" }));
    expect(screen.queryByRole("list")).toBeNull();
});

test("an unmatched parent completion remains unknown when the list folds a running child", async () => {
    workspace.sessions[0] = { ...workspace.sessions[0]!, state: "unknown", active: false, unmatchedCompletion: { endedAt: "2026-10-12", lastAgentMessage: "未关联的结束回复" } };
    workspace.sessions[1] = { ...workspace.sessions[1]!, parentNativeId: "a", state: "running" };
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "全部 1" }));
    expect(screen.getByText("状态待确认")).toBeVisible();
    expect(screen.queryByText(/运行中|已运行/)).toBeNull();
    expect(screen.queryByText("会话 b")).toBeNull();
});

test("the shared tray and notification count gate excludes automation even with stale active flags", () => {
    const automated = { ...workspace.sessions[1]!, interactive: false, active: true, pinned: true };
    expect(isActiveSession(automated)).toBe(false);
    expect(isActiveSession({ ...automated, interactive: true, entrypoint: "codex_exec" })).toBe(false);
    const counted = [workspace.sessions[0]!, automated].filter(s => isActiveSession(s) && s.state === "waiting");
    expect(counted.map(s => s.id)).toEqual(["a"]);
});

test("pending inbox is usable with no sessions, saves verbatim, and includes operation IDs on revisioned drafts", async () => {
    workspace.sessions = [];
    workspace.inboxIdeaCount = 1;
    workspace.ideas = [{ id: "inbox-existing", sessionId: null, body: "待整理", status: "pending", revision: 1, createdAt: "2026-10-16", updatedAt: "2026-10-16" }];
    workspace.drafts.inbox = { target: "inbox", body: "收件箱草稿", revision: 7, updatedAt: "2026-10-16" };
    const original = window.aimspan.call;
    window.aimspan.call = async request => {
        const result = await original(request);
        return request.method === "idea.save" ? { id: "inbox-idea", ...request, status: "pending", revision: 1 } : result;
    };
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "收件箱 · 1 条想法" }));
    expect(calls.some(request => request.method === "session.viewed")).toBe(false);
    const input = screen.getByRole("textbox", { name: "添加想法" });
    expect(input).toHaveValue("收件箱草稿");
    fireEvent.change(input, { target: { value: "  token=用户原文\n😀  " } });
    fireEvent.click(screen.getByRole("button", { name: "保存想法" }));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(calls.find(request => request.method === "idea.save")).toMatchObject({ sessionId: null, body: "  token=用户原文\n😀  ", expectedRevision: 0, operationId: expect.any(String) });
    await waitFor(() => expect(calls.filter(request => request.method === "draft.save")).toHaveLength(2));
    expect(calls.filter(request => request.method === "draft.save")).toMatchObject([
        { target: "inbox", body: "  token=用户原文\n😀  ", expectedRevision: 7, operationId: expect.any(String) },
        { target: "inbox", body: "", expectedRevision: 8, operationId: expect.any(String) },
    ]);
});

test("idea history is collapsed, undo/restore use revisions and purge requires confirmation", async () => {
    workspace.ideas = [
        { id: "pending", sessionId: "a", body: "待用原文", status: "pending", revision: 1, createdAt: "2026-10-16", updatedAt: "2026-10-16" },
        { id: "brought", sessionId: "a", body: "已带回原文", status: "brought", revision: 2, createdAt: "2026-10-16", updatedAt: "2026-10-16" },
        { id: "discarded", sessionId: "a", body: "丢弃原文", status: "discarded", revision: 3, createdAt: "2026-10-16", updatedAt: "2026-10-16" },
    ];
    workspace.sessions[0]!.pendingIdeaCount = 1;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<App />);
    fireEvent.click(await screen.findByText("会话 a"));
    expect(screen.getByRole("button", { name: "带回 1 条" })).toBeVisible();
    expect(screen.getByText("待用原文")).toBeVisible();
    expect(screen.getByText("已带回原文")).not.toBeVisible();
    expect(screen.getByText("丢弃原文")).not.toBeVisible();
    expect(screen.queryByRole("combobox", { name: "记录用途" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(screen.getByText("已带回 · 1"));
    fireEvent.click(screen.getByRole("button", { name: "撤销带回想法 已带回原文" }));
    expect(calls.at(-1)).toMatchObject({ method: "idea.setStatus", id: "brought", status: "pending", expectedRevision: 2 });
    fireEvent.click(screen.getByText("已删除 · 1"));
    fireEvent.click(screen.getByRole("button", { name: "恢复想法 丢弃原文" }));
    expect(calls.at(-1)).toMatchObject({ method: "idea.setStatus", id: "discarded", status: "pending", expectedRevision: 3 });
    await waitFor(() => expect(screen.getByRole("button", { name: "彻底删除想法 丢弃原文" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "彻底删除想法 丢弃原文" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(calls.some(request => request.method === "idea.purge")).toBe(false);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "彻底删除想法 丢弃原文" }));
    expect(calls.at(-1)).toMatchObject({ method: "idea.purge", id: "discarded", expectedRevision: 3, operationId: expect.any(String) });
});

test("move selects a session or inbox and export delegates to Main without accepting a renderer path", async () => {
    workspace.ideas = [{ id: "move", sessionId: null, body: "待分配", status: "pending", revision: 4, createdAt: "2026-10-16", updatedAt: "2026-10-16" }];
    workspace.inboxIdeaCount = 1;
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "收件箱 · 1 条想法" }));
    fireEvent.change(screen.getByRole("combobox", { name: "移到会话 待分配" }), { target: { value: "b" } });
    expect(calls.at(-1)).toMatchObject({ method: "idea.move", id: "move", sessionId: "b", expectedRevision: 4, operationId: expect.any(String) });
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "导出全部旧数据为 JSON" }));
    expect(window.aimspan.exportLegacy).toHaveBeenCalledWith(expect.any(String));
    expect(calls.some(request => request.method === "legacy.export")).toBe(false);
});

test("rapid draft writes serialize revisions; in-flight idea save preserves newly typed text", async () => {
    const original = window.aimspan.call;
    let finishSave: (value: unknown) => void = () => {};
    window.aimspan.call = async request => {
        const result = await original(request);
        if (request.method === "idea.save") return new Promise(resolve => { finishSave = resolve; });
        return result;
    };
    render(<App />);
    fireEvent.click(await screen.findByText("会话 a"));
    const input = screen.getByRole("textbox", { name: "添加想法" });
    fireEvent.change(input, { target: { value: "一" } });
    fireEvent.change(input, { target: { value: "一二" } });
    fireEvent.change(input, { target: { value: "一二三" } });
    fireEvent.click(screen.getByRole("button", { name: "保存想法" }));
    await waitFor(() => expect(calls.some(request => request.method === "idea.save")).toBe(true));
    expect(calls.filter(request => request.method === "draft.save").map(request => request.expectedRevision)).toEqual([0, 1, 2]);
    fireEvent.change(input, { target: { value: "等待保存期间的新文字" } });
    finishSave({ id: "saved", revision: 1 });
    await waitFor(() => expect(screen.getByRole("button", { name: "保存想法" })).toBeEnabled());
    expect(input).toHaveValue("等待保存期间的新文字");
    expect(calls.filter(request => request.method === "draft.save").at(-1)).toMatchObject({ body: "等待保存期间的新文字", expectedRevision: 3 });
});

test("save errors preserve draft text and 4000 emoji are accepted while 4001 are blocked", async () => {
    const original = window.aimspan.call;
    window.aimspan.call = async request => {
        const result = await original(request);
        if (request.method === "idea.save") throw new Error("core.errorRecordChangedReloadBeforeSaving");
        return result;
    };
    render(<App />);
    fireEvent.click(await screen.findByText("会话 a"));
    const input = screen.getByRole("textbox", { name: "添加想法" });
    fireEvent.change(input, { target: { value: "😀".repeat(4000) } });
    const save = screen.getByRole("button", { name: "保存想法" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(await screen.findByRole("alert")).toHaveTextContent("记录已变化，请重新读取后保存");
    expect(input).toHaveValue("😀".repeat(4000));
    fireEvent.change(input, { target: { value: "😀".repeat(4001) } });
    expect(save).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("超出部分尚未保存");
});

test("R1 move targets contain only interactive root rows and the inbox", async () => {
    workspace.sessions.push(
        { ...workspace.sessions[0]!, id: "child", nativeId: "child", parentNativeId: "a", title: "隐藏子会话" },
        { ...workspace.sessions[0]!, id: "orphan", nativeId: "orphan", parentNativeId: "missing", title: "无父行子会话" },
        { ...workspace.sessions[0]!, id: "automated", nativeId: "automated", interactive: false, title: "非交互会话" },
        { ...workspace.sessions[0]!, id: "exec", nativeId: "exec", entrypoint: "codex_exec", title: "自动执行会话" },
    );
    workspace.sessions[1]!.archived = true;
    workspace.inboxIdeaCount = 1;
    workspace.ideas = [{ id: "move", sessionId: null, body: "不会失联", status: "pending", revision: 1, createdAt: "2026-10-16", updatedAt: "2026-10-16" }];
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "收件箱 · 1 条想法" }));
    const select = screen.getByRole("combobox", { name: "移到会话 不会失联" });
    expect(Array.from(select.querySelectorAll("option"), option => option.value)).toEqual(["", "a", "b"]);
});

test("R1 quit flush queues the latest draft before stop while an earlier acknowledgment is pending", async () => {
    let flush: (() => void) | undefined;
    Reflect.set(window.aimspan, "onFlushDrafts", (callback: () => void) => { flush = callback; return () => { flush = undefined; }; });
    let acknowledgeFirst: (value: unknown) => void = () => {};
    let persisted = "", revision = 0, stopped = false;
    const order: string[] = [];
    const original = window.aimspan.call;
    window.aimspan.call = async request => {
        if (request.method !== "draft.save") return original(request);
        calls.push(request);
        order.push(`draft:${request.body}`);
        expect(stopped).toBe(false);
        expect(request.expectedRevision).toBe(revision);
        persisted = request.body;
        const result = { target: request.target, body: persisted, revision: ++revision, updatedAt: "2026-10-16" };
        if (revision === 1) return new Promise(resolve => { acknowledgeFirst = () => resolve(result); });
        return result;
    };
    render(<App />);
    fireEvent.click(await screen.findByText("会话 a"));
    const input = screen.getByRole("textbox", { name: "添加想法" });
    fireEvent.change(input, { target: { value: "第一版" } });
    await waitFor(() => expect(persisted).toBe("第一版"));
    fireEvent.change(input, { target: { value: "第一版加上最后几个字😀" } });
    flush?.();
    order.push("stop"); stopped = true;
    expect(persisted).toBe("第一版加上最后几个字😀");
    acknowledgeFirst(null);
    await waitFor(() => expect(order).toEqual(["draft:第一版", "draft:第一版加上最后几个字😀", "stop"]));
});

test("T21 keeps the visit reply/anchor, updates activity and state, and expands only one card", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-16T09:00:00Z"));
    workspace.sessions[0]!.lastTurnEndAt = "2026-10-16T08:48:00Z";
    const original = window.aimspan.call;
    window.aimspan.call = async request => request.method === "catchup" ? (calls.push(request), { ...emptyCatchUp,
        activity: [{ at: "2026-10-16T08:48:00Z", kind: "message", text: "初始动态" }],
        lastAgentMessage: { body: `回复 ${request.sessionId}`, fromBeforeAnchor: false } }) : original(request);
    render(<App/>);
    fireEvent.click(await screen.findByText("会话 a"));
    await waitFor(() => expect(calls.filter(r => r.method === "session.viewed")).toHaveLength(1));
    expect(screen.getByText("初始动态")).not.toBeVisible();
    act(() => publish({ ...workspace, sessions: workspace.sessions.map(s => s.id === "a" ? { ...s, revision: 2, lastTurnEndAt: "2026-10-16T08:59:00Z", activity: [{ at: "2026-10-16T08:59:00Z", kind: "file", text: "src/new.ts" }], activityIncomplete: true } : s), seq: 2 }));
    expect(screen.getByText("回复 a")).toBeVisible();
    fireEvent.click(screen.getByText("过程 · 1 条"));
    expect(screen.getByText("回复 a")).toBeVisible();
    expect(screen.getByText("等你 · 1 分钟前结束")).toBeVisible();
    expect(screen.getByText("src/new.ts")).toBeVisible();
    expect(screen.getByText("更早的动态未读取")).toBeVisible();
    expect(screen.getAllByText("等你 · 1 分钟前结束")).toHaveLength(1);
    expect(calls.filter(r => r.method === "catchup")).toHaveLength(1);
    fireEvent.click(screen.getByText("会话 b"));
    await screen.findByText("回复 b");
    expect(screen.queryByText("回复 a")).toBeNull();
    expect(screen.getAllByLabelText("衔接卡")).toHaveLength(1);
    fireEvent.click(screen.getByText("会话 b"));
    expect(screen.queryByLabelText("衔接卡")).toBeNull();
    fireEvent.click(screen.getByText("会话 b"));
    await waitFor(() => expect(calls.filter(r => r.method === "session.viewed")).toHaveLength(3));
});
test("T7 hover and input focus freeze live sorting; the update pill applies without losing the draft", async () => {
    workspace.sessions[0]!.lastTurnEndAt = "2026-10-16T07:00:00Z";
    workspace.sessions[1]!.lastTurnEndAt = "2026-10-16T08:00:00Z";
    const { container } = render(<App/>);
    await screen.findByText("会话 a");
    const order = () => Array.from(container.querySelectorAll("[data-row-id]"), node => node.getAttribute("data-row-id"));
    fireEvent.mouseEnter(container.querySelector(".list-region")!);
    const reversed = { ...workspace, sessions: workspace.sessions.map(s => s.id === "b" ? { ...s, lastTurnEndAt: "2026-10-16T06:00:00Z" } : s), seq: 2 };
    act(() => publish(reversed));
    expect(order()).toEqual(["a", "b"]);
    fireEvent.click(screen.getByRole("button", { name: "有更新" }));
    expect(order()).toEqual(["b", "a"]);
    fireEvent.click(screen.getByText("会话 a"));
    const input = screen.getByRole("textbox", { name: "添加想法" });
    fireEvent.focus(input); fireEvent.change(input, { target: { value: "不丢失的草稿" } });
    fireEvent.mouseLeave(container.querySelector(".list-region")!);
    act(() => publish({ ...workspace, seq: 3 }));
    expect(order()).toEqual(["b", "a"]);
    expect(input).toHaveValue("不丢失的草稿");
    fireEvent.blur(input);
    // The pointer must be able to leave the list and reach the update pill.
    expect(order()).toEqual(["b", "a"]);
    fireEvent.click(screen.getByRole("button", { name: "有更新" }));
    expect(order()).toEqual(["a", "b"]);
    expect(screen.getByRole("textbox", { name: "添加想法" })).toBe(input);
});
test("T19 header brings all pending ideas; per-idea send selects one; undo expires after five seconds", async () => {
    workspace.ideas = ["one", "two"].map(id => ({ id, body: `想法 ${id}`, sessionId: "a", revision: 3, status: "pending", createdAt: "2026-10-16", updatedAt: "2026-10-16" }));
    const { container } = render(<App/>); fireEvent.click(await screen.findByText("会话 a"));
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    const primary = screen.getByRole("button", { name: "带回 2 条" });
    expect(primary.closest(".session-header")).not.toBeNull();
    expect(container.querySelector('[data-section="footer"]')).toBeNull();
    fireEvent.click(primary);
    await screen.findByRole("button", { name: "撤销" });
    expect(window.aimspan.bringBack).toHaveBeenCalledExactlyOnceWith({ sessionId: "a", ideas: [{ id: "one", revision: 3 }, { id: "two", revision: 3 }], operationId: expect.any(String) });
    expect(calls.some(r => r.method === "idea.setStatus")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await screen.findByText("已恢复为待用想法");
    expect(window.aimspan.undoBringBack).toHaveBeenCalledExactlyOnceWith("undo");
    vi.useFakeTimers();
    try {
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送想法 想法 two" })));
        expect(window.aimspan.bringBack).toHaveBeenLastCalledWith({ sessionId: "a", ideas: [{ id: "two", revision: 3 }], operationId: expect.any(String) });
        expect(screen.getByRole("button", { name: "撤销" })).toBeVisible();
        act(() => vi.advanceTimersByTime(5001));
        expect(screen.queryByRole("button", { name: "撤销" })).toBeNull();
        expect(screen.getByRole("status")).toHaveTextContent("已复制，尚未发送");
    } finally { vi.useRealTimers(); }
});
test("T7 settings save shortcuts and bubble preference and expose full diagnostics and import status", async () => {
    workspace.legacyImport = { databases: 1, sessions: 2, ideas: 3 };
    workspace.captureShortcutError = "快捷记录快捷键注册失败，可能已被占用。请修改后重试。";
    workspace.diagnostics = [{ code: "claude.source.unreadable" }, { code: "codex-stale" }];
    render(<App/>); fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    expect(screen.getByRole("alert")).toHaveTextContent("快捷记录快捷键注册失败");
    expect(screen.getByText("Codex 记录长时间未更新")).toBeVisible();
    expect(screen.getByText("已导入 1 个旧库、2 个会话、3 条想法")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "快捷记录" }), { target: { value: "CommandOrControl+Shift+I" } });
    fireEvent.change(screen.getByRole("textbox", { name: "显示／隐藏气泡" }), { target: { value: "CommandOrControl+Shift+B" } });
    fireEvent.click(screen.getByRole("button", { name: "保存快捷键" }));
    expect(calls.at(-1)).toMatchObject({ method: "settings.save", settings: { captureShortcut: "CommandOrControl+Shift+I", bubbleShortcut: "CommandOrControl+Shift+B" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "显示悬浮气泡" }));
    expect(calls.at(-1)).toMatchObject({ method: "settings.save", settings: { bubbleEnabled: false, notifications: true } });
    fireEvent.click(screen.getByRole("button", { name: "导出全部旧数据为 JSON" }));
    expect(window.aimspan.exportLegacy).toHaveBeenCalledWith(expect.any(String));
});

test.each([true, false])("settings retain explicit notifications=%s across bubble changes and toggle the shared DND timestamp", async notifications => {
    workspace = { ...workspace, settings: { ...DEFAULT_SETTINGS, language: "zh", notifications, notificationsExplicit: true, dndUntil: Date.now() + 3_600_000 } };
    render(<App/>); fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    expect(screen.getByRole("checkbox", { name: "免打扰 1 小时" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "显示悬浮气泡" }));
    expect(calls.at(-1)).toMatchObject({ method: "settings.save", settings: { bubbleEnabled: false, notifications, notificationsExplicit: true } });
    fireEvent.click(screen.getByRole("checkbox", { name: "免打扰 1 小时" }));
    expect(calls.at(-1)).toMatchObject({ method: "settings.save", settings: { dndUntil: 0 } });
    act(() => publish({ ...workspace, settings: { ...workspace.settings, dndUntil: 0 } }));
    fireEvent.click(screen.getByRole("checkbox", { name: "免打扰 1 小时" }));
    const request = calls.at(-1);
    expect(request?.method).toBe("settings.save");
    if (request?.method === "settings.save") expect(request.settings.dndUntil).toBeGreaterThan(Date.now() + 3_599_000);
    expect(screen.queryByText(/通知功能尚未开放/)).toBeNull();
});

test("T7 F5 footer summarizes diagnostics and settings use Chinese labels with abbreviated paths", async () => {
    const path = "/Users/__aimspan_fixture__/.codex/archived_sessions/" + "synthetic-directory/".repeat(8) + "rollout-fixture.jsonl.zst";
    workspace.diagnostics = [{ code: "codex-stale", path }, { code: "claude.registry.unreadable" }];
    const { container } = render(<App/>);
    await screen.findByText("会话 a");
    const footer = container.querySelector("footer")!;
    expect(footer).toHaveTextContent("2 个来源需要注意");
    expect(footer).not.toHaveTextContent("codex-stale");
    expect(footer).not.toHaveTextContent("/Users/");
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    expect(screen.getByText("Codex 记录长时间未更新")).toBeVisible();
    expect(screen.getByText("Claude 会话状态暂不可读取")).toBeVisible();
    expect(container.textContent).not.toContain("codex-stale");
    expect(container.textContent).not.toContain("/Users/__aimspan_fixture__");
    expect(container.textContent).toContain("~/.codex/");
    expect(container.textContent).toContain("…");
    expect(container.textContent).toContain("rollout-fixture.jsonl.zst");
});

test.each(["hover", "input"])("T7 R1 newly displayed rows keep arrival order across frozen updates (%s)", async mode => {
    workspace.sessions = [{ ...workspace.sessions[0]!, lastTurnEndAt: "2026-10-16T08:00:00Z" }];
    const { container } = render(<App/>);
    await screen.findByText("会话 a");
    const order = () => Array.from(container.querySelectorAll("[data-row-id]"), node => node.getAttribute("data-row-id"));
    if (mode === "hover") fireEvent.mouseEnter(container.querySelector(".list-region")!);
    else fireEvent.focus(screen.getByRole("textbox", { name: "搜索完整会话和想法" }));
    const add = (id: string, ended: string) => {
        workspace = { ...workspace, seq: workspace.seq + 1, sessions: [...workspace.sessions, {
            ...workspace.sessions[0]!, id, nativeId: id, title: `会话 ${id}`, lastTurnEndAt: ended,
        }] };
        act(() => publish(workspace));
    };
    add("b", "2026-10-16T07:00:00Z");
    expect(order()).toEqual(["a", "b"]);
    const b = container.querySelector('[data-row-id="b"]');
    add("c", "2026-10-16T06:00:00Z");
    expect(order()).toEqual(["a", "b", "c"]);
    expect(container.querySelector('[data-row-id="b"]')).toBe(b);
    act(() => publish({ ...workspace, seq: workspace.seq + 1, sessions: [...workspace.sessions].reverse() }));
    expect(order()).toEqual(["a", "b", "c"]);
    if (mode === "hover") fireEvent.mouseLeave(container.querySelector(".list-region")!);
    else fireEvent.blur(screen.getByRole("textbox", { name: "搜索完整会话和想法" }));
    add("d", "2026-10-16T05:00:00Z");
    expect(order()).toEqual(["a", "b", "c", "d"]);
    fireEvent.click(screen.getByRole("button", { name: "有更新" }));
    expect(order()).toEqual(["d", "c", "b", "a"]);
});

test("T7 R1 a naturally sorted arrival remains frozen after pointer exit until updates are applied", async () => {
    workspace.sessions = [{ ...workspace.sessions[0]!, lastTurnEndAt: "2026-10-16T08:00:00Z" }];
    const { container } = render(<App/>);
    await screen.findByText("会话 a");
    const order = () => Array.from(container.querySelectorAll("[data-row-id]"), node => node.getAttribute("data-row-id"));
    fireEvent.mouseEnter(container.querySelector(".list-region")!);
    workspace = { ...workspace, sessions: [...workspace.sessions, { ...workspace.sessions[0]!, id: "b", nativeId: "b", title: "会话 b", lastTurnEndAt: "2026-10-16T09:00:00Z" }] };
    act(() => publish(workspace));
    expect(order()).toEqual(["a", "b"]);
    fireEvent.mouseLeave(container.querySelector(".list-region")!);
    act(() => publish({ ...workspace, sessions: [...workspace.sessions, { ...workspace.sessions[0]!, id: "c", nativeId: "c", title: "会话 c", lastTurnEndAt: "2026-10-16T07:00:00Z" }] }));
    expect(order()).toEqual(["a", "b", "c"]);
    fireEvent.click(screen.getByRole("button", { name: "有更新" }));
    expect(order()).toEqual(["c", "a", "b"]);
});

test("T14 header is one row with accessible icons; source chips only filter All; clean footer and inbox are absent", async () => {
    workspace.sessions[1]!.agent = "claude-code";
    const { container } = render(<App/>);
    await screen.findByText("会话 a");
    const header = within(container.querySelector("header")!);
    expect(header.queryByRole("heading")).toBeNull();
    expect(header.getByRole("textbox", { name: "搜索完整会话和想法" })).toBeVisible();
    expect(header.getByRole("navigation", { name: "会话视图" })).toBeVisible();
    for (const name of ["固定为窗口", "设置"]) {
        const button = header.getByRole("button", { name });
        expect(button).toHaveAttribute("title", name);
        expect(button.textContent).toBe("");
    }
    expect(screen.queryByRole("group", { name: "来源 App" })).toBeNull();
    expect(container.querySelector("footer")).toBeNull();
    expect(screen.queryByText(/收件箱 ·/)).toBeNull();
    expect(screen.queryByRole("button", { name: "刷新来源" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "全部 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    expect(screen.queryByText("会话 a")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "活跃 2" }));
    expect(screen.getByRole("heading", { name: "会话 a" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "会话 b" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "来源 App" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新来源" }));
    expect(calls.at(-1)).toEqual({ method: "scan" });
});

test("T14 diagnostics footer opens settings; only pending inbox ideas expose the row", async () => {
    workspace.diagnostics = [{ code: "claude.source.unreadable" }, { code: "codex-read" }];
    workspace.ideas = [{ id: "history", sessionId: null, body: "历史", status: "brought", revision: 1, createdAt: "2026-10-16", updatedAt: "2026-10-16" }];
    const { container } = render(<App/>);
    await screen.findByText("会话 a");
    expect(screen.queryByText(/收件箱 ·/)).toBeNull();
    expect(container.querySelector("footer")).toHaveTextContent("2 个来源需要注意 · 查看");
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    expect(screen.getByText("来源诊断")).toBeVisible();
    expect(screen.getByRole("button", { name: "刷新来源" })).toBeVisible();
    act(() => publish({ ...workspace, diagnostics: [], inboxIdeaCount: 1, ideas: workspace.ideas.map(i => ({ ...i, status: "pending" })) }));
    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
    expect(screen.getByRole("button", { name: "收件箱 · 1 条想法" })).toBeVisible();
    expect(container.querySelector("footer")).toBeNull();
    act(() => publish({ ...workspace, diagnostics: [], inboxIdeaCount: 0 }));
    expect(screen.queryByText(/收件箱 ·/)).toBeNull();
});

test("T14 arrows cross virtualized groups, Enter toggles without stealing focus, and search finds offscreen ideas", async () => {
    const user = userEvent.setup();
    vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 9, 21, 12).getTime());
    workspace.sessions = Array.from({ length: 32 }, (_, n) => ({ ...workspace.sessions[0]!, id: `row-${n}`, nativeId: `row-${n}`, title: `分组会话 ${n}`,
        state: "idle", lastActivityAt: new Date(2026, 9, n < 8 ? 21 : n < 16 ? 20 : n < 24 ? 19 : 1, 12, 32 - n).toISOString() }));
    workspace.ideas = [{ id: "deep", sessionId: "row-31", body: "深处想法", status: "pending", revision: 1, createdAt: "2026-10-16", updatedAt: "2026-10-16" }];
    const { container } = render(<App/>);
    await user.click(await screen.findByRole("button", { name: "全部 32" }));
    const list = container.querySelector<HTMLElement>(".list-region")!;
    act(() => list.focus());
    expect(screen.getByRole("list")).toHaveAccessibleName("会话列表，共 32 个会话");
    for (let n = 1; n < 32; n++) {
        await user.keyboard("{ArrowDown}");
        const row = container.querySelector(`[data-row-id="row-${n}"]`)!;
        expect(row.querySelector(".session-toggle")).toHaveFocus();
        expect(row.querySelector("article")).toHaveClass("keyboard-selected");
        if ([8, 16, 24].includes(n)) expect(within(row.parentElement!).getByRole("heading", { name: n === 8 ? "昨天" : n === 16 ? "本周" : "更早" })).toHaveClass("group-heading");
    }
    expect(screen.getAllByRole("listitem").length).toBeLessThan(15);
    expect(screen.getByRole("list").scrollTop).toBeGreaterThan(0);
    await user.keyboard("{ArrowDown}{Enter}");
    const toggle = screen.getByRole("heading", { name: "分组会话 31" }).closest("button")!;
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "添加想法" })).not.toHaveFocus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("heading", { name: "分组会话 30" }).closest("button")).toHaveFocus();
    await user.keyboard("/");
    const search = screen.getByRole("textbox", { name: "搜索完整会话和想法" });
    expect(search).toHaveFocus();
    await user.type(search, "深处想法");
    expect(search).toHaveFocus();
    expect(screen.getByRole("heading", { name: "分组会话 31" })).toBeVisible();
    expect(screen.getByRole("list")).toHaveAccessibleName("会话列表，共 1 个会话");
    expect(screen.getByRole("heading", { name: "分组会话 31" }).closest("article")).toHaveClass("keyboard-selected");
});

test("T19 command Enter brings every pending idea or opens; command O always opens only", async () => {
    const user = userEvent.setup();
    workspace.ideas = ["first", "second"].map(id => ({ id, sessionId: "a", body: id, status: "pending", revision: 3, createdAt: "2026-10-16", updatedAt: "2026-10-16" }));
    render(<App/>);
    await user.click(await screen.findByText("会话 a"));
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(window.aimspan.bringBack).toHaveBeenCalledExactlyOnceWith({ sessionId: "a", ideas: [{ id: "first", revision: 3 }, { id: "second", revision: 3 }], operationId: expect.any(String) });
    expect(window.aimspan.reveal).not.toHaveBeenCalled();
    await user.keyboard("{Meta>}o{/Meta}");
    expect(window.aimspan.reveal).toHaveBeenCalledExactlyOnceWith("a");
    await user.keyboard("{Enter}{Meta>}{Enter}{/Meta}");
    expect(window.aimspan.bringBack).toHaveBeenCalledTimes(2);
    await user.keyboard("{ArrowDown}{Meta>}{Enter}{/Meta}");
    expect(window.aimspan.reveal).toHaveBeenLastCalledWith("b");
});

test.each([false, true])("T14 Escape closes menu then card then panel (pinned=%s)", async pinned => {
    const user = userEvent.setup();
    workspace.settings = { ...workspace.settings, pinned };
    render(<App/>);
    await user.click(await screen.findByText("会话 a"));
    await user.click(screen.getByRole("button", { name: "更多会话操作" }));
    const menu = screen.getByRole("menu");
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(within(menu).getByRole("menuitem", { name: /暂时移出活跃/ })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "更多会话操作" })).toHaveFocus();
    expect(screen.getByRole("heading", { name: "会话 a" }).closest("button")).toHaveAttribute("aria-expanded", "true");
    expect(window.aimspan.hide).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("heading", { name: "会话 a" }).closest("button")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("heading", { name: "会话 a" }).closest("button")).toHaveFocus();
    expect(window.aimspan.hide).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(window.aimspan.hide).toHaveBeenCalledOnce();
});

test("T24 R1 keyboard-opened Settings keeps focus in the panel so Escape still hides it", async () => {
    const user = userEvent.setup();
    render(<App/>);
    await screen.findByText("会话 a");
    screen.getByRole("button", { name: "设置" }).focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).not.toBe(document.body);
    await user.keyboard("{Escape}");
    expect(window.aimspan.hide).toHaveBeenCalledOnce();
});

test("T14 inputs keep arrows, slash and IME keys; Escape cancels composition before panel handling", async () => {
    render(<App/>);
    const search = await screen.findByRole("textbox", { name: "搜索完整会话和想法" });
    act(() => search.focus());
    fireEvent.compositionStart(search);
    for (const key of ["Enter", "Escape", "ArrowDown", "/"]) fireEvent.keyDown(search, { key });
    expect(search).toHaveFocus();
    expect(window.aimspan.hide).not.toHaveBeenCalled();
    expect(calls.some(r => r.method === "catchup")).toBe(false);
    fireEvent.compositionEnd(search);
    fireEvent.click(screen.getByRole("heading", { name: "会话 a" }));
    const input = screen.getByRole("textbox", { name: "添加想法" });
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "中文草稿" } });
    fireEvent.compositionStart(input);
    for (const key of ["Enter", "Escape", "ArrowDown", "/"]) fireEvent.keyDown(input, { key });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "/" });
    fireEvent.keyDown(input, { key: "o", metaKey: true });
    expect(input).toHaveFocus();
    expect(calls.some(r => r.method === "idea.save")).toBe(false);
    expect(window.aimspan.reveal).not.toHaveBeenCalled();
    expect(window.aimspan.hide).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "添加想法" })).toBeNull();
    expect(screen.getByRole("heading", { name: "会话 a" }).closest("button")).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(screen.getByRole("textbox", { name: "添加想法" })).toHaveValue("中文草稿");
});

test("T14 keyboard browsing freezes group membership until updates are applied", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 9, 21, 12).getTime());
    workspace.sessions[0]!.lastActivityAt = new Date(2026, 9, 21, 9).toISOString();
    workspace.sessions[1]!.lastActivityAt = new Date(2026, 9, 20, 9).toISOString();
    const { container } = render(<App/>);
    fireEvent.click(await screen.findByRole("button", { name: "全部 2" }));
    act(() => container.querySelector<HTMLElement>(".list-region")!.focus());
    workspace = { ...workspace, sessions: workspace.sessions.map(s => ({ ...s, lastActivityAt: new Date(2026, 9, 21, 10).toISOString() })) };
    act(() => publish(workspace));
    const row = container.querySelector('[data-row-id="b"]')!;
    expect(within(row.parentElement!).getByRole("heading", { name: "昨天" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "有更新" }));
    expect(screen.queryByRole("heading", { name: "昨天" })).toBeNull();
    expect(within(container.querySelector('[data-row-id="b"]')!.parentElement!).getByRole("heading", { name: "今天" })).toBeVisible();
});

test("T14 R1 applying updates restores the selected row and keyboard handling", async () => {
    const user = userEvent.setup();
    workspace.sessions[0]!.lastTurnEndAt = "2026-10-16T08:00:00Z";
    workspace.sessions[1]!.lastTurnEndAt = "2026-10-16T09:00:00Z";
    const { container } = render(<App/>);
    await screen.findByText("会话 a");
    act(() => container.querySelector<HTMLElement>(".list-region")!.focus());
    await user.keyboard("{ArrowDown}");
    const row = (id: string) => screen.getByRole("heading", { name: `会话 ${id}` }).closest("button")!;
    expect(row("b")).toHaveFocus();
    act(() => publish({ ...workspace, sessions: workspace.sessions.map(s => s.id === "b" ? { ...s, lastTurnEndAt: "2026-10-16T07:00:00Z" } : s) }));
    await user.click(screen.getByRole("button", { name: "有更新" }));
    expect(screen.queryByRole("button", { name: "有更新" })).toBeNull();
    expect(Array.from(container.querySelectorAll("[data-row-id]"), el => el.getAttribute("data-row-id"))).toEqual(["b", "a"]);
    expect(row("b")).toHaveFocus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(row("a")).toHaveFocus();
    expect(row("a")).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(row("a")).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{Escape}");
    expect(window.aimspan.hide).toHaveBeenCalledOnce();
});

test("T14 R1 applying updates with no selected row restores the list container", async () => {
    const user = userEvent.setup();
    const { container } = render(<App/>);
    await screen.findByText("会话 a");
    const list = container.querySelector<HTMLElement>(".list-region")!;
    act(() => list.focus());
    act(() => publish({ ...workspace, sessions: [] }));
    expect(screen.queryByRole("list")).toBeNull();
    await user.click(screen.getByRole("button", { name: "有更新" }));
    expect(list).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(window.aimspan.hide).toHaveBeenCalledOnce();
});

test.each(["empty search", "settings"])("T14 R1 consumed focus requests do not replay after %s remount", async route => {
    const user = userEvent.setup();
    const { container } = render(<App/>);
    await screen.findByText("会话 a");
    act(() => container.querySelector<HTMLElement>(".list-region")!.focus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByText("会话 b").closest("button")).toHaveFocus();
    let search = screen.getByRole("textbox", { name: "搜索完整会话和想法" });
    if (route === "empty search") {
        await user.keyboard("/");
        await user.keyboard("no-match");
        expect(screen.queryByRole("list")).toBeNull();
        await user.clear(search);
    } else {
        await user.click(screen.getByRole("button", { name: "设置" }));
        expect(screen.queryByRole("list")).toBeNull();
        await user.click(screen.getByRole("button", { name: "返回列表" }));
        search = screen.getByRole("textbox", { name: "搜索完整会话和想法" });
        await user.click(search);
    }
    expect(screen.getByRole("list")).toBeVisible();
    expect(search).toHaveFocus();
    // Keyboard input without a helper click catches focus being stolen during remount.
    await user.keyboard("会话 a");
    expect(search).toHaveValue("会话 a");
    expect(search).toHaveFocus();
    expect(screen.queryByText("会话 b")).toBeNull();
});

test.each(["text", "textarea", "select", "checkbox"])("T14 R1 focus requests never take focus from a focused %s input", kind => {
    const content = (focusRequest: { id: string; sequence: number } | null) => <>
        {kind === "textarea" ? <textarea aria-label="正在输入"/> : kind === "select" ? <select aria-label="正在输入"><option>选项</option></select> : <input aria-label="正在输入" type={kind}/>}
        <VirtualList ids={["a"]} expanded={null} focusRequest={focusRequest} render={() => <button className="session-toggle">会话 a</button>}/>
    </>;
    const { rerender } = render(content(null));
    const input = screen.getByLabelText("正在输入");
    act(() => input.focus());
    rerender(content({ id: "a", sequence: 1 }));
    expect(input).toHaveFocus();
});

test("T15 all rows hide raw title IDs, expose identity as a tooltip and distinguish automatic sessions", async () => {
    const base = workspace.sessions[0]!;
    workspace.sessions = [base,
        { ...base, id: "exec", nativeId: "fixture-exec", title: "fixture-exec", entrypoint: "codex_exec" },
        { ...base, id: "sdk", nativeId: "fixture-sdk", agent: "claude-code", title: "自动整理", entrypoint: "sdk-ts" },
        { ...base, id: "auto", nativeId: "fixture-auto", title: "后台任务", interactive: false },
        { ...base, id: "blank", nativeId: "fixture-blank", title: "  " },
    ];
    render(<App/>);
    await screen.findByText("会话 a");
    expect(screen.queryByText("自动")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "全部 5" }));
    expect(screen.getAllByText("自动")).toHaveLength(3);
    expect(screen.getAllByRole("heading", { name: "未命名会话" })).toHaveLength(2);
    expect(screen.getByTitle("会话 ID：fixture-exec")).toHaveTextContent("未命名会话");
    expect(screen.queryByText("fixture-exec")).toBeNull();
    expect(screen.getByText("会话 a").closest("article")).not.toHaveTextContent("自动");
    fireEvent.click(screen.getByTitle("会话 ID：fixture-exec"));
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ method: "catchup", sessionId: "exec" })));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索完整会话和想法" }), { target: { value: "未命名会话" } });
    expect(screen.getAllByRole("heading", { name: "未命名会话" })).toHaveLength(2);
    expect(workspace.sessions[1]!.title).toBe("fixture-exec");
});

test.each(["codex", "claude"] as const)("T18 inbox %s action uses Main with the selected revision and the existing five-second undo", async app => {
    workspace.ideas = [{ id: "inbox-new", body: "  收件箱原文😀  ", sessionId: null, revision: 3, status: "pending", createdAt: "2026-10-16", updatedAt: "2026-10-16" }];
    workspace.inboxIdeaCount = 1;
    render(<App/>); fireEvent.click(await screen.findByText("收件箱 · 1 条想法"));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^开新会话 · ${app === "codex" ? "Codex" : "Claude"}：`) }));
    await screen.findByRole("button", { name: "撤销" });
    expect(window.aimspan.newSession).toHaveBeenCalledExactlyOnceWith({ kind: "inbox", app, idea: { id: "inbox-new", revision: 3 }, operationId: expect.any(String) });
    expect(calls.some(r => r.method === "idea.setStatus")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await screen.findByText("已恢复为待用想法");
    expect(window.aimspan.undoBringBack).toHaveBeenCalledExactlyOnceWith("new-undo");
    vi.useFakeTimers();
    try {
        await act(async () => fireEvent.click(screen.getByRole("button", { name: /^开新会话 · Claude：/ })));
        expect(screen.getByRole("button", { name: "撤销" })).toBeVisible();
        act(() => vi.advanceTimersByTime(5001));
        expect(screen.queryByRole("button", { name: "撤销" })).toBeNull();
    } finally { vi.useRealTimers(); }
});
test("T18 only pending inbox ideas expose new-session actions", async () => {
    workspace.ideas = ["pending", "brought", "discarded"].map((status, index) => ({ id: status, body: status, sessionId: null, revision: index + 1, status: status as "pending" | "brought" | "discarded", createdAt: "2026-10-16", updatedAt: "2026-10-16" }));
    workspace.inboxIdeaCount = 1;
    render(<App/>); fireEvent.click(await screen.findByText("收件箱 · 1 条想法"));
    expect(screen.getAllByRole("button", { name: /^开新会话 · Codex：/, hidden: true })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^开新会话 · Claude：/, hidden: true })).toHaveLength(1);
    fireEvent.click(screen.getByRole("heading", { name: "会话 a" }));
    expect(screen.queryByRole("button", { name: /开新会话/ })).toBeNull();
});

test("T19 inline edit is IME safe, saves verbatim at the captured revision and cancels without touching the add draft", async () => {
    workspace.ideas = [{ id: "edit", sessionId: "a", body: "原文", status: "pending", revision: 4, createdAt: "2026-10-16", updatedAt: "2026-10-16" }];
    const original = window.aimspan.call;
    window.aimspan.call = async request => {
        const result = await original(request);
        return request.method === "idea.save" ? { ...workspace.ideas[0], body: request.body, revision: 5 } : result;
    };
    render(<App/>); fireEvent.click(await screen.findByText("会话 a"));
    const add = screen.getByRole("textbox", { name: "添加想法" });
    fireEvent.change(add, { target: { value: "尚未保存的新增草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "编辑想法 原文" }));
    const edit = screen.getByRole("textbox", { name: "编辑想法 原文" });
    expect(edit.closest(".idea")).not.toBeNull(); expect(edit).toHaveFocus();
    fireEvent.change(edit, { target: { value: "  新原文😀\n第二行  " } });
    for (const options of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) fireEvent.keyDown(edit, { key: "Enter", ...options });
    fireEvent.compositionStart(edit); fireEvent.keyDown(edit, { key: "Enter" }); fireEvent.keyDown(edit, { key: "Escape" });
    expect(edit).toBeInTheDocument();
    expect(calls.some(r => r.method === "idea.save")).toBe(false);
    fireEvent.compositionEnd(edit); fireEvent.keyDown(edit, { key: "Enter" });
    await waitFor(() => expect(edit).not.toBeInTheDocument());
    expect(calls.filter(r => r.method === "idea.save")).toEqual([expect.objectContaining({ id: "edit", sessionId: "a", body: "  新原文😀\n第二行  ", expectedRevision: 4, operationId: expect.any(String) })]);
    expect(add).toHaveValue("尚未保存的新增草稿");
    fireEvent.click(screen.getByRole("button", { name: "编辑想法 原文" }));
    fireEvent.change(screen.getByRole("textbox", { name: "编辑想法 原文" }), { target: { value: "取消这一版" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "编辑想法 原文" }), { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "编辑想法 原文" })).toBeNull();
    expect(screen.getByRole("button", { name: "编辑想法 原文" })).toHaveFocus();
    expect(screen.getByLabelText("衔接卡")).toBeVisible();
    expect(calls.filter(r => r.method === "idea.save")).toHaveLength(1);
    expect(add).toHaveValue("尚未保存的新增草稿");
    expect(window.aimspan.hide).not.toHaveBeenCalled();
});

test("T19 revision conflict retains inline text and never adopts an incoming revision silently", async () => {
    workspace.ideas = [{ id: "edit", sessionId: "a", body: "原文", status: "pending", revision: 4, createdAt: "2026-10-16", updatedAt: "2026-10-16" }];
    const original = window.aimspan.call;
    window.aimspan.call = async request => {
        const result = await original(request);
        if (request.method === "idea.save") throw new Error("core.errorRecordChangedReloadBeforeSaving");
        return result;
    };
    render(<App/>); fireEvent.click(await screen.findByText("会话 a"));
    fireEvent.click(screen.getByRole("button", { name: "编辑想法 原文" }));
    const edit = screen.getByRole("textbox", { name: "编辑想法 原文" });
    fireEvent.change(edit, { target: { value: "不能丢的修改" } });
    act(() => publish({ ...workspace, ideas: [{ ...workspace.ideas[0]!, revision: 5, body: "另一端修改" }] }));
    fireEvent.keyDown(edit, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("记录已变化，请重新读取后保存");
    expect(edit).toHaveValue("不能丢的修改");
    expect(calls.filter(r => r.method === "idea.save").at(-1)).toMatchObject({ body: "不能丢的修改", expectedRevision: 4 });
    fireEvent.keyDown(edit, { key: "Escape" });
    expect(screen.getByText("另一端修改")).toBeVisible();
});

test("T19 delete uses returned revision for undo, expires at five seconds, and keeps deleted history", async () => {
    workspace.ideas = [{ id: "delete", sessionId: "a", body: "保留记录", status: "pending", revision: 4, createdAt: "2026-10-16", updatedAt: "2026-10-16" }];
    const original = window.aimspan.call;
    window.aimspan.call = async request => {
        const result = await original(request);
        if (request.method !== "idea.setStatus") return result;
        const previous = workspace.ideas[0]!;
        if (previous.revision !== request.expectedRevision) throw new Error("Conflict");
        const saved = { ...previous, status: request.status, revision: previous.revision + 1 };
        workspace = { ...workspace, ideas: [saved] }; publish(workspace); return saved;
    };
    render(<App/>); fireEvent.click(await screen.findByText("会话 a"));
    fireEvent.click(screen.getByRole("button", { name: "删除想法 保留记录" }));
    await screen.findByRole("button", { name: "撤销" });
    expect(screen.getByText("已删除 · 1")).toBeVisible(); expect(screen.getByText("保留记录")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await screen.findByText("已恢复为待用想法");
    expect(screen.getByText("保留记录")).toBeVisible();
    expect(calls.filter(r => r.method === "idea.setStatus")).toEqual([
        expect.objectContaining({ status: "discarded", expectedRevision: 4, operationId: expect.any(String) }),
        expect.objectContaining({ status: "pending", expectedRevision: 5, operationId: expect.any(String) }),
    ]);
    vi.useFakeTimers();
    try {
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "删除想法 保留记录" })));
        act(() => vi.advanceTimersByTime(4999)); expect(screen.getByRole("button", { name: "撤销" })).toBeVisible();
        act(() => vi.advanceTimersByTime(1)); expect(screen.queryByRole("button", { name: "撤销" })).toBeNull();
        expect(screen.getByText("已删除 · 1")).toBeVisible();
    } finally { vi.useRealTimers(); }
    expect(calls.some(r => r.method === "idea.purge")).toBe(false);
});

function render(ui: ReactElement) { return renderUI(ui, { wrapper: ({ children }: { children: ReactNode }) => <LanguageContext.Provider value="zh">{children}</LanguageContext.Provider> }); }

test("T23 English panel and catch-up card switch language immediately from Settings", async () => {
    workspace.settings = { ...workspace.settings, language: "en" };
    workspace.sessions[0] = { ...workspace.sessions[0]!, state: "running", surface: "desktop", lastPromptAt: new Date(Date.now() - 180_000).toISOString(), pendingIdeaCount: 1 };
    const original = window.aimspan.call;
    window.aimspan.call = async request => {
        if (request.method === "settings.save") {
            workspace = { ...workspace, settings: request.settings };
            publish(workspace);
            return request.settings;
        }
        return original(request);
    };
    render(<App/>);
    await screen.findByText("会话 a");
    expect(screen.getByText("1 idea")).toBeVisible();
    fireEvent.click(screen.getByText("会话 a"));
    expect(screen.getByText("Codex Desktop")).toBeVisible();
    expect(screen.getByRole("heading", { name: "My ideas" })).toBeVisible();
    expect(await screen.findByText("Running · 3 min")).toBeVisible();
    expect(await screen.findByRole("heading", { name: "Recent activity" })).toBeVisible();
    expect(screen.getByLabelText("catch-up card")).toBeVisible();
    const input = screen.getByRole("textbox", { name: "Add idea" });
    fireEvent.change(input, { target: { value: "用户原文 stays unchanged" } });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const languages = screen.getByRole("radiogroup", { name: "Language" });
    expect(within(languages).getByRole("radio", { name: "English" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(languages).getByRole("radio", { name: "中文" }));
    expect(await screen.findByRole("heading", { name: "语言" })).toBeVisible();
    expect(document.documentElement.lang).toBe("zh-CN");
    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
    expect(screen.getByRole("textbox", { name: "添加想法" })).toHaveValue("用户原文 stays unchanged");
    expect(screen.getByText("Codex 桌面")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("radio", { name: "English" }));
    expect(await screen.findByRole("heading", { name: "Language" })).toBeVisible();
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe("AimSpan");
    expect(calls.filter(r => r.method === "session.viewed")).toHaveLength(1);
});

test("T23 a settings publication wins over an older initial workspace response", async () => {
    let resolve!: (value: Workspace) => void;
    window.aimspan.call = () => new Promise(done => { resolve = done; });
    render(<App/>);
    const next: Workspace = { ...workspace, settings: { ...workspace.settings, language: "en" } };
    act(() => publish(next));
    expect(screen.getByRole("button", { name: "Settings" })).toBeVisible();
    await act(async () => resolve(workspace));
    expect(screen.getByRole("button", { name: "Settings" })).toBeVisible();
    expect(document.documentElement.lang).toBe("en");
});


test("T23 R1 an existing open-session notice retranslates on a language switch", async () => {
    const shell = { openExternal: vi.fn(async () => {}), openPath: vi.fn(async () => "") };
    workspace.sessions[0] = { ...workspace.sessions[0]!, agent: "claude-code", title: "原文 title" };
    window.aimspan.reveal = async () => openSession(workspace.sessions[0]!, shell, "zh");
    render(<App/>);
    fireEvent.click(await screen.findByText("原文 title"));
    fireEvent.click(screen.getByRole("button", { name: "打开原会话" }));
    expect(await screen.findByRole("status")).toHaveTextContent("切到 Claude 会话：原文 title · project");
    act(() => publish({ ...workspace, settings: { ...workspace.settings, language: "en" } }));
    expect(screen.getByRole("button", { name: "Settings" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Switch to Claude session: 原文 title · project");
    act(() => publish(workspace));
    expect(screen.getByRole("status")).toHaveTextContent("切到 Claude 会话：原文 title · project");
    expect(shell.openPath).toHaveBeenCalledOnce();
});

test("T23 R1 a nested bring-back notice retranslates after its undo expires", async () => {
    const shell = { openExternal: vi.fn(async () => {}), openPath: vi.fn(async () => "") };
    workspace.ideas = [{ id: "notice-idea", revision: 1, updatedAt: "2026-10-18", createdAt: "2026-10-18", sessionId: "a", status: "pending", body: "  原文 idea  " }];
    const writeText = vi.fn();
    const service = new BringBack({ language: () => "zh", writeText,
        open: session => openSession(session, shell, "zh"),
        call: async request => request.method === "workspace" ? workspace : { ...workspace.ideas[0]!, revision: 2, status: "brought" },
    });
    window.aimspan.bringBack = request => service.bringBack(request);
    render(<App/>);
    fireEvent.click(await screen.findByText("会话 a"));
    vi.useFakeTimers();
    try {
        await act(async () => { fireEvent.click(screen.getByRole("button", { name: "带回 1 条" })); });
        expect(screen.getByRole("status")).toHaveTextContent("已复制 1 条想法，尚未发送。已请求打开原 Codex 会话");
        expect(screen.getByRole("button", { name: "撤销" })).toBeVisible();
        act(() => vi.advanceTimersByTime(5001));
        expect(screen.queryByRole("button", { name: "撤销" })).toBeNull();
        act(() => publish({ ...workspace, settings: { ...workspace.settings, language: "en" } }));
        expect(screen.getByRole("status")).toHaveTextContent("Copied 1 idea; not sent. Requested opening the Codex session");
        act(() => publish(workspace));
        expect(screen.getByRole("status")).toHaveTextContent("已复制 1 条想法，尚未发送。已请求打开原 Codex 会话");
        expect(writeText).toHaveBeenCalledExactlyOnceWith("  原文 idea  ");
        expect(shell.openExternal).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
});

test("T23 R1 the restored-idea notice keeps its reference after undo", async () => {
    workspace.ideas = [{ id: "restored", sessionId: "a", body: "原文", status: "pending", revision: 1, createdAt: "2026-10-18", updatedAt: "2026-10-18" }];
    render(<App/>);
    fireEvent.click(await screen.findByText("会话 a"));
    fireEvent.click(screen.getByRole("button", { name: "带回 1 条" }));
    fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
    expect(await screen.findByText("已恢复为待用想法")).toBeVisible();
    act(() => publish({ ...workspace, settings: { ...workspace.settings, language: "en" } }));
    expect(screen.getByRole("status")).toHaveTextContent("Idea restored to pending");
});

test("T24 result handled button uses the latest revision and does not open the native session", async () => {
    render(<App/>);
    fireEvent.click(await screen.findByText("会话 a"));
    await screen.findByRole("heading", { name: "执行结果" });
    act(() => publish({ ...workspace, sessions: workspace.sessions.map(s => s.id === "a" ? { ...s, revision: 7 } : s) }));
    fireEvent.click(screen.getByRole("button", { name: "已处理" }));
    expect(calls.at(-1)).toMatchObject({ method: "session.handled", sessionId: "a", expectedRevision: 7, operationId: expect.any(String) });
    expect(calls.filter(request => request.method === "session.viewed")).toHaveLength(1);
    expect(window.aimspan.reveal).not.toHaveBeenCalled();
    act(() => publish({ ...workspace, sessions: workspace.sessions.map(s => s.id === "a" ? { ...s, state: "idle" as const } : s) }));
    expect(screen.queryByRole("button", { name: "已处理" })).toBeNull();
});

test("T24 language radios support keyboard switching without losing a draft; GitHub opens only through Main", async () => {
    const user = userEvent.setup();
    const original = window.aimspan.call;
    window.aimspan.call = async request => {
        if (request.method === "settings.save") {
            workspace = { ...workspace, settings: request.settings };
            publish(workspace);
            return request.settings;
        }
        return original(request);
    };
    render(<App/>);
    fireEvent.click(await screen.findByText("会话 a"));
    fireEvent.change(screen.getByRole("textbox", { name: "添加想法" }), { target: { value: "  保留 idea\n原文  " } });
    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("heading", { level: 1, name: "设置" })).toBeVisible();
    expect(document.querySelector(".settings-card")).toContainElement(screen.getByRole("radiogroup", { name: "语言" }));
    act(() => screen.getByRole("radio", { name: "中文" }).focus());
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "English" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "English" })).toHaveFocus();
    expect(screen.getByText("AimSpan 0.2.0 · MIT License")).toBeVisible();
    expect(window.aimspan.openLink).not.toHaveBeenCalled();
    await user.click(screen.getByRole("link", { name: "GitHub" }));
    expect(window.aimspan.openLink).toHaveBeenCalledExactlyOnceWith("https://github.com/Asxing/aimspan");
    await user.click(screen.getByRole("button", { name: "Back to list" }));
    expect(screen.getByRole("textbox", { name: "Add idea" })).toHaveValue("  保留 idea\n原文  ");
});

test.each(["running", "waiting", "idle", "unknown"] as const)("T24 expanded %s has one status line above its ideas", async state => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-16T09:00:00Z"));
    workspace.sessions = [{ ...workspace.sessions[0]!, state, lastPromptAt: "2026-10-16T08:50:00Z", lastTurnEndAt: state === "running" ? "2026-10-16T08:00:00Z" : "2026-10-16T08:58:00Z" }];
    const { container } = render(<App/>);
    fireEvent.click(await screen.findByText("会话 a"));
    await screen.findByRole("heading", { name: state === "running" ? "最近动态" : "执行结果" });
    const summary = container.querySelector(".catchup-summary")!;
    expect(container.querySelectorAll(".status")).toHaveLength(1);
    expect(summary).toHaveTextContent(state === "running" ? /运行中 · 已运行 10 分钟/ : state === "waiting" ? /等你 · 2 分钟前结束/ : state === "idle" ? /空闲 · 2 分钟前结束/ : /状态待确认/);
    expect(summary.compareDocumentPosition(screen.getByRole("heading", { name: "我的想法" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
