import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
new Function(readFileSync(new URL('../src/milestones.js', import.meta.url), 'utf8'))();
new Function(readFileSync(new URL('../src/garden.js', import.meta.url), 'utf8'))();
const { Milestones, Garden } = globalThis;
let clock = 1000; const fired = [], said = [], saves = [];
const state = {};
const m = new Milestones(null, { now: () => clock, state, save: (s) => saves.push(1), fire: (e, d) => fired.push(e), say: (k) => said.push(k) });
// 10 clicks within 15s fire bubbleTea once; the 4-click anger (engine) is separate and untouched
for (let i = 0; i < 9; i++) { clock += 1; m.record('click'); }
assert.equal(fired.length, 0);
clock += 1; m.record('click'); assert.deepEqual(fired, ['bubbleTea']); assert.equal(said.at(-1), 'clickTea');
// No cooldown: a second click burst fires immediately.
for (let i = 0; i < 10; i++) { clock += 1; m.record('click'); } assert.equal(fired.length, 2, 'second burst fires without cooldown');
clock += 700; for (let i = 0; i < 10; i++) { clock += 1; m.record('click'); } assert.equal(fired.length, 3, 'fires again later too');
// clicks spread over more than 15s never reach 10
for (let i = 0; i < 20; i++) { clock += 2; m.record('click'); } assert.equal(fired.length, 3, 'slow clicks do not count');
// strokes accumulate without a window (across restarts): 5 -> hearts
for (let i = 0; i < 4; i++) { clock += 100; m.record('stroke'); } assert.equal(fired.length, 3);
clock += 100; m.record('stroke'); assert.equal(fired.at(-1), 'hearts');
// state survives a "restart"
const m2 = new Milestones(null, { now: () => clock, state: JSON.parse(JSON.stringify(state)), save: () => {}, fire: (e) => fired.push(e), say: () => {} });
assert.equal(m2.progress('clickTea').fired, 3); assert.equal(m2.progress('strokeLove').fired, 1);
// custom thresholds from pet.json
const m3 = new Milestones([{ id: 'x', event: 'click', count: 3, windowSec: 5, effect: 'petals' }], { now: () => clock, state: {}, save: () => {}, fire: (e) => fired.push(e), say: () => {} });
m3.record('click'); m3.record('click'); m3.record('click'); assert.equal(fired.at(-1), 'petals');
console.log('milestones ok');

// garden: active typing seconds only; pauses do not regress; stages; pick -> flower milestone; restart keeps the garden
const gs = { }; const gsaid = []; const picked = [];
clock = 5000;
const g = new Garden({ stagesSec: [3, 6, 9, 12] }, { now: () => clock, state: gs, save: () => {}, say: (k) => gsaid.push(k), onPick: (f) => picked.push(f) });
for (let i = 0; i < 2; i++) { clock += 1; g.onTypingSecond(4); } assert.equal(gs.garden.stage, 1); assert.equal(gsaid.at(-1), 'flowerBud');
clock += 600; assert.equal(g.view().headStage, 1, 'pausing keeps the bud');
for (let i = 0; i < 2; i++) { clock += 1; g.onTypingSecond(2); } assert.equal(gs.garden.stage, 2); assert.equal(gsaid.at(-1), 'flowerBloom');
for (let i = 0; i < 6; i++) { clock += 1; g.onTypingSecond(1); }
assert.equal(picked.length, 1, 'picked at stage 4'); assert.equal(gs.garden.stage, 0); assert.equal(gs.garden.flowers.length, 1); assert.equal(gsaid.at(-1), 'flowerPick');
assert.ok(g.view().pickAnim !== null, 'pick animation running'); clock += 2; assert.equal(g.view().pickAnim, null);
clock += 0.5; g.onTypingSecond(3); clock += 0.1; g.onTypingSecond(3); assert.equal(gs.garden.growthSec, 2, 'at most one rate-weighted tick per real second');
const g2 = new Garden({ stagesSec: [3, 6, 9, 12] }, { now: () => clock, state: JSON.parse(JSON.stringify(gs)), save: () => {}, say: () => {}, onPick: () => {} });
assert.equal(g2.view().total, 1, 'garden survives restart');
console.log('garden ok');
// effects: the throw parabola starts at the pet and ends at the nearer canvas edge
new Function(readFileSync(new URL('../src/effects.js', import.meta.url), 'utf8'))();
const { KapiFx } = globalThis;
const thr = KapiFx.planThrow({ x: 300, y: 900 }, 1920, 1080);
assert.deepEqual([Math.round(thr.at(0).x), Math.round(thr.at(0).y)], [300, 900]); assert.equal(thr.toRight, true);
assert.ok(Math.abs(thr.at(thr.hitAt).x - 1880) < 1 && thr.at(thr.hitAt).y < 900, 'hits the right edge above the start');
assert.equal(KapiFx.planThrow({ x: 1700, y: 900 }, 1920, 1080).toRight, false);
assert.equal(KapiFx.planPearls({ x: 1, y: 2 }, 12).length, 12);
console.log('effects ok');
