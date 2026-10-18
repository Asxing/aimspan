// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import type { App, IpcMain, WebFrameMain } from "electron";
import { installShutdown } from "./shutdown";

afterEach(() => vi.useRealTimers());
function fixture() {
    const app = Object.assign(new EventEmitter(), { quit: vi.fn(), exit: vi.fn() });
    const ipc = new EventEmitter();
    const window = { mainFrame: {} as WebFrameMain, isDestroyed: () => false, send: vi.fn() };
    const core = { stop: vi.fn(async () => {}) }, onQuit = vi.fn();
    const shutdown = installShutdown({ app: app as unknown as App, ipc: ipc as IpcMain, getWindows: () => [window], getCore: () => core, onQuit });
    const quit = () => { const event = { preventDefault: vi.fn() }; app.emit("before-quit", event); return event; };
    const ack = () => ipc.emit("companion:drafts-flushed", { sender: window, senderFrame: window.mainFrame }, window.send.mock.calls[0]![1]);
    return { app, ipc, window, core, shutdown, quit, ack, onQuit };
}

test("R1 quit waits for the trusted renderer flush acknowledgment before stopping Core", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finishStop: () => void = () => {};
    f.core.stop.mockImplementation(() => new Promise<void>(resolve => { finishStop = resolve; }));
    expect(f.quit().preventDefault).toHaveBeenCalledOnce();
    expect(f.window.send).toHaveBeenCalledWith("companion:flush-drafts", expect.any(String));
    expect(f.core.stop).not.toHaveBeenCalled();
    expect(f.shutdown.complete()).toBe(false);
    expect(f.quit().preventDefault).toHaveBeenCalledOnce();
    expect(f.window.send).toHaveBeenCalledOnce();
    expect(f.onQuit).toHaveBeenCalledOnce();
    const token = f.window.send.mock.calls[0]![1];
    f.ipc.emit("companion:drafts-flushed", { sender: {}, senderFrame: f.window.mainFrame }, token);
    f.ipc.emit("companion:drafts-flushed", { sender: f.window, senderFrame: {} }, token);
    f.ipc.emit("companion:drafts-flushed", { sender: f.window, senderFrame: f.window.mainFrame }, "wrong-token");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.core.stop).not.toHaveBeenCalled();
    f.ack();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.core.stop).toHaveBeenCalledOnce();
    expect(f.app.quit).not.toHaveBeenCalled();
    expect(f.shutdown.complete()).toBe(false);
    finishStop();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.app.quit).toHaveBeenCalledOnce();
    expect(f.shutdown.complete()).toBe(true);
    expect(f.quit().preventDefault).not.toHaveBeenCalled();
    expect(f.ipc.listenerCount("companion:drafts-flushed")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
});

test("R1 unresponsive renderer flush times out at one second and cleans up its listener", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.quit();
    await vi.advanceTimersByTimeAsync(999);
    expect(f.core.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.core.stop).toHaveBeenCalledOnce();
    expect(f.app.quit).toHaveBeenCalledOnce();
    expect(f.ipc.listenerCount("companion:drafts-flushed")).toBe(0);
    f.ack();
    expect(f.core.stop).toHaveBeenCalledOnce();
});

test("R1 destroyed renderer cannot hold shutdown open", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.window.isDestroyed = () => true;
    f.quit();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.window.send).not.toHaveBeenCalled();
    expect(f.core.stop).toHaveBeenCalledOnce();
    expect(f.app.quit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
});

test("quit waits for panel and capture flushes, including a hidden capture window", async () => {
    vi.useFakeTimers();
    const app = Object.assign(new EventEmitter(), { quit: vi.fn(), exit: vi.fn() });
    const ipc = new EventEmitter();
    const windows = [0, 1].map(() => ({ mainFrame: {} as WebFrameMain, isDestroyed: () => false, send: vi.fn() }));
    const core = { stop: vi.fn(async () => {}) };
    installShutdown({ app: app as unknown as App, ipc: ipc as IpcMain, getWindows: () => windows, getCore: () => core, onQuit: vi.fn() });
    app.emit("before-quit", { preventDefault() {} });
    const ack = (index: number) => { const window = windows[index]!; ipc.emit("companion:drafts-flushed", { sender: window, senderFrame: window.mainFrame }, window.send.mock.calls[0]![1]); };
    ack(0); await vi.advanceTimersByTimeAsync(0);
    expect(core.stop).not.toHaveBeenCalled();
    ack(1); await vi.advanceTimersByTimeAsync(0);
    expect(core.stop).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
    expect(ipc.listenerCount("companion:drafts-flushed")).toBe(0);
});
