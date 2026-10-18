import { contextBridge, ipcRenderer } from "electron";
import type { BubbleApi, BubbleState } from "@aimspan/protocol";
const api: BubbleApi = {
    getState: () => ipcRenderer.invoke("bubble:state"),
    subscribe: callback => {
        const listener = (_event: unknown, state: BubbleState) => callback(state);
        ipcRenderer.on("bubble:state", listener);
        return () => ipcRenderer.removeListener("bubble:state", listener);
    },
    hover: inside => ipcRenderer.invoke("bubble:hover", inside),
    pointer: (phase, point) => ipcRenderer.invoke("bubble:pointer", phase, point),
    toggle: () => ipcRenderer.invoke("bubble:toggle"),
    menu: () => ipcRenderer.invoke("bubble:menu"),
};
contextBridge.exposeInMainWorld("aimspanBubble", Object.freeze(api));
