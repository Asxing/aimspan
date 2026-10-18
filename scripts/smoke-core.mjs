import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/core/dist/index.js';
const directory = mkdtempSync(join(realpathSync(tmpdir()), '__aimspan_fixture__-core-'));
let store = new Store(directory);
try {
    const session = store.observe({ agent: 'codex', nativeId: 'native-smoke', title: 'Continue work', project: '/__aimspan_fixture__/project', state: 'waiting', at: new Date().toISOString(), confidence: 'explicit', sources: [], version: 'v1' });
    const idea = store.call({ method: 'idea.save', sessionId: session.id, body: '等这一轮结束后，检查键盘操作', expectedRevision: 0, operationId: 'idea' });
    store.call({ method: 'draft.save', operationId: 'draft', expectedRevision: 0, target: session.id, body: '另一条未提交草稿' });
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.workspace().ideas, [idea]);
    assert.equal(store.workspace().drafts[session.id].body, '另一条未提交草稿');
    assert.equal(store.workspace().sessions[0].nativeId, 'native-smoke');
    console.log(JSON.stringify({ core: 'TypeScript', database: 'SQLite', restart: 'passed', idea: 'retained', draft: 'retained' }));
} finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
}
