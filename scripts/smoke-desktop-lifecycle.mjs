import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../packages/core/dist/index.js';
import { formatBringBack } from '../packages/protocol/dist/index.js';
const root = resolve(import.meta.dirname, '..');
const temporary = mkdtempSync('/private/tmp/__aimspan_fixture__-ui-');
chmodSync(temporary, 0o700);
const profile = join(temporary, 'profile'), sources = join(temporary, 'sources');
const codexSources = join(sources, 'codex'), claudeSources = join(sources, 'claude');
mkdirSync(profile, { mode: 0o700 });
mkdirSync(codexSources, { recursive: true });
mkdirSync(claudeSources);
const timestamp = new Date().toISOString();
writeFileSync(join(codexSources, 'a.jsonl'), [
    { type: 'session_meta', payload: { id: 'native-a', cwd: '/__aimspan_fixture__/project', originator: 'codex_cli_rs' } },
    { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: 'turn-a', started_at: timestamp } },
    { type: 'event_msg', timestamp, payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '检查会话列表' }] } } },
    { type: 'event_msg', timestamp, payload: { type: 'task_complete', turn_id: 'turn-a', completed_at: timestamp, last_agent_message: '合成回复：已完成列表检查' } }
].map(value => JSON.stringify(value)).join('\n') + '\n');
writeFileSync(join(codexSources, 'capture.jsonl'), [
    { type: 'session_meta', payload: { id: 'native-capture', cwd: '/__aimspan_fixture__/capture', originator: 'codex_cli_rs' } },
    { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: 'turn-capture', started_at: timestamp } },
    { type: 'event_msg', timestamp, payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '快捷记录目标' }] } } }
].map(value => JSON.stringify(value)).join('\n') + '\n');
const executable = process.env.AIMSPAN_SMOKE_APP ?? join(root, 'apps/desktop/node_modules/.bin/electron');
async function launch(phase) {
    const report = join(temporary, `${phase}.json`);
    const child = spawn(executable, process.env.AIMSPAN_SMOKE_APP ? [] : ['.'], {
        cwd: join(root, 'apps/desktop'),
        env: { ...process.env, AIMSPAN_TEST_PROFILE: profile, AIMSPAN_CODEX_ROOT: codexSources, AIMSPAN_CLAUDE_ROOT: claudeSources,
            AIMSPAN_TEST_IDEAS: phase === 'save' ? '1' : '', AIMSPAN_TEST_BRING_BACK: phase === 'restart' ? '1' : '',
            AIMSPAN_TEST_CAPTURE: phase === 'save' ? '1' : '',
            AIMSPAN_TEST_REPORT: report, AIMSPAN_TEST_EXIT: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', bytes => log += bytes.toString());
    child.stderr.on('data', bytes => log += bytes.toString());
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
    try {
        const result = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', (code, signal) => resolve({ code, signal }));
        });
        assert.equal(result.code, 0, `${phase}: signal=${result.signal}\n${log.slice(-3000)}`);
        assert.ok(existsSync(report), `${phase}: Missing report. ${log.slice(-3000)}`);
        const value = JSON.parse(readFileSync(report, 'utf8'));
        assert.equal(value.core, true);
        assert.ok(value.sessions >= 1);
        assert.ok(value.activeSessions >= 1);
        assert.ok(Date.parse(value.viewedAfter) > Date.parse(value.viewedBefore), 'Opening the card advances lastViewedAt');
        // Ended sessions show their execution result directly (no separate "Last reply" heading).
        assert.match(value.renderer, /合成回复：已完成列表检查/);
        assert.match(value.renderer, /My ideas/i);
        assert.match(value.rendererBeforeBringBack, /等这一轮结束后，检查键盘操作/);
        assert.equal(value.versions.node.startsWith('24.'), true);
        assert.equal(value.capture.body, '  快捷记录：中文😀\n保留原文  ');
        assert.equal(value.capture.nativeId, 'native-capture');
        assert.equal(value.capture.hidden, true);
        assert.deepEqual(value.bubble, { exists: true, focusable: false, frameInsideDisplay: true, visibleWidth: 28,
            compactOpened: true, expandedSession: 'native-capture', preselectedSession: 'native-capture', inboxPreselected: true });
        return value;
    } finally {
        clearTimeout(timeout);
    }
}
let passed = false;
try {
    const saved = await launch('save');
    assert.deepEqual(saved.nativeRequests, ['codex://threads/native-a', 'com.openai.codex', 'claude://code/new?source=desktop_action']);
    assert.deepEqual(saved.ideaActions, { edited: true, deletedAndUndone: true, sentAndUndone: true,
        clipboard: '等这一轮结束后，检查键盘操作\n再检查原位编辑' });
    assert.deepEqual(saved.newSessions, [
        { app: 'codex', body: '  新会话 Codex：中文😀\n保留原文  ', status: 'brought', sessionId: null,
            target: 'com.openai.codex', clipboard: '  新会话 Codex：中文😀\n保留原文  ' },
        { app: 'claude', body: '  新会话 Claude：收件箱😀  ', status: 'brought', sessionId: null,
            target: 'claude://code/new?source=desktop_action', clipboard: '  新会话 Claude：收件箱😀  ' },
    ]);
    const restarted = await launch('restart');
    assert.equal(restarted.capture.sessionId, saved.capture.sessionId);
    const reopened = new Store(join(profile, 'state'));
    try {
        const workspace = reopened.workspace();
        assert.equal(workspace.ideas.length, 5);
        assert.equal(workspace.settings.lastNewSessionApp, 'claude');
        for (const savedIdea of saved.newSessions) {
            const idea = workspace.ideas.find(i => i.body === savedIdea.body);
            assert.equal(idea.sessionId, null);
            assert.equal(idea.status, 'brought');
        }
        const panelIdea = workspace.ideas.find(i => i.body === '等这一轮结束后，检查键盘操作\n再检查原位编辑');
        assert.equal(panelIdea.status, 'brought');
        const secondIdea = workspace.ideas.find(i => i.body === '第二条：检查全部带回');
        assert.equal(secondIdea.status, 'brought');
        const panelIdeas = workspace.ideas.filter(i => i.sessionId === panelIdea.sessionId);
        assert.equal(panelIdeas.length, 2);
        assert.equal(restarted.clipboardText, formatBringBack(panelIdeas));
        const captureIdea = workspace.ideas.find(i => i.body === restarted.capture.body);
        assert.equal(captureIdea.sessionId, workspace.sessions.find(s => s.nativeId === 'native-capture').id);
        assert.equal(captureIdea.status, 'pending');
        assert.deepEqual(restarted.nativeRequests, ['codex://threads/native-a']);
    } finally {
        reopened.close();
    }
    console.log(JSON.stringify({ desktop: 'passed', versions: { electron: restarted.versions.electron, node: restarted.versions.node }, sessions: restarted.sessions, coreTransport: restarted.coreTransport, ideas: 'UI save, restart, catch-up viewed marker, bring-back status and clipboard passed', capture: 'direct shortcut handler, renderer Enter save, hide and restart on the correct target passed', bubble: 'unfocusable in-screen half-hide, simulated hover, card expansion, per-session capture and inbox capture passed', nativeOpen: 'recorded fixture target; no real app launch' }));
    passed = true;
} finally {
    if (passed) rmSync(temporary, { recursive: true, force: true });
    else console.error('Fixture retained:', temporary);
}
