// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));
import { utilityProcess, type UtilityProcess } from "electron";
import { CoreClient } from "./core-client";

afterEach(() => vi.useRealTimers());

test("R1 CoreClient queues accepted drafts ahead of stop and waits for the worker to close", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() });
    vi.mocked(utilityProcess.fork).mockReturnValue(child as unknown as UtilityProcess);
    const client = new CoreClient("/__aimspan_fixture__/worker.js", { directory: "/__aimspan_fixture__/state", codex: "/__aimspan_fixture__/codex", claude: "/__aimspan_fixture__/claude" });
    const first = client.call({ method: "draft.save", target: "inbox", body: "第一版", expectedRevision: 0, operationId: "first" });
    const final = client.call({ method: "draft.save", target: "inbox", body: "最终版", expectedRevision: 1, operationId: "final" });
    const stopping = client.stop();
    expect(client.stop()).toBe(stopping);
    expect(child.postMessage.mock.calls.map(([message]) => message.type)).toEqual(["init"]);
    child.emit("message", { type: "ready" });
    await vi.advanceTimersByTimeAsync(0);
    const messages = child.postMessage.mock.calls.map(([message]) => message);
    expect(messages.map(message => message.type)).toEqual(["init", "call", "call", "stop"]);
    expect(messages[1].request.body).toBe("第一版");
    expect(messages[2].request.body).toBe("最终版");
    expect(child.kill).not.toHaveBeenCalled();
    await expect(client.call({ method: "draft.save", target: "inbox", body: "too late", expectedRevision: 2, operationId: "late" })).rejects.toThrow("Core is stopping");
    child.emit("message", { type: "response", id: messages[1].id, result: { revision: 1 } });
    child.emit("message", { type: "response", id: messages[2].id, result: { revision: 2 } });
    child.emit("message", { type: "stopped" });
    await Promise.all([first, final, stopping]);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
});
