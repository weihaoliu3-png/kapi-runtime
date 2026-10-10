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

// ---- overlay stack (0.8.9): bubble and chat sit ABOVE whatever is drawn on the pet's head, never over it ----
const { stack, blocked, EDGE } = scope.CareLayout;
let r = stack(0, [{ id: 'bubble', h: 40 }]);
assert.equal(r.tops.bubble, -52, 'bubble: 12 px gap above the pad line when nothing pokes above it');
assert.equal(r.needPad, 130, 'fits inside the base padding');
r = stack(90, [{ id: 'bubble', h: 40 }, { id: 'card', h: 36 }]);
assert.equal(r.tops.bubble, -142, 'bubble clears a 90 px flower');
assert.equal(r.tops.card, -190, 'a second overlay is stacked above the bubble');
assert.equal(r.needPad, 190 + EDGE, 'window must grow so the whole stack is inside it');
r = stack(100, [{ id: 'card', h: 36 }]);
assert.ok(r.tops.card + 36 <= -100 - 12, 'overlay bottom stays >= 12 px above the flower top');
assert.equal(blocked(100, 190, 0), true, 'no room above at the monitor edge');
assert.equal(blocked(400, 190, 0), false);
console.log('overlay stack OK');
