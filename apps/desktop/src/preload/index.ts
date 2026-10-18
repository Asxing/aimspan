import { contextBridge, ipcRenderer } from "electron";
import type { PanelApi, PanelTarget, Workspace } from "@aimspan/protocol";
let pendingTarget: PanelTarget | undefined;
let onOpen: ((target: PanelTarget) => void) | undefined;
ipcRenderer.on("panel:open", (_event, target: PanelTarget) => {
    if (onOpen) onOpen(target); else pendingTarget = target;
});
const api: PanelApi = {
    onOpen: callback => {
        onOpen = callback;
        if (pendingTarget) { callback(pendingTarget); pendingTarget = undefined; }
        return () => { if (onOpen === callback) onOpen = undefined; };
    },
    hide: () => ipcRenderer.invoke("panel:hide"),
    call: request => ipcRenderer.invoke("companion:call", request),
    onFlushDrafts: callback => {
        const listener = (_event: unknown, id: unknown) => {
            if (typeof id !== "string") return;
            callback();
            ipcRenderer.send("companion:drafts-flushed", id);
        };
        ipcRenderer.on("companion:flush-drafts", listener);
        return () => ipcRenderer.removeListener("companion:flush-drafts", listener);
    },
    subscribe: callback => {
        const listener = (_event: unknown, workspace: Workspace) => callback(workspace);
        ipcRenderer.on("companion:workspace", listener);
        return () => ipcRenderer.removeListener("companion:workspace", listener);
    },
    reveal: id => ipcRenderer.invoke("companion:reveal", id),
    exportLegacy: operationId => ipcRenderer.invoke("companion:export", operationId),
    chooseRoot: () => ipcRenderer.invoke("companion:root"),
    openLink: url => ipcRenderer.invoke("panel:open-link", url),
    bringBack: request => ipcRenderer.invoke("panel:bring-back", request),
    newSession: request => ipcRenderer.invoke("panel:new-session", request),
    undoBringBack: token => ipcRenderer.invoke("panel:undo-bring-back", token),
};
contextBridge.exposeInMainWorld("aimspan", Object.freeze(api));
