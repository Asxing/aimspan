// @vitest-environment node
import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { CAPTURE_DRAFT_KEY, type CaptureApi, type CaptureContext } from "@aimspan/protocol";
vi.mock("electron", async () => {
    const { EventEmitter } = await import("node:events");
    return { contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: Object.assign(new EventEmitter(), { invoke: vi.fn(async () => null), send: vi.fn() }) };
});
import { contextBridge, ipcRenderer } from "electron";
import "./capture";
const api = vi.mocked(contextBridge.exposeInMainWorld).mock.calls[0]![1] as CaptureApi;
test("capture exposes narrow operations and flushes the latest shared draft before acknowledging quit", async () => {
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.keys(api).sort()).toEqual(["close", "getContext", "newSession", "onLanguage", "saveDraft", "saveIdea"]);
    const context: CaptureContext = { language: "zh", openId: 1, sessions: [], inboxIdeaCount: 0, drafts: { [CAPTURE_DRAFT_KEY]: { target: CAPTURE_DRAFT_KEY, body: "draft", revision: 3, updatedAt: "2026-10-16" } } };
    const order: string[] = [];
    let acknowledge: (value: unknown) => void = () => {};
    vi.mocked(ipcRenderer.invoke).mockImplementation(async (channel, request) => {
        if (channel === "capture:context") return structuredClone(context);
        if (channel !== "capture:draft") return null;
        order.push(`draft:${request.body}`);
        if (request.body === "失败草稿") throw new Error("暂不可写");
        if (request.body === "第一版") return new Promise(resolve => { acknowledge = resolve; });
        return { ...request, revision: request.expectedRevision + 1 };
    });
    vi.mocked(ipcRenderer.send).mockImplementation(() => { order.push("ack"); });
    await api.getContext();
    await expect(api.saveDraft({ body: "失败草稿", operationId: "failed" })).rejects.toThrow("暂不可写");
    expect((await api.getContext()).drafts[CAPTURE_DRAFT_KEY]!.body).toBe("失败草稿");
    await expect(api.saveDraft({ body: "😀".repeat(4001), operationId: "too-long" })).rejects.toThrow("desktop.errorInvalidCaptureDraft");
    order.length = 0;
    const first = api.saveDraft({ body: "第一版", operationId: "first" });
    const final = api.saveDraft({ body: "最后几个字😀", operationId: "last" });
    (ipcRenderer as unknown as EventEmitter).emit("companion:flush-drafts", {}, "quit-token");
    expect(order).toEqual(["draft:第一版", "draft:最后几个字😀", "ack"]);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("capture:draft", { method: "draft.save", target: "capture", body: "第一版", expectedRevision: 3, operationId: "first" });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("capture:draft", { method: "draft.save", target: "capture", body: "最后几个字😀", expectedRevision: 4, operationId: "last" });
    expect(ipcRenderer.send).toHaveBeenCalledWith("companion:drafts-flushed", "quit-token");
    acknowledge({ revision: 4 }); await Promise.all([first, final]);
    const request = { sessionId: null, body: "idea", expectedRevision: 0, operationId: "idea" };
    const newRequest = { kind: "capture", app: "claude", body: "new", expectedRevision: 0, operationId: "new" } as const;
    await api.newSession(newRequest, 1);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("capture:new-session", newRequest, 1);
    await api.saveIdea(request, 1); await api.close(1);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("capture:idea", request, 1);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("capture:close", 1);
});
