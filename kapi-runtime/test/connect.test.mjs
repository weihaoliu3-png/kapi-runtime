import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
new Function(readFileSync(new URL('../src/connect.js', import.meta.url), 'utf8'))();
const { Connect } = globalThis;
// URL from the spec
const c1 = Connect.extractCandidates('https://capafy.ai/conversations?id=2103014882086375426');
assert.deepEqual(c1, ['2103014882086375426']);
assert.deepEqual(Connect.extractCandidates('https://capafy.ai/#/chat/9988776655443322?instanceId=1122334455667788'), ['1122334455667788', '9988776655443322']);
assert.deepEqual(Connect.extractCandidates('not a url'), []);
assert.deepEqual(Connect.extractCandidates('https://capafy.ai/conversations'), [], 'no numeric segments');
// matching
const inst = [{ instanceId: '2103014882086375426', name: 'Kapi' }, { instanceId: '1', name: 'x' }];
assert.deepEqual(Connect.matchInstance(c1, inst), { instanceId: '2103014882086375426' });
assert.deepEqual(Connect.matchInstance(['999'], inst), { instances: inst });
// content + tags
const content = Connect.buildContent('今天好累', { localTime: '22:41', lastAction: 'idle', actions: ['wave', 'sleep'] });
assert.ok(content.startsWith('[petchat]\n用户消息：今天好累')); assert.ok(content.includes('可用动作：wave,sleep'));
const r = Connect.parseTags('活该。……早点回来。[expr:sad][action:wave][action:bogus]', ['wave'], ['sad']);
assert.deepEqual(r, { text: '活该。……早点回来。', action: 'wave', expr: 'sad' });
assert.equal(Connect.errorKey(409, ''), 'busy'); assert.equal(Connect.errorKey(400, { error: 'subscription quota exceeded' }), 'quota'); assert.equal(Connect.errorKey(500, ''), 'offline');
console.log('connect tests passed');
