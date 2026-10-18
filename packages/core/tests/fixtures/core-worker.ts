// Synthetic Node transport for the production utilityProcess worker; no Electron launch.
import { parentPort } from "node:worker_threads";
if (!parentPort) throw new Error("Worker port missing");
const port = parentPort;
Object.assign(process, { parentPort: {
    on(_event: "message", callback: (event: { data: unknown }) => void) { port.on("message", data => callback({ data })); },
    postMessage(message: unknown) { port.postMessage(message); },
} });
await import("../../src/worker.js");
