import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/care-layout.js', import.meta.url), 'utf8');
const scope = {};
runInNewContext(source, scope);
const { topPadding, windowTop } = scope.CareLayout;

assert.equal(topPadding(90), 130, 'short panel keeps the normal pet layout');
assert.equal(topPadding(202.2), 219, 'expanded panel has a clear gap above the pet');
assert.equal(windowTop(400, 219, 0), 181, 'pet stays at the same screen height when room exists');
assert.equal(windowTop(150, 219, 0), 0, 'panel remains visible at the monitor top edge');
assert.equal(windowTop(-40, 219, -100), -100, 'negative monitor coordinates are supported');
console.log('care layout OK');
