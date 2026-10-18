// @vitest-environment node
import { messageRef, messageResult, renderMessage } from "../shared/i18n/messages";
import { expect, test, vi } from "vitest";
import { type CoreRequest, type Idea, type Workspace, formatBringBack } from "@aimspan/protocol";
import { idea, session, workspace } from "../../test/panel-fixtures";
import { BringBack, allowedLink, openSession } from "./bring-back";

function fixture(w: Workspace = workspace()) {
    const order: string[] = [];
    const saves = new Map<string, Idea>();
    let now = 1000;
    const call = vi.fn(async (request: CoreRequest): Promise<unknown> => {
        if (request.method === "workspace") return w;
        if (request.method === "settings.save") { w.settings = request.settings; return request.settings; }
        if (request.method === "idea.save") {
            // Like Core, a replayed operation ID returns the original result instead of saving again.
            const replay = saves.get(request.operationId);
            if (replay) return { ...replay };
            const saved = { ...idea("created", request.body), sessionId: request.sessionId };
            w.ideas.push(saved); order.push("save"); saves.set(request.operationId, { ...saved }); return { ...saved };
        }
        if (request.method !== "idea.setStatus") throw new Error("Unexpected method");
        order.push(`${request.id}:${request.status}`);
        const current = w.ideas.find(i => i.id === request.id)!;
        if (current.revision !== request.expectedRevision) throw new Error("Conflict");
        Object.assign(current, { revision: current.revision + 1, status: request.status });
        return { ...current };
    });
    const writeText = vi.fn((_text: string) => { order.push("clipboard"); });
    const open = vi.fn(async () => { order.push("open"); return messageResult("zh", messageRef("codexOpened")); });
    const openNewSession = vi.fn(async () => { order.push("open-new"); return messageResult("zh", messageRef("newCodexHint")); });
    return { openNewSession, service: new BringBack({ language: () => "zh", call, writeText, open, openNewSession, now: () => now }), order, call, writeText, open, w,
        advance: (milliseconds: number) => { now += milliseconds; } };
}
const request = { sessionId: "a", ideas: [{ id: "idea-a", revision: 1 }], operationId: "bring-a" };

test("T19 sending one idea copies only its verbatim body and leaves other pending ideas untouched", async () => {
    const selected = idea("second", "  只发这一条😀\n保留换行  ");
    const f = fixture(workspace([session()], [idea(), selected, idea("third", "留待下次")]));
    await f.service.bringBack({ ...request, ideas: [{ id: selected.id, revision: selected.revision }] });
    expect(f.writeText).toHaveBeenCalledExactlyOnceWith(selected.body);
    expect(f.w.ideas.map(i => i.status)).toEqual(["pending", "brought", "pending"]);
    expect(f.open).toHaveBeenCalledExactlyOnceWith(f.w.sessions[0]);
});

test("Main copies raw text, changes status, then opens; concurrent replay has no extra effects and undo uses new revision", async () => {
    const f = fixture();
    const [result, replay] = await Promise.all([f.service.bringBack(request), f.service.bringBack(request)]);
    expect(result).toEqual(replay);
    expect(f.writeText).toHaveBeenCalledExactlyOnceWith("  第一条\n继续  ");
    expect(f.order).toEqual(["clipboard", "idea-a:brought", "open"]);
    expect(result).toMatchObject({ brought: 1, undoExpiresAt: 6000 });
    expect(result.messageRef).toBeDefined();
    await f.service.undo(result.undoToken);
    expect(f.w.ideas[0]!.status).toBe("pending");
    expect(f.call.mock.calls.at(-1)![0]).toMatchObject({ method: "idea.setStatus", expectedRevision: 2, status: "pending" });
    await expect(f.service.bringBack({ ...request, ideas: [{ id: "different", revision: 1 }] })).rejects.toThrow("其他内容");
});
test("multiple ideas use formatter in selection order; the 5 second undo expires", async () => {
    const selected: Idea[] = [idea("second", "第二条"), idea()];
    const f = fixture(workspace([session()], selected));
    const text = formatBringBack(selected);
    const result = await f.service.bringBack({ ...request, ideas: selected.map(i => ({ id: i.id, revision: i.revision })) });
    expect(f.writeText).toHaveBeenCalledWith(text);
    f.advance(5001);
    await expect(f.service.undo(result.undoToken)).rejects.toThrow("撤销时间已过");
    expect(f.w.ideas.every(i => i.status === "brought")).toBe(true);
});
test.each([
    { ...request, ideas: [] }, { ...request, ideas: [request.ideas[0], request.ideas[0]] },
    { ...request, ideas: [{ id: "idea-a", revision: 0 }] }, { ...request, sessionId: "other" },
    { ...request, ideas: [{ id: "idea-a", revision: 2 }] },
])("invalid or stale selection never writes the clipboard or opens a target: %j", async selection => {
    const f = fixture();
    await expect(f.service.bringBack(selection)).rejects.toThrow();
    expect(f.writeText).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
});
test("partial status failure reports copied content and allows undo of completed mutations", async () => {
    const f = fixture(workspace([session()], [idea(), idea("second", "第二条")]));
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async r => { if (r.method === "idea.setStatus" && r.id === "second") throw new Error("Conflict"); return original(r); });
    const result = await f.service.bringBack({ ...request, ideas: [{ id: "idea-a", revision: 1 }, { id: "second", revision: 1 }] });
    expect(result.message).toContain("状态更新未完成"); expect(result.brought).toBe(1);
    expect(result.messageRef).toEqual({ key: "ideasPartiallyBrought", params: [2, 1] });
    expect(renderMessage("en", result)).toBe("Copied 2 ideas; 1 marked as brought back. Status update incomplete; check the ideas list.");
    expect(f.open).not.toHaveBeenCalled();
    await f.service.undo(result.undoToken);
    expect(f.w.ideas.every(i => i.status === "pending")).toBe(true);
});
test("clipboard failure never marks ideas; undo does not overwrite a later edit", async () => {
    const f = fixture();
    f.writeText.mockImplementationOnce(() => { throw new Error("Clipboard unavailable"); });
    await expect(f.service.bringBack(request)).rejects.toThrow("Clipboard");
    expect(f.w.ideas[0]!.status).toBe("pending"); expect(f.open).not.toHaveBeenCalled();
    const result = await f.service.bringBack({ ...request, operationId: "retry" });
    f.w.ideas[0]!.revision++;
    await expect(f.service.undo(result.undoToken)).rejects.toThrow("Conflict");
    expect(f.w.ideas[0]!.status).toBe("brought");
});
test("native navigation uses Codex thread URL and Claude application path with a target hint", async () => {
    const shell = { openExternal: vi.fn(async () => {}), openPath: vi.fn(async () => "") };
    await openSession(session(), shell, "zh");
    expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith("codex://threads/a");
    const hint = await openSession(session("c", { agent: "claude-code", title: "检查键盘" }), shell, "zh");
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith("/Applications/Claude.app");
    expect(hint.message).toBe("切到 Claude 会话：检查键盘 · /__aimspan_fixture__/project");
    shell.openPath.mockResolvedValue("App missing");
    expect((await openSession(session("c", { agent: "claude-code" }), shell, "zh")).message).toContain("无法打开 Claude App");
    shell.openExternal.mockRejectedValue(new Error("No handler"));
    expect((await openSession(session(), shell, "zh")).message).toContain("无法打开 Codex 会话");
});
test("external link allowlist rejects file, data, javascript, relative and malformed URLs", () => {
    for (const url of ["https://example.com", "http://example.com", "codex://threads/a", "claude://test"]) expect(allowedLink(url)).toBe(true);
    for (const url of ["file:///tmp/test", "javascript:alert(1)", "data:text/html,x", "/tmp/test", "./relative", "https://", {}, null]) expect(allowedLink(url)).toBe(false);
});

test("Electron 44 asynchronous clipboard must finish successfully before statuses change", async () => {
    const w = workspace();
    let finish: () => void = () => {};
    const call = vi.fn(async (r: CoreRequest) => r.method === "workspace" ? w : { ...w.ideas[0]!, status: "brought", revision: 2 });
    const open = vi.fn(async () => messageResult("zh", messageRef("codexOpened")));
    const service = new BringBack({ language: () => "zh", call, open, writeText: () => new Promise<void>(resolve => { finish = resolve; }) });
    const pending = service.bringBack(request);
    await Promise.resolve();
    expect(call).toHaveBeenCalledTimes(1); expect(open).not.toHaveBeenCalled();
    finish(); await pending;
    expect(call).toHaveBeenCalledTimes(2); expect(open).toHaveBeenCalledOnce();
    const failed = new BringBack({ language: () => "zh", call, open, writeText: async () => { throw new Error("Clipboard failed"); } });
    call.mockClear(); open.mockClear();
    await expect(failed.bringBack(request)).rejects.toThrow("Clipboard failed");
    expect(call).toHaveBeenCalledTimes(1); expect(open).not.toHaveBeenCalled();
});

test.each(["codex", "claude"] as const)("T18 capture %s saves verbatim in inbox, copies once, marks brought, remembers app and supports undo", async app => {
    const f = fixture();
    const request = { kind: "capture", app, body: "  新想法😀\n原文  ", expectedRevision: 0, operationId: "new" };
    const [result, replay] = await Promise.all([f.service.newSession(request), f.service.newSession(request)]);
    expect(result).toEqual(replay);
    expect(f.order).toEqual(["save", "clipboard", "created:brought", "open-new"]);
    expect(f.writeText).toHaveBeenCalledExactlyOnceWith(request.body);
    expect(f.openNewSession).toHaveBeenCalledExactlyOnceWith(app);
    expect(f.open).not.toHaveBeenCalled();
    expect(f.w.ideas.at(-1)).toMatchObject({ body: request.body, sessionId: null, status: "brought", revision: 2 });
    expect(f.w.settings.lastNewSessionApp).toBe(app);
    expect(result).toMatchObject({ brought: 1, undoExpiresAt: 6000 });
    expect(result.messageRef).toBeDefined();
    await f.service.undo(result.undoToken);
    expect(f.w.ideas.at(-1)).toMatchObject({ status: "pending", revision: 3 });
    await expect(f.service.newSession({ ...request, app: app === "codex" ? "claude" : "codex" })).rejects.toThrow("其他内容");
});
test("T18 existing inbox idea uses its stored text and revision; replay after undo never reopens", async () => {
    const f = fixture(workspace([], [idea("inbox", "收件箱原文", { sessionId: null })]));
    const request = { kind: "inbox", app: "claude", idea: { id: "inbox", revision: 1 }, operationId: "inbox-new" };
    const result = await f.service.newSession(request);
    expect(f.writeText).toHaveBeenCalledExactlyOnceWith("收件箱原文");
    expect(f.w.ideas).toHaveLength(1);
    expect(f.w.ideas[0]!.status).toBe("brought");
    await f.service.undo(result.undoToken);
    await f.service.newSession(request);
    expect(f.w.ideas[0]!.status).toBe("pending");
    expect(f.openNewSession).toHaveBeenCalledOnce();
});
test.each([
    { app: "other" }, { idea: { id: "inbox", revision: 0 } }, { idea: { id: "inbox", revision: 2 } },
    { idea: { id: "idea-a", revision: 1 } }, { idea: { id: "missing", revision: 1 } }, { idea: { id: "brought", revision: 1 } },
])("T18 invalid/stale/non-inbox idea selection cannot copy or open: %j", async patch => {
    const f = fixture(workspace([session()], [idea(), idea("inbox", "inbox", { sessionId: null }), idea("brought", "used", { sessionId: null, status: "brought" })]));
    await expect(f.service.newSession({ kind: "inbox", app: "codex", idea: { id: "inbox", revision: 1 }, operationId: "invalid", ...patch })).rejects.toThrow();
    expect(f.writeText).not.toHaveBeenCalled(); expect(f.openNewSession).not.toHaveBeenCalled();
});
test("T18 failed asynchronous copy keeps the capture idea pending and never opens; undo expires or rejects later edits", async () => {
    const f = fixture();
    f.writeText.mockImplementationOnce(() => { throw new Error("Clipboard unavailable"); });
    await expect(f.service.newSession({ kind: "capture", app: "codex", body: "保留", expectedRevision: 0, operationId: "failed" })).rejects.toThrow("Clipboard");
    expect(f.w.ideas.at(-1)).toMatchObject({ sessionId: null, status: "pending" });
    expect(f.openNewSession).not.toHaveBeenCalled();
    const result = await f.service.newSession({ kind: "inbox", app: "claude", idea: { id: "created", revision: 1 }, operationId: "retry" });
    f.w.ideas.at(-1)!.revision++;
    await expect(f.service.undo(result.undoToken)).rejects.toThrow("Conflict");
    f.advance(5001);
    await expect(f.service.undo(result.undoToken)).rejects.toThrow("撤销时间已过");
});
test("T18 review: a transient clipboard failure can be retried with the same operation without a second inbox idea", async () => {
    const f = fixture();
    const request = { kind: "capture", app: "codex", body: "重试这一条", expectedRevision: 0, operationId: "retry" };
    f.writeText.mockRejectedValueOnce(new Error("Clipboard busy"));
    await expect(f.service.newSession(request)).rejects.toThrow("Clipboard busy");
    expect(f.w.ideas.filter(i => i.body === "重试这一条")).toHaveLength(1);
    expect(f.w.ideas.at(-1)!.status).toBe("pending");
    await f.service.newSession(request);
    expect(f.w.ideas.filter(i => i.body === "重试这一条")).toHaveLength(1);
    expect(f.w.ideas.at(-1)!.status).toBe("brought");
    expect(f.openNewSession).toHaveBeenCalledOnce();
});
test("T18 review: failing to open the app keeps the copied, brought idea and reports a manual-open hint", async () => {
    const f = fixture();
    f.openNewSession.mockRejectedValueOnce(new Error("open failed"));
    const result = await f.service.newSession({ kind: "capture", app: "claude", body: "打不开也已复制", expectedRevision: 0, operationId: "open-fail" });
    expect(result.message).toMatch(/无法打开 Claude.*手动打开后粘贴/);
    expect(result.messageRef).toEqual({ key: "copiedOpenFailed", params: [{ key: "claude" }] });
    expect(renderMessage("en", result)).toBe("Copied, but could not open Claude. Open it manually and paste");
    expect(f.w.ideas.at(-1)!.status).toBe("brought");
});

test("T23 R1 open failures return nested target refs and preserve fallback copy", async () => {
    const shell = { openExternal: vi.fn(async () => { throw new Error("missing handler"); }), openPath: vi.fn(async () => "App missing") };
    const claude = await openSession(session("c", { agent: "claude-code", title: "中文 title" }), shell, "zh");
    expect(claude.messageRef).toEqual({ key: "claudeOpenFailed", params: [{ key: "claudeSessionHint", params: ["中文 title", "/__aimspan_fixture__/project"] }] });
    expect(renderMessage("en", claude)).toBe("Could not open Claude. Open it manually. Switch to Claude session: 中文 title · /__aimspan_fixture__/project");
    const codex = await openSession(session(), shell, "zh");
    expect(codex.messageRef).toEqual({ key: "codexOpenFailed" });
    expect(renderMessage("en", codex)).toBe("Could not open the Codex session. Return to Codex manually");
});

test("T23 R1 a zero-mutation partial bring-back still carries a translatable reference", async () => {
    const f = fixture();
    const call = f.call.getMockImplementation()!;
    f.call.mockImplementation(async request => {
        if (request.method === "idea.setStatus") throw new Error("Conflict");
        return call(request);
    });
    const result = await f.service.bringBack(request);
    expect(result).toMatchObject({ brought: 0, messageRef: { key: "ideasPartiallyBrought", params: [1, 0] } });
    expect(result.undoToken).toBeUndefined();
    expect(renderMessage("en", result)).toContain("0 marked as brought back");
});
