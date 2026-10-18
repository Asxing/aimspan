// @vitest-environment node
import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import type { BubbleApi, CompactApi } from "@aimspan/protocol";
vi.mock("electron", async () => {
    const { EventEmitter } = await import("node:events");
    return { contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: Object.assign(new EventEmitter(), { invoke: vi.fn(async () => null) }) };
});
import { contextBridge, ipcRenderer } from "electron";
import "./bubble";
import "./compact";
const exposed = vi.mocked(contextBridge.exposeInMainWorld).mock.calls;
const bubble = exposed.find(([name]) => name === "aimspanBubble")![1] as BubbleApi;
const compact = exposed.find(([name]) => name === "aimspanCompact")![1] as CompactApi;
test("bubble and compact preloads have distinct fixed authority, with no Core calls or arbitrary IPC", async () => {
    expect(Object.isFrozen(bubble)).toBe(true); expect(Object.isFrozen(compact)).toBe(true);
    expect(Object.keys(bubble).sort()).toEqual(["getState", "hover", "menu", "pointer", "subscribe", "toggle"]);
    expect(Object.keys(compact).sort()).toEqual(["capture", "close", "getState", "handleSession", "hover", "newSession", "openSession", "pinSession", "subscribe", "togglePinned"]);
    await bubble.pointer("move", { x: -300, y: 120 }); await bubble.hover(true); await bubble.menu(); await bubble.toggle();
    await compact.openSession("a"); await compact.capture("b"); await compact.capture(null); await compact.close(); await compact.newSession();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("compact:new-session");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("bubble:pointer", "move", { x: -300, y: 120 });
    await bubble.pointer("move", { x: -300, y: 120, buttons: 1 });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("bubble:pointer", "move", { x: -300, y: 120, buttons: 1 });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("compact:session", "a");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("compact:capture", null);
    const mutation = { sessionId: "a", expectedRevision: 3, operationId: "fixture-op" };
    await compact.pinSession({ ...mutation, pinned: true }); await compact.handleSession(mutation); await compact.togglePinned();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("compact:pin-session", { ...mutation, pinned: true });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("compact:handled", mutation);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("compact:pin");
});
test("state is pushed without DOM focus and unsubscribing removes each listener", () => {
    const a = vi.fn(), b = vi.fn(), offA = bubble.subscribe(a), offB = compact.subscribe(b);
    const emitter = ipcRenderer as unknown as EventEmitter;
    emitter.emit("bubble:state", {}, { waiting: 2 }); emitter.emit("compact:state", {}, { sessions: [] });
    expect(a).toHaveBeenCalledExactlyOnceWith({ waiting: 2 }); expect(b).toHaveBeenCalledExactlyOnceWith({ sessions: [] });
    offA(); offB(); emitter.emit("bubble:state", {}, {}); emitter.emit("compact:state", {}, {});
    expect(a).toHaveBeenCalledOnce(); expect(b).toHaveBeenCalledOnce();
});
