import { contextBridge, ipcRenderer } from "electron";
import { CAPTURE_DRAFT_KEY, validRequest, type CaptureApi, type CaptureContext, type Draft } from "@aimspan/protocol";
import { DraftWriter } from "../renderer/draft-writer";

let latestBody: string | undefined;
let initialized = false;
let draftError: unknown;
const writer = new DraftWriter(async request => {
    const result = await ipcRenderer.invoke("capture:draft", { ...request, target: "capture" }) as Draft;
    draftError = undefined;
    return result;
}, error => { draftError = error; });

// Main announces each open; the page reloads its context without relying on a
// DOM focus event, which macOS does not deliver while another app is active.
ipcRenderer.on("capture:opened", (_event, id: unknown) => {
    if (typeof id === "number") window.dispatchEvent(new CustomEvent("aimspan-capture-opened", { detail: id }));
});

// The queue lives in preload so the public API needs no shutdown authority.
ipcRenderer.on("companion:flush-drafts", (_event, id: unknown) => {
    if (typeof id !== "string") return;
    writer.flush();
    ipcRenderer.send("companion:drafts-flushed", id);
});
const api: CaptureApi = {
    onLanguage: callback => {
        const listener = (_event: unknown, language: unknown) => { if (language === "en" || language === "zh") callback(language); };
        ipcRenderer.on("capture:language", listener);
        return () => ipcRenderer.removeListener("capture:language", listener);
    },
    getContext: async () => {
        await writer.drain();
        const context = await ipcRenderer.invoke("capture:context") as CaptureContext;
        if (!initialized) { writer.initialize(context.drafts); initialized = true; }
        // A failed write must not replace the user's text with an older disk snapshot on reopen.
        if (latestBody !== undefined) context.drafts[CAPTURE_DRAFT_KEY] = { target: CAPTURE_DRAFT_KEY, body: latestBody,
            revision: context.drafts[CAPTURE_DRAFT_KEY]?.revision ?? 0, updatedAt: context.drafts[CAPTURE_DRAFT_KEY]?.updatedAt ?? "" };
        return context;
    },
    saveIdea: (request, openId) => ipcRenderer.invoke("capture:idea", request, openId),
    newSession: (request, openId) => ipcRenderer.invoke("capture:new-session", request, openId),
    saveDraft: async request => {
        if (!initialized) throw new Error("desktop.errorCaptureIsNotReady");
        if (!validRequest({ ...request, method: "draft.save", target: "capture", expectedRevision: 0 }))
            throw new Error("desktop.errorInvalidCaptureDraft");
        latestBody = request.body;
        writer.save(CAPTURE_DRAFT_KEY, request.body, request.operationId);
        await writer.drain();
        if (draftError) throw draftError;
    },
    close: openId => ipcRenderer.invoke("capture:close", openId),
};
contextBridge.exposeInMainWorld("aimspanCapture", Object.freeze(api));
