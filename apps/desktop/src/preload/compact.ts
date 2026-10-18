import { contextBridge, ipcRenderer } from "electron";
import type { CompactApi, CompactState } from "@aimspan/protocol";
const api: CompactApi = {
    getState: () => ipcRenderer.invoke("compact:state"),
    subscribe: callback => {
        const listener = (_event: unknown, state: CompactState) => callback(state);
        ipcRenderer.on("compact:state", listener);
        return () => ipcRenderer.removeListener("compact:state", listener);
    },
    hover: inside => ipcRenderer.invoke("compact:hover", inside),
    openSession: id => ipcRenderer.invoke("compact:session", id),
    capture: id => ipcRenderer.invoke("compact:capture", id),
    newSession: () => ipcRenderer.invoke("compact:new-session"),
    pinSession: request => ipcRenderer.invoke("compact:pin-session", request),
    handleSession: request => ipcRenderer.invoke("compact:handled", request),
    togglePinned: () => ipcRenderer.invoke("compact:pin"),
    close: () => ipcRenderer.invoke("compact:close"),
};
contextBridge.exposeInMainWorld("aimspanCompact", Object.freeze(api));
