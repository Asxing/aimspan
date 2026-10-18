import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, appendFile, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Run `pnpm build && pnpm screenshots` on macOS with a desktop display.
// Only the loopback inspector is contacted; all native sources are synthetic.
const root = resolve(import.meta.dirname, '..');
// The electron package exports the native binary path; spawning it directly (not the Node CLI wrapper) lets kill() reach Electron itself.
const electron = createRequire(join(root, 'apps/desktop/package.json'))('electron');
const jsonl = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';
const event = (type, timestamp, fields = {}) => ({ type: 'event_msg', timestamp, payload: { type, ...fields } });
const item = (type, timestamp, fields) => event('item_completed', timestamp, { item: { type, ...fields } });
const content = text => [{ type: 'text', text }];

async function fixtures(temporary) {
    const profile = join(temporary, 'profile');
    const codex = join(temporary, 'sources', 'codex');
    const claude = join(temporary, 'sources', 'claude');
    const now = Date.now();
    const ago = seconds => new Date(now - seconds * 1000).toISOString();
    const rollouts = join(codex, 'sessions', ...ago(0).slice(0, 10).split('-'));
    for (const path of [profile, rollouts, join(codex, 'archived_sessions'), join(claude, 'sessions')]) {
        await mkdir(path, { recursive: true, mode: 0o700 });
    }
    const sessions = [
        { id: '10000000-0000-4000-8000-000000000001', project: 'docs-site', title: 'Fix the navigation sidebar on mobile', age: 360,
            originator: 'Codex Desktop', message: 'Checking the drawer focus order and the small-screen layout.', command: 'pnpm test navigation', file: 'src/components/Sidebar.tsx' },
        { id: '10000000-0000-4000-8000-000000000002', project: 'docs-site', title: 'Draft the release notes', age: 720,
            originator: 'codex_cli_rs', message: 'Grouping the changes into highlights and upgrade notes.', command: 'pnpm lint:docs', file: 'content/releases/next.md' },
        { id: '10000000-0000-4000-8000-000000000003', project: 'research', title: 'Summarize agent memory papers', age: 1080,
            originator: 'Codex Desktop', message: 'Comparing retrieval strategies and how each paper measures recall.', command: 'python summarize.py --check', file: 'notes/memory-comparison.md' },
    ];
    for (const session of sessions) {
        session.cwd = join(temporary, 'projects', session.project);
        session.turn = `turn-${session.id}`;
        session.startedAt = ago(session.age);
        session.path = join(rollouts, `rollout-${session.startedAt.replaceAll(':', '-')}-${session.id}.jsonl`);
        await mkdir(session.cwd, { recursive: true });
        await writeFile(session.path, jsonl([
            { type: 'session_meta', timestamp: session.startedAt, payload: { id: session.id, cwd: session.cwd, originator: session.originator, source: 'cli', thread_source: 'user' } },
            event('task_started', session.startedAt, { turn_id: session.turn, started_at: session.startedAt }),
            item('UserMessage', ago(session.age - 1), { content: content(session.title) }),
            item('AgentMessage', ago(session.age - 20), { content: content(session.message), phase: 'commentary' }),
            item('CommandExecution', ago(session.age - 35), { command: session.command, exit_code: 0, status: 'completed' }),
            item('FileChange', ago(session.age - 45), { changes: { [join(session.cwd, session.file)]: { type: 'update' } } }),
        ]));
    }
    await writeFile(join(codex, 'session_index.jsonl'), jsonl(sessions.map(session => ({ id: session.id, thread_name: session.title, updated_at: ago(0) }))));
    // Completed Claude transcripts need no registry entry or borrowed live PID.
    const completed = [
        { id: '20000000-0000-4000-8000-000000000001', project: 'api', title: 'Add rate limiting to the upload endpoint', age: 2400,
            reply: 'Added per-client upload limits and retry headers. All endpoint tests pass.', file: 'src/routes/upload.ts' },
        { id: '20000000-0000-4000-8000-000000000002', project: 'docs-site', title: 'Improve keyboard navigation in search', age: 3600,
            reply: 'Search results now support arrow keys, Enter, and Escape. Focus returns to the search field.', file: 'src/components/Search.tsx' },
    ];
    for (const session of completed) {
        const cwd = join(temporary, 'projects', session.project);
        const directory = join(claude, 'projects', cwd.replaceAll('/', '-'));
        await mkdir(cwd, { recursive: true });
        await mkdir(directory, { recursive: true });
        const record = (type, seconds, fields) => ({ type, timestamp: ago(seconds), sessionId: session.id, cwd, entrypoint: 'cli', ...fields });
        await writeFile(join(directory, `${session.id}.jsonl`), jsonl([
            record('user', session.age, { message: { role: 'user', content: session.title } }),
            record('custom-title', session.age - 1, { customTitle: session.title }),
            record('assistant', session.age - 60, { message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', id: `edit-${session.id}`, input: { file_path: join(cwd, session.file) } }], stop_reason: null } }),
            record('assistant', session.age - 180, { message: { role: 'assistant', content: content(session.reply), stop_reason: 'end_turn' } }),
            record('system', session.age - 180, { subtype: 'turn_duration', durationMs: 180000 }),
        ]));
    }
    return { profile, codex, claude, sessions, total: sessions.length + completed.length, waiting: sessions[1], research: sessions[2] };
}

async function freePort() {
    const server = createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const { port } = server.address();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
}

async function connect(url) {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 0;
    const fail = () => {
        for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Electron inspector disconnected')); }
        pending.clear();
    };
    socket.addEventListener('close', fail);
    socket.addEventListener('error', fail);
    socket.addEventListener('message', ({ data }) => {
        const message = JSON.parse(data);
        const request = pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
    });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.close(); reject(new Error('Inspector connection timed out')); }, 10000);
        socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not connect to Electron inspector')); }, { once: true });
    });
    const call = (method, params) => new Promise((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) { reject(new Error('Electron inspector is not open')); return; }
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Inspector timed out: ${method}`)); }, 15000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
    });
    return {
        async evaluate(expression) {
            const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
            return result.result?.value;
        },
        close() { fail(); socket.close(); },
    };
}

async function main() {
    assert.equal(process.platform, 'darwin', 'Screenshots require macOS with a desktop display.');
    assert.equal(typeof WebSocket, 'function', 'Use Node >= 22.19 with the built-in WebSocket.');
    for (const path of [electron, 'apps/desktop/dist/main/index.cjs', 'apps/desktop/dist/preload/index.cjs', 'apps/desktop/dist/renderer/index.html', 'apps/desktop/dist/brand/trayTemplate.png']) {
        await access(resolve(root, path)).catch(() => { throw new Error('Build the desktop app first: pnpm build && pnpm screenshots'); });
    }
    const temporary = await mkdtemp('/private/tmp/__aimspan_fixture__-screenshots-');
    const abort = new AbortController();
    const interrupt = signal => abort.abort(new Error(`Interrupted by ${signal}`));
    const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM');
    process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
    const deadline = setTimeout(() => abort.abort(new Error('Screenshot run exceeded 150 seconds')), 150000);
    let child, exited, exitPromise, cdp;
    let log = '';
    const captures = [];
    let summary;
    const until = async (check, label, timeout = 20000) => {
        const end = Date.now() + timeout;
        do {
            abort.signal.throwIfAborted();
            if (exited) throw new Error(`Electron exited before ${label}: ${JSON.stringify(exited)}`);
            const value = await check();
            if (value) return value;
            await delay(100);
        } while (Date.now() < end);
        throw new Error(`Timed out waiting for ${label}`);
    };
    try {
        const fixture = await fixtures(temporary);
        const port = await freePort();
        // Never inherit a dev-server URL, lifecycle harness, or alternative profile.
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AIMSPAN_') && !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH'].includes(key)));
        Object.assign(env, { AIMSPAN_TEST_PROFILE: fixture.profile, AIMSPAN_CODEX_ROOT: fixture.codex, AIMSPAN_CLAUDE_ROOT: fixture.claude });
        child = spawn(electron, [`--inspect=${port}`, 'apps/desktop'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
        exitPromise = new Promise(resolve => {
            child.once('error', error => { exited = { error: error.message }; resolve(exited); });
            child.once('exit', (code, signal) => { exited = { code, signal }; resolve(exited); });
        });
        for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log = (log + bytes.toString()).slice(-6000); });
        const endpoint = await until(async () => {
            try {
                const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
                if (!response.ok) return false;
                return (await response.json()).find(target => target.type === 'node')?.webSocketDebuggerUrl;
            } catch { return false; }
        }, 'main-process inspector');
        cdp = await connect(endpoint);
        const evaluate = expression => cdp.evaluate(expression);
        await until(() => evaluate(`!!process.mainModule && typeof process.mainModule.require === 'function'`), 'Electron main module');
        await evaluate(`globalThis.__aimspanScreenshots = { electron: process.mainModule.require('electron'), windows: {} }; true`);
        await until(() => evaluate(`(() => {
            const harness = globalThis.__aimspanScreenshots;
            for (const name of ['index', 'bubble', 'compact', 'capture']) {
                const window = harness.electron.BrowserWindow.getAllWindows().find(window => window.webContents.getURL().split('?')[0].endsWith('/' + name + '.html'));
                if (!window || window.webContents.isLoading()) return false;
                harness.windows[name] = window;
                window.webContents.setBackgroundThrottling(false);
            }
            return true;
        })()`), 'four built renderer windows');
        const win = name => `globalThis.__aimspanScreenshots.windows[${JSON.stringify(name)}]`;
        const renderer = (name, expression) => evaluate(`${win(name)}.webContents.executeJavaScript(${JSON.stringify(expression)})`);
        const panel = expression => renderer('index', expression);
        const workspace = () => panel(`window.aimspan.call({ method: 'workspace' })`);
        const click = (name, selector) => renderer(name, `(() => {
            const element = document.querySelector(${JSON.stringify(selector)});
            if (!element || element.disabled) throw new Error('Control unavailable: ' + ${JSON.stringify(selector)});
            element.click(); return true;
        })()`);
        await until(() => panel(`typeof window.aimspan?.call === 'function' && !!document.querySelector('.panel-header')`), 'panel API');
        const initial = await until(async () => {
            const value = await workspace();
            return value.sessions.length === fixture.total && value.sessions.every(session => session.lastViewedAt && !session.baselinePending) && value;
        }, 'first observation of all five synthetic sessions');
        assert.equal(initial.diagnostics.length, 0, 'Synthetic sources must be readable without diagnostics');
        assert.deepEqual(initial.sessions.filter(session => session.state === 'running').map(session => session.nativeId).sort(), fixture.sessions.map(session => session.id).sort());
        assert.equal(initial.sessions.filter(session => session.state === 'idle').length, 2);
        const waitingId = initial.sessions.find(session => session.nativeId === fixture.waiting.id).id;
        const researchId = initial.sessions.find(session => session.nativeId === fixture.research.id).id;
        await evaluate(`globalThis.__aimspanScreenshots.electron.nativeTheme.themeSource = 'light'`);
        await panel(`(async () => {
            const workspace = await window.aimspan.call({ method: 'workspace' });
            await window.aimspan.call({ method: 'settings.save', settings: { ...workspace.settings, pinned: true, notifications: false, notificationsExplicit: true } });
        })()`);
        await until(async () => (await workspace()).settings.pinned, 'pinned panel');
        // A completion in the initial file would be history, not a waiting session.
        const completedAt = new Date().toISOString();
        const reply = '**Release notes are ready for review.**\n\n- Clearer mobile navigation\n- Faster search with keyboard support\n- Upgrade steps checked against the latest build';
        await appendFile(fixture.waiting.path, jsonl([
            item('AgentMessage', completedAt, { content: content(reply), phase: 'final_answer' }),
            event('task_complete', completedAt, { turn_id: fixture.waiting.turn, completed_at: completedAt,
                duration_ms: Date.parse(completedAt) - Date.parse(fixture.waiting.startedAt), last_agent_message: reply }),
        ]));
        await until(async () => (await workspace()).sessions.find(session => session.id === waitingId)?.state === 'waiting', 'post-startup completion', 70000);
        const counts = await until(async () => {
            const state = await renderer('bubble', 'window.aimspanBubble.getState()');
            return state.running === 2 && state.waiting === 1 && { running: state.running, waiting: state.waiting };
        }, 'bubble counts (shared with the tray)');
        for (const [sessionId, body] of [[researchId, 'Compare how the papers handle stale memories.'], [waitingId, 'Add a short migration example before publishing.']]) {
            await panel(`window.aimspan.call(${JSON.stringify({ method: 'idea.save', sessionId, body, expectedRevision: 0, operationId: `screenshots-idea-${sessionId}` })})`);
        }
        await until(async () => (await workspace()).ideas.filter(idea => idea.status === 'pending').length === 2, 'two pending ideas');

        const position = async (name, width, height) => evaluate(`(() => {
            const window = ${win(name)}, electron = globalThis.__aimspanScreenshots.electron;
            const area = electron.screen.getPrimaryDisplay().workArea;
            const width = Math.min(${width}, area.width), height = Math.min(${height}, area.height);
            window.setBounds({ x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height });
            window.show(); window.focus();
        })()`);
        const capture = async (name, file, dark = false) => {
            await until(() => renderer(name, `matchMedia('(prefers-color-scheme: dark)').matches === ${dark}`), `${file} theme`);
            await renderer(name, `document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))`);
            // Allow native bounds changes and React's ResizeObserver layout to paint.
            await delay(250);
            const result = await evaluate(`(async () => {
                const window = ${win(name)};
                if (!window.isVisible()) throw new Error('Screenshot window is hidden');
                const scale = globalThis.__aimspanScreenshots.electron.screen.getDisplayMatching(window.getBounds()).scaleFactor;
                const image = await window.webContents.capturePage();
                if (image.isEmpty()) throw new Error('Screenshot is empty');
                return { png: image.toPNG({ scaleFactor: scale }).toString('base64'), scale };
            })()`);
            const png = Buffer.from(result.png, 'base64');
            assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Expected a PNG');
            await writeFile(join(temporary, file), png);
            captures.push({ file: `docs/images/${file}`, width: png.readUInt32BE(16), height: png.readUInt32BE(20), scale: result.scale });
        };

        // Pin the compact list through its own API so cursor polling cannot dismiss it.
        await renderer('bubble', 'window.aimspanBubble.toggle()');
        await renderer('compact', `(async () => { if (!(await window.aimspanCompact.getState()).pinned) await window.aimspanCompact.togglePinned(); })()`);
        await until(() => renderer('compact', `document.querySelectorAll('[data-compact-id]').length === 3 && document.querySelector('.compact[data-pinned="true"]') !== null && document.querySelectorAll('.idea-badge').length === 2`), 'compact list and idea badges');
        await evaluate(`${win('compact')}.showInactive()`);
        await capture('compact', 'compact-en.png');
        await renderer('compact', 'window.aimspanCompact.close()');

        await renderer('compact', `window.aimspanCompact.capture(${JSON.stringify(researchId)})`);
        await until(() => renderer('capture', `window.aimspanCapture.getContext().then(context => context.preselectedTarget === ${JSON.stringify(researchId)} && !!document.querySelector('[data-capture-open="' + context.openId + '"] textarea:not(:disabled)'))`), 'quick capture target');
        const draft = 'Include a comparison of retrieval quality and latency.';
        await renderer('capture', `(() => {
            const input = document.querySelector('textarea');
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(draft)});
            input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await until(() => renderer('capture', `document.querySelector('textarea')?.value === ${JSON.stringify(draft)} && document.querySelectorAll('.capture-chips button').length === 5`), 'quick capture chips');
        await capture('capture', 'capture-en.png');
        await renderer('capture', 'window.aimspanCapture.getContext().then(context => window.aimspanCapture.close(context.openId))');

        await position('index', 640, 960);
        // Apply any ordering frozen while the panel had keyboard focus at startup.
        await panel(`document.querySelector('.update-pill')?.click()`);
        await until(() => panel(`!!document.querySelector('[data-row-id="${waitingId}"] .session-toggle')`), 'waiting row');
        await click('index', `[data-row-id="${waitingId}"] .session-toggle`);
        const readyPanel = () => panel(`!!document.querySelector('[data-row-id="${waitingId}"] .session-toggle[aria-expanded="true"]') && document.querySelector('[data-section="reply"]')?.textContent.includes('Release notes are ready') && document.querySelector('[data-section="ideas"]')?.textContent.includes('migration example')`);
        await until(readyPanel, 'expanded catch-up card with result and idea');
        await panel(`document.querySelector('.virtual-list').scrollTop = 0`);
        await capture('index', 'panel-en.png');

        const settings = async () => {
            await click('index', '.panel-header > button:last-child');
            await until(() => panel(`!!document.querySelector('.settings [data-language="en"]')`), 'settings language control');
            await panel(`document.querySelector('.settings').scrollTop = 0`);
        };
        const language = async value => {
            await click('index', `[data-language="${value}"]`);
            await until(async () => (await workspace()).settings.language === value && await panel(`document.documentElement.lang === ${JSON.stringify(value === 'zh' ? 'zh-CN' : 'en')}`), `${value} language applied`);
            await click('index', '.settings-header > button:first-child');
            await until(readyPanel, 'same expanded catch-up card');
            await panel(`document.querySelector('.virtual-list').scrollTop = 0`);
        };
        await settings();
        await capture('index', 'settings-en.png');
        await language('zh');
        await capture('index', 'panel-zh.png');
        await settings();
        await language('en');
        await evaluate(`globalThis.__aimspanScreenshots.electron.nativeTheme.themeSource = 'dark'`);
        await capture('index', 'panel-dark-en.png', true);
        const final = await workspace();
        assert.equal(final.sessions.length, fixture.total);
        assert.equal(final.diagnostics.length, 0);
        assert.equal(final.ideas.filter(idea => idea.status === 'pending').length, 2);
        summary = { files: captures, countsSeen: { sessions: final.sessions.length, active: final.sessions.filter(session => session.active).length,
            ...counts, pendingIdeas: 2 }, syntheticOnly: true };
    } catch (error) {
        if (log) console.error(log);
        throw error;
    } finally {
        try {
            if (cdp) {
                try {
                    await cdp.evaluate(`(() => {
                        const electron = process.mainModule.require('electron');
                        for (const window of electron.BrowserWindow.getAllWindows()) window.hide();
                        setTimeout(() => electron.app.quit(), 0); return true;
                    })()`);
                } catch { /* The process may already have exited. */ }
                cdp.close(); // Node can wait for the debugger to detach before exiting.
            }
            const waitForExit = async milliseconds => {
                const end = Date.now() + milliseconds;
                while (!exited && Date.now() < end) await delay(100);
                return !!exited;
            };
            if (child) {
                if (!await waitForExit(8000)) child.kill('SIGTERM');
                if (!await waitForExit(2000)) child.kill('SIGKILL');
                if (!await waitForExit(2000)) throw new Error('Electron did not exit; temporary profile cannot be removed safely');
                await exitPromise;
                if (summary) assert.equal(exited.code, 0, `Electron did not quit cleanly: ${JSON.stringify(exited)}`);
            }
            if (summary) {
                await mkdir(join(root, 'docs/images'), { recursive: true });
                for (const { file } of captures) await copyFile(join(temporary, file.split('/').at(-1)), join(root, file));
            }
        } finally {
            clearTimeout(deadline);
            process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
            if (!child || exited) await rm(temporary, { recursive: true, force: true });
        }
    }
    console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
