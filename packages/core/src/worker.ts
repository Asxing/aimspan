import { join } from "node:path";
import { Store } from "./store.js";
import { Discovery } from "./adapters.js";
import { validRequest, object } from "@aimspan/protocol";
interface Port {
    on(event: "message", callback: (event: {
        data: unknown;
    }) => void): void;
    postMessage(value: unknown): void;
}
const port = (process as typeof process & {
    parentPort: Port;
}).parentPort;
let store: Store, discovery: Discovery;
let tail = Promise.resolve();
let stopped = false;
const publish = () => port.postMessage({ type: "workspace", workspace: store.workspace() });
port.on("message", event => {
    tail = tail.then(async () => {
        const m = event.data;
        if (!object(m))
            return;
        try {
            if (stopped) throw new Error("core.errorCoreIsStopping");
            if (m.type === "init" && typeof m.directory === "string" && typeof m.codex === "string" && typeof m.claude === "string") {
                store = new Store(m.directory);
                await store.importLegacy(join(m.directory, "aimspan.sqlite3"));
                discovery = new Discovery(store, { codex: m.codex, claude: m.claude });
                await discovery.scan();
                publish();
                discovery.start(() => { if (!stopped) publish(); });
                port.postMessage({ type: "ready" });
                return;
            }
            if (m.type === "stop") {
                stopped = true;
                await discovery.stop();
                store.close();
                port.postMessage({ type: "stopped" });
                return;
            }
            if (m.type !== "call" || typeof m.id !== "string" || !validRequest(m.request))
                throw new Error("core.errorInvalidCoreMessage");
            const r = m.request;
            let result: unknown;
            if (r.method === "scan") {
                await discovery.scan();
                result = null;
            }
            else
                result = store.call(r);
            port.postMessage({ type: "response", id: m.id, result });
            publish();
        }
        catch (error) {
            port.postMessage({ type: "response", id: m.id, error: error instanceof Error ? error.message : "core.errorCoreFailed" });
        }
    }).catch(() => { });
});
