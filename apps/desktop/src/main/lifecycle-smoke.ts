import { clipboard, screen, type BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { NEW_SESSION_TARGETS } from "@aimspan/protocol";
import type { CoreClient } from "./core-client";
import type { CaptureWindow } from "./capture";
import type { BubbleWindow } from "./bubble";

/** Opt-in fixture harness. Native app launches are recorded by Main, never delivered. */
/** Pointer seen by Main during the harness; hover simulation moves it onto the bubble so both hover sources agree. */
export const testCursor = { x: -100000, y: -100000 };

export async function runLifecycleSmoke(window: BrowserWindow, core: CoreClient, nativeRequests: string[], capture: CaptureWindow, bubble: BubbleWindow) {
    const js = (script: string) => window.webContents.executeJavaScript(script).catch((error: unknown) => { throw new Error(`js failed: ${script.slice(0, 160)}: ${String(error)}`); });
    const until = async (check: () => Promise<unknown> | unknown, label = "") => {
        for (let n = 0; n < 100; n++) {
            if (await check()) return;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error(`Panel smoke condition timed out${label ? `: ${label}` : ""}`);
    };
    await until(() => js("!!document.querySelector('[data-row-id] .session-toggle')"), "line 16");
    const bubbleJs = (script: string) => bubble.window.webContents.executeJavaScript(script).catch((error: unknown) => { throw new Error(`bubbleJs failed: ${script.slice(0, 160)}: ${String(error)}`); });
    const compactJs = (script: string) => bubble.list.webContents.executeJavaScript(script).catch((error: unknown) => { throw new Error(`compactJs failed: ${script.slice(0, 160)}: ${String(error)}`); });
    await until(() => bubble.window.isVisible() && bubbleJs("!!document.querySelector('[data-bubble]')"), "bubble exists");
    // Let the initial native cursor sample settle before synthetic renderer hover.
    await new Promise(resolve => setTimeout(resolve, 120));
    await bubbleJs("window.aimspanBubble.hover(false)");
    await until(() => bubbleJs("Math.round(document.querySelector('[data-bubble]').getBoundingClientRect().left) === 84"), "half-hidden circle");
    const frame = bubble.window.getBounds(), display = screen.getDisplayMatching(frame).workArea;
    assert.equal(frame.height, 56);
    assert.equal(await bubbleJs("document.querySelector('[data-bubble]').getBoundingClientRect().width"), 56);
    const bubbleResult = { exists: true, focusable: bubble.window.isFocusable(),
        frameInsideDisplay: frame.x >= display.x && frame.x + frame.width <= display.x + display.width && frame.y >= display.y && frame.y + frame.height <= display.y + display.height,
        visibleWidth: await bubbleJs("(() => { const r = document.querySelector('[data-bubble]').getBoundingClientRect(); return Math.round(Math.min(innerWidth, r.right) - Math.max(0, r.left)); })()"),
        compactOpened: false, expandedSession: "", preselectedSession: "", inboxPreselected: false };
    const hover = async () => {
        // A real pointer leaves the bubble before re-entering; let Main's poll see the leave first.
        testCursor.x = -100000; testCursor.y = -100000;
        await new Promise(resolve => setTimeout(resolve, 700));
        const frame = bubble.window.getBounds();
        const rect = await bubbleJs("(() => { const r = document.querySelector('[data-bubble]').getBoundingClientRect(); return { x: (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2, y: r.top + r.height / 2 }; })()");
        testCursor.x = Math.round(frame.x + rect.x); testCursor.y = Math.round(frame.y + rect.y);
        await bubbleJs("document.querySelector('[data-bubble]').dispatchEvent(new MouseEvent('mouseout', {bubbles: true, relatedTarget: document.body}))");
        await bubbleJs("document.querySelector('[data-bubble]').dispatchEvent(new MouseEvent('mouseover', {bubbles: true, relatedTarget: document.body}))");
        await until(() => bubble.list.isVisible(), "compact opens on hover without focus");
    };
    await hover(); bubbleResult.compactOpened = true;
    const compactSession = core.snapshot()!.sessions.find(s => s.nativeId === "native-capture")!;
    await until(() => compactJs(`!!document.querySelector('[data-compact-id="${compactSession.id}"] .compact-open')`), "compact fixture row");
    await compactJs(`document.querySelector('[data-compact-id="${compactSession.id}"] .compact-open').click()`);
    await until(() => window.isVisible() && js(`!!document.querySelector('[data-row-id="${compactSession.id}"] .session-toggle[aria-expanded=true]')`), "compact row expands panel card");
    bubbleResult.expandedSession = compactSession.nativeId;
    await hover();
    await compactJs(`document.querySelector('[data-compact-id="${compactSession.id}"] .compact-add').click()`);
    const captureJs = (script: string) => capture.window.webContents.executeJavaScript(script).catch((error: unknown) => { throw new Error(`captureJs failed: ${script.slice(0, 160)}: ${String(error)}`); });
    await until(() => captureJs("document.querySelector('[aria-label=\"Choose target\"]')?.textContent.includes('\u5feb\u6377\u8bb0\u5f55\u76ee\u6807')"), "compact plus target");
    const targetContext = await captureJs("window.aimspanCapture.getContext()");
    if (targetContext.preselectedTarget !== compactSession.id) throw new Error("Compact plus did not preselect its target");
    bubbleResult.preselectedSession = compactSession.nativeId;
    await captureJs(`window.aimspanCapture.close(${targetContext.openId})`);
    await hover(); await compactJs("document.querySelector('footer button').click()");
    await until(() => captureJs("document.querySelector('[aria-label=\"Choose target\"]')?.textContent.includes('Inbox')"), "compact inbox target");
    const inboxContext = await captureJs("window.aimspanCapture.getContext()");
    if (inboxContext.preselectedTarget !== null) throw new Error("Compact footer did not preselect the inbox");
    bubbleResult.inboxPreselected = true;
    await captureJs(`window.aimspanCapture.close(${inboxContext.openId})`);
    window.show(); window.focus();
    // The bubble steps leave a tall expanded card; collapse it so the virtual list renders the other rows again.
    await js("document.querySelector('.session-toggle[aria-expanded=true]')?.click()");
    const session = core.snapshot()!.sessions.find(s => s.nativeId === "native-a")!;
    await until(() => js(`!!document.querySelector('[data-row-id="${session.id}"] .session-toggle')`), "native-a row rendered");
    if (!session) throw new Error("No active fixture session");
    const viewedBefore = session.lastViewedAt;
    await js(`document.querySelector('[data-row-id="${session.id}"] .session-toggle').click()`);
    await until(() => Date.parse(core.snapshot()!.sessions.find(s => s.id === session.id)!.lastViewedAt ?? "") > Date.parse(viewedBefore ?? "0001-01-01"), "line 21");
    await until(() => js("!!document.querySelector('[data-section=reply]')"), "line 22");
    const ideaActions = { edited: false, deletedAndUndone: false, sentAndUndone: false, clipboard: "" };
    if (process.env.AIMSPAN_TEST_IDEAS) {
        await js(`(() => { const input = document.querySelector('textarea[aria-label="Add idea"]');
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '\u7b49\u8fd9\u4e00\u8f6e\u7ed3\u675f\u540e，\u68c0\u67e5\u952e\u76d8\u64cd\u4f5c');
            input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await until(() => js("Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Save idea' && !b.disabled)"), "line 27");
        await js("Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Save idea').click()");
        await until(() => core.snapshot()?.ideas.some(i => i.body === "\u7b49\u8fd9\u4e00\u8f6e\u7ed3\u675f\u540e，\u68c0\u67e5\u952e\u76d8\u64cd\u4f5c" && i.status === "pending"), "line 29");
        const first = core.snapshot()!.ideas.find(i => i.body === "\u7b49\u8fd9\u4e00\u8f6e\u7ed3\u675f\u540e，\u68c0\u67e5\u952e\u76d8\u64cd\u4f5c")!;
        const ideaRow = `[data-idea-id="${first.id}"]`;
        await until(() => js(`!!document.querySelector('${ideaRow} button[aria-label^="Edit idea "]')`), "idea edit action");
        await js(`document.querySelector('${ideaRow} button[aria-label^="Edit idea "]').click()`);
        const editedBody = "\u7b49\u8fd9\u4e00\u8f6e\u7ed3\u675f\u540e，\u68c0\u67e5\u952e\u76d8\u64cd\u4f5c\n\u518d\u68c0\u67e5\u539f\u4f4d\u7f16\u8f91";
        await js(`(() => { const input = document.querySelector('${ideaRow} textarea');
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(editedBody)});
            input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await js(`document.querySelector('${ideaRow} textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
        await until(() => core.snapshot()?.ideas.some(i => i.id === first.id && i.body === editedBody), "inline edit persisted");
        ideaActions.edited = true;
        await until(() => js(`!!document.querySelector('${ideaRow} button[aria-label^="Delete idea "]:not(:disabled)')`), "delete ready");
        await js(`document.querySelector('${ideaRow} button[aria-label^="Delete idea "]').click()`);
        await until(() => core.snapshot()?.ideas.find(i => i.id === first.id)?.status === "discarded", "delete marks discarded");
        const undo = async () => {
            await until(() => js("Array.from(document.querySelectorAll('.notice button')).some(b => b.textContent === 'Undo')"), "undo ready");
            await js("Array.from(document.querySelectorAll('.notice button')).find(b => b.textContent === 'Undo').click()");
            await until(() => core.snapshot()?.ideas.find(i => i.id === first.id)?.status === "pending", "undo restores pending");
        };
        await undo(); ideaActions.deletedAndUndone = true;
        // A second idea makes both single-idea and header-all selection observable.
        await js(`(() => { const input = document.querySelector('textarea[aria-label="Add idea"]');
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '\u7b2c\u4e8c\u6761：\u68c0\u67e5\u5168\u90e8\u5e26\u56de');
            input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await js("document.querySelector('textarea[aria-label=\"Add idea\"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))");
        await until(() => core.snapshot()?.ideas.some(i => i.body === "\u7b2c\u4e8c\u6761：\u68c0\u67e5\u5168\u90e8\u5e26\u56de" && i.status === "pending"), "second idea saved");
        await until(() => js(`!!document.querySelector('${ideaRow} button[aria-label^="Send idea "]:not(:disabled)')`), "single-idea send ready");
        await js(`document.querySelector('${ideaRow} button[aria-label^="Send idea "]').click()`);
        await until(() => core.snapshot()?.ideas.find(i => i.id === first.id)?.status === "brought" && nativeRequests.length > 0, "single-idea bring-back");
        ideaActions.clipboard = await clipboard.readText();
        assert.equal(ideaActions.clipboard, editedBody);
        assert.equal(core.snapshot()!.ideas.find(i => i.body === "\u7b2c\u4e8c\u6761：\u68c0\u67e5\u5168\u90e8\u5e26\u56de")!.status, "pending");
        await undo(); ideaActions.sentAndUndone = true;
    }
    const captureSession = core.snapshot()!.sessions.find(s => s.nativeId === "native-capture")!;
    if (!captureSession) throw new Error("No capture fixture session");
    if (process.env.AIMSPAN_TEST_CAPTURE) {
        await capture.shortcutHandler();
        const captureJs = (script: string) => capture.window.webContents.executeJavaScript(script).catch((error: unknown) => { throw new Error(`captureJs failed: ${script.slice(0, 160)}: ${String(error)}`); });
        // Earlier bubble steps already opened capture; wait for the page to show the current open.
        await until(() => captureJs("window.aimspanCapture.getContext().then(c => !!document.querySelector(`[data-capture-open=\"${c.openId}\"] textarea:not(:disabled)`))"), "capture shows the current open");
        await until(() => captureJs("document.querySelector('[aria-label=\"Choose target\"]').textContent.includes('\u5feb\u6377\u8bb0\u5f55\u76ee\u6807')"), "line 37");
        await captureJs(`(() => { const input = document.querySelector('textarea');
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '  \u5feb\u6377\u8bb0\u5f55：\u4e2d\u6587😀\\n\u4fdd\u7559\u539f\u6587  ');
            input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        // Dispatch Enter inside the page: OS-level input events are dropped when another app holds focus.
        await captureJs("document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))");
        await until(() => core.snapshot()?.ideas.some(i => i.body === "  \u5feb\u6377\u8bb0\u5f55：\u4e2d\u6587😀\n\u4fdd\u7559\u539f\u6587  " && i.sessionId === captureSession.id), "line 43");
        await until(() => !capture.window.isVisible(), "line 44");
        window.show(); window.focus();
    }
    const captured = core.snapshot()!.ideas.find(i => i.body === "  \u5feb\u6377\u8bb0\u5f55：\u4e2d\u6587😀\n\u4fdd\u7559\u539f\u6587  " && i.sessionId === captureSession.id);
    if (!captured) throw new Error("Capture idea did not survive on its selected target");
    await until(() => js("document.body.innerText.includes('\u7b49\u8fd9\u4e00\u8f6e\u7ed3\u675f\u540e，\u68c0\u67e5\u952e\u76d8\u64cd\u4f5c')"), "line 49");
    const rendererBeforeBringBack = await js("document.body.innerText");
    let clipboardText: string | undefined;
    if (process.env.AIMSPAN_TEST_BRING_BACK) {
        await until(() => js("Array.from(document.querySelectorAll('.session-header .primary-action')).some(b => /^Bring back [1-9][0-9]*$/.test(b.textContent.trim()) && !b.disabled)"), "header bring-back action ready");
        await js("Array.from(document.querySelectorAll('.session-header .primary-action')).find(b => /^Bring back [1-9][0-9]*$/.test(b.textContent.trim()) && !b.disabled).click()");
        await until(() => core.snapshot()?.ideas.filter(i => i.sessionId === session.id).every(i => i.status === "brought") && nativeRequests.length > 0);
        clipboardText = await clipboard.readText();
    }
    const renderer = await js("document.body.innerText");
    const newSessions: { app: string; body: string; status: string; sessionId: string | null; target: string; clipboard: string }[] = [];
    if (process.env.AIMSPAN_TEST_CAPTURE) {
        const checkNewSession = async (app: "codex" | "claude", body: string, target: string) => {
            await until(() => core.snapshot()?.ideas.some(i => i.body === body && i.status === "brought") && nativeRequests.at(-1) === target, `${app} new-session handoff`);
            const idea = core.snapshot()!.ideas.find(i => i.body === body)!;
            const copied = await clipboard.readText();
            assert.equal(idea.sessionId, null);
            assert.equal(idea.status, "brought");
            assert.equal(copied, body);
            assert.equal(nativeRequests.at(-1), target);
            newSessions.push({ app, body, status: idea.status, sessionId: idea.sessionId, target, clipboard: copied });
        };
        await hover();
        await compactJs("Array.from(document.querySelectorAll('footer button')).find(b => b.textContent.trim() === 'New session').click()");
        await until(() => captureJs("window.aimspanCapture.getContext().then(c => !!document.querySelector(`[data-capture-open=\"${c.openId}\"] textarea:not(:disabled)`))"), "new-session capture context");
        assert.equal((await captureJs("window.aimspanCapture.getContext()")).preselectedTarget, NEW_SESSION_TARGETS.codex);
        const codexBody = "  \u65b0\u4f1a\u8bdd Codex：\u4e2d\u6587😀\n\u4fdd\u7559\u539f\u6587  ";
        await captureJs(`(() => { const input = document.querySelector('textarea');
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(codexBody)});
            input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await captureJs("document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))");
        await checkNewSession("codex", codexBody, "com.openai.codex");
        await until(() => !capture.window.isVisible(), "new-session receipt hides capture");
        const claudeBody = "  \u65b0\u4f1a\u8bdd Claude：\u6536\u4ef6\u7bb1😀  ";
        await core.call({ method: "idea.save", sessionId: null, body: claudeBody, expectedRevision: 0, operationId: "smoke-new-claude" });
        window.show(); window.focus();
        await until(() => js("!!document.querySelector('.inbox .session-toggle')"), "inbox pending idea");
        await js("document.querySelector('.inbox .session-toggle').click()");
        await until(() => js("Array.from(document.querySelectorAll('.inbox button')).some(b => b.textContent === 'New session · Claude')"), "inbox new-session action");
        await js("Array.from(document.querySelectorAll('.inbox button')).find(b => b.textContent === 'New session · Claude').click()");
        await checkNewSession("claude", claudeBody, "claude://code/new?source=desktop_action");
        assert.equal(core.snapshot()!.settings.lastNewSessionApp, "claude");
        await hover();
        await compactJs("Array.from(document.querySelectorAll('footer button')).find(b => b.textContent.trim() === 'New session').click()");
        await until(() => captureJs("document.querySelector('[aria-label=\"Choose target\"]')?.textContent.includes('New session · Claude')"), "last new-session app preselected");
        const context = await captureJs("window.aimspanCapture.getContext()");
        assert.equal(context.preselectedTarget, NEW_SESSION_TARGETS.claude);
        await captureJs(`window.aimspanCapture.close(${context.openId})`);
    }
    const workspace = core.snapshot()!;
    await writeFile(process.env.AIMSPAN_TEST_REPORT!, JSON.stringify({ versions: process.versions, title: window.getTitle(), core: true,
        sessions: workspace.sessions.length, activeSessions: workspace.sessions.filter(s => s.active).length,
        viewedBefore, viewedAfter: workspace.sessions.find(s => s.id === session.id)!.lastViewedAt,
        ideas: workspace.ideas.map(i => ({ body: i.body, status: i.status })), clipboardText, nativeRequests, newSessions, ideaActions,
        capture: { body: captured.body, sessionId: captured.sessionId, nativeId: captureSession.nativeId, hidden: !capture.window.isVisible() },
        bubble: bubbleResult, renderer, rendererBeforeBringBack, coreTransport: "MessagePort" }));
    if (process.env.AIMSPAN_TEST_SCREENSHOT) await writeFile(process.env.AIMSPAN_TEST_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
}
