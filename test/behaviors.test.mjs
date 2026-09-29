import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
globalThis.performance = { now: () => clock * 1000 }; let clock = 0;
globalThis.PET_PRIORITY = { random: 20 };
new Function(readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8'))();
new Function(readFileSync(new URL('../src/behaviors.js', import.meta.url), 'utf8'))();
const { Behaviors, I18N } = globalThis;
const said = [], played = [], exprs = [];
const win = { x: 500, y: 400, w: 360, h: 480 }, mon = { x: 0, y: 0, w: 1920, h: 1080 };
const engine = { hover: false, sleeping: false, state: { action: 'idle' }, play: (id) => played.push(id) };
const b = new Behaviors({ getWin: () => win, getMonitor: () => mon, getCursor: () => ({ x: 1200, y: 500 }), engine,
  say: (x) => said.push(x), expr: (n) => exprs.push(n), play: (id) => played.push(id), line: () => null, t: () => I18N.pick('en') });

// throw: flies, bounces on floor, settles, plays drop, says thrown line
assert.equal(b.throwWith(100, 50), false, 'too slow is not a throw');
assert.ok(b.throwWith(900, -600)); assert.equal(b.mode, 'fly');
let steps = 0, landed = false;
while (steps++ < 600 && !landed) { clock += 1 / 30; const r = b.step(1 / 30); if (!r) break; win.x = r.x; win.y = r.y; landed = !!r.landed; }
assert.ok(landed, 'lands'); assert.equal(win.y, mon.h - win.h, 'rests on floor'); assert.ok(played.includes('drop')); assert.ok(said.at(-1).includes('throw'));

// come here walks toward cursor and flips when moving left
const before = win.x; b.comeHere(); assert.equal(b.mode, 'walk'); assert.equal(b.flip, (1200 - win.w / 2) < before, 'faces walking direction');
for (let i = 0; i < 400; i++) { clock += 1 / 30; const r = b.step(1 / 30); if (!r) break; win.x = r.x; win.y = r.y; if (r.arrived) break; }
assert.ok(Math.abs(win.x - (1200 - win.w / 2)) < 2, 'arrived at cursor x'); assert.equal(b.mode, 'idle');

// peek hides to nearest edge leaving 28% visible; unpeek returns fully on screen
b.peek(); for (let i = 0; i < 400; i++) { clock += 1 / 30; const r = b.step(1 / 30); if (!r) break; win.x = r.x; win.y = r.y; if (r.arrived) break; }
assert.ok(win.x + win.w * 0.28 > mon.w - 1, 'peeking from right edge'); assert.equal(b.mode, 'peek');
b.unpeek(); for (let i = 0; i < 400; i++) { clock += 1 / 30; const r = b.step(1 / 30); if (!r) break; win.x = r.x; win.y = r.y; if (r.arrived) break; }
assert.ok(win.x + win.w <= mon.w, 'back on screen');

// edge cling after drag then climb back
win.x = mon.w - win.w * 0.5; assert.ok(b.checkEdgeAfterDrag()); assert.equal(b.mode, 'cling');
clock += 5; b.step(1 / 30); assert.equal(b.mode, 'walk');

// battery + greeting throttles
b.onBattery({ percent: 15, charging: false }); const n = said.length; b.onBattery({ percent: 15, charging: false }); assert.equal(said.length, n, 'low battery once per 15 min');
b.onOtherPet('x', { x: win.x + 10, w: 300 }, 'Bo'); assert.ok(said.at(-1).includes('Bo'));
console.log('behaviors tests passed');
