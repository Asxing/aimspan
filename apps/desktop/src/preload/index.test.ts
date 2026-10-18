// @vitest-environment node
import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import type { DesktopApi } from "@aimspan/protocol";

vi.mock("electron", async () => {
    const { EventEmitter } = await import("node:events");
    return { contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: Object.assign(new EventEmitter(), { invoke: vi.fn(async () => null), send: vi.fn() }) };
});
import { contextBridge, ipcRenderer } from "electron";
import "./index";
const api = vi.mocked(contextBridge.exposeInMainWorld).mock.calls[0]![1] as DesktopApi;
test("panel target delivered before React subscribes is retained and replayed without focus", () => {
    const target = { kind: "session", sessionId: "a" };
    (ipcRenderer as unknown as EventEmitter).emit("panel:open", {}, target);
    const opened = vi.fn(), off = api.onOpen(opened);
    expect(opened).toHaveBeenCalledExactlyOnceWith(target);
    off();
    (ipcRenderer as unknown as EventEmitter).emit("panel:open", {}, { kind: "settings" });
    expect(opened).toHaveBeenCalledOnce();
});

test("R1 preload acknowledges flush only after the renderer queues its draft calls", () => {
    const order: string[] = [];
    vi.mocked(ipcRenderer.invoke).mockImplementation(async () => { order.push("draft"); });
    vi.mocked(ipcRenderer.send).mockImplementation(() => { order.push("ack"); });
    const off = api.onFlushDrafts(() => {
        void api.call({ method: "draft.save", target: "inbox", body: "最后几个字😀", expectedRevision: 1, operationId: "flush" });
    });
    (ipcRenderer as unknown as EventEmitter).emit("companion:flush-drafts", {}, "request-token");
    expect(order).toEqual(["draft", "ack"]);
    expect(ipcRenderer.send).toHaveBeenCalledWith("companion:drafts-flushed", "request-token");
    off();
    (ipcRenderer as unknown as EventEmitter).emit("companion:flush-drafts", {}, "second-token");
    expect(order).toEqual(["draft", "ack"]);
});

test("panel exposes fixed channels without file, clipboard or arbitrary IPC authority", async () => {
    expect(Object.isFrozen(api)).toBe(true);
    const request = { sessionId: "a", ideas: [{ id: "idea", revision: 1 }], operationId: "bring" };
    await api.hide(); await api.bringBack(request); await api.undoBringBack("undo"); await api.openLink("https://example.com");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("panel:hide");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("panel:bring-back", request);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("panel:undo-bring-back", "undo");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("panel:open-link", "https://example.com");
    const newRequest = { kind: "inbox", app: "codex", idea: { id: "idea", revision: 1 }, operationId: "new" } as const;
    await api.newSession(newRequest);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("panel:new-session", newRequest);
    expect(Object.keys(api).sort()).toEqual(["bringBack", "call", "chooseRoot", "exportLegacy", "hide", "newSession", "onFlushDrafts", "onOpen", "openLink", "reveal", "subscribe", "undoBringBack"]);
});
