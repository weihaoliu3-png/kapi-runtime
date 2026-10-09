import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
globalThis.performance = { now: () => clock * 1000 }; let clock = 0;
globalThis.PET_PRIORITY = { random: 20 };
new Function(readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8'))();
new Function(readFileSync(new URL('../src/behaviors.js', import.meta.url), 'utf8'))();
const { Behaviors, I18N } = globalThis;
const said = [], played = [], exprs = [];
const win = { x: 500, y: 400, w: 360, h: 480 }, mon = { x: 0, y: 0, w: 1920, h: 1080 };
const engine = { hover: false, sleeping: false, state: { action: 'idle' }, m: { actions: { nod: {}, wave: {} } }, play: (id) => played.push(id) };
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
// follow mode: approaches the cursor, stops near it, faces direction
{ const w2 = { x: 100, y: 100, w: 360, h: 480 }; let cur = { x: 900, y: 500 };
  const b2 = new Behaviors({ getWin: () => w2, getMonitor: () => mon, getCursor: () => cur, engine: { hover: false, sleeping: false, state: { action: 'idle' } }, say: () => {}, expr: () => {}, play: () => {}, line: () => null, t: () => I18N.pick('en') });
  b2.setFollow(true);
  for (let i = 0; i < 300; i++) { const r = b2.step(1 / 30); if (!r) break; w2.x = r.x; w2.y = r.y; }
  assert.ok(Math.abs(w2.x - 940) < 30 && Math.abs(w2.y - (500 - 480 * 0.35)) < 30, 'settled below-right of cursor'); assert.equal(b2.flip, false);
  cur = { x: 200, y: 300 }; const r = b2.step(1 / 30); assert.ok(r && r.flip === true, 'faces left when cursor moves left');
  b2.setFollow(false); assert.equal(b2.step(1 / 30), null, 'no motion after unfollow'); console.log('follow ok'); }
// perch: normal window -> feet on its top edge at the right corner; maximised window -> inside the corner, never off-screen; hint when no window
{ const w3 = { x: 100, y: 600, w: 360, h: 480 }; const said3 = [];
  const b3 = new Behaviors({ getWin: () => w3, getMonitor: () => mon, getCursor: () => null, engine: { hover: false, sleeping: false, state: { action: 'idle' } }, say: (x) => said3.push(x), expr: () => {}, play: () => {}, line: () => null, t: () => I18N.pick('en') });
  const footY = 420, petW = 360;
  b3.setPerch(true); assert.equal(b3.mode, 'perch'); assert.ok(said3.at(-1).includes('view'));
  assert.ok(b3.perchOn({ x: 400, y: 500, w: 900, h: 500 }, footY, petW), 'target set');
  for (let i = 0; i < 600; i++) { clock += 1 / 30; const r = b3.step(1 / 30); if (!r) break; w3.x = r.x; w3.y = r.y; if (r.arrived) break; }
  assert.equal(w3.y, 500 - footY, 'feet on the window top edge'); assert.equal(w3.x, 400 + 900 - petW - 24, 'right corner'); assert.equal(b3.mode, 'perch');
  assert.equal(b3.perchOn({ x: 400, y: 500, w: 900, h: 500 }, footY, petW), false, 'same window is not re-targeted');
  assert.ok(b3.perchOn({ x: -8, y: -8, w: 1936, h: 1096 }, footY, petW), 'maximised window');
  for (let i = 0; i < 600; i++) { clock += 1 / 30; const r = b3.step(1 / 30); if (!r) break; w3.x = r.x; w3.y = r.y; if (r.arrived) break; }
  assert.equal(w3.y, mon.y, 'sits inside the top edge instead of above the screen'); assert.ok(w3.x + petW <= mon.x + mon.w && w3.x >= mon.x, 'x on screen');
  const b4 = new Behaviors({ getWin: () => w3, getMonitor: () => mon, getCursor: () => null, engine: { hover: false, sleeping: false, state: { action: 'idle' } }, say: (x) => said3.push(x), expr: () => {}, play: () => {}, line: () => null, t: () => I18N.pick('en') });
  b4.setPerch(true); const n4 = said3.length; b4.perchNoWindow(); assert.equal(said3.length, n4, 'no hint yet');
  clock += 3.5; b4.perchNoWindow(); assert.ok(said3.at(-1).includes('Click the window'), 'hint after 3s'); b4.perchNoWindow(); assert.equal(said3.length, n4 + 1, 'hint only once');
  b4.setPerch(false); assert.equal(b4.mode, 'idle'); console.log('perch ok'); }

// typing: a pet without a `typing` action nods; throttled to one nod per 1.5s
{ const played2 = []; const eng2 = { hover: false, sleeping: false, state: { action: 'idle' }, m: { actions: { nod: {} } }, play: (id) => { played2.push(id); return true; } };
  const b5 = new Behaviors({ getWin: () => win, getMonitor: () => mon, getCursor: () => null, engine: eng2, say: () => {}, expr: () => {}, play: () => {}, line: () => null, t: () => I18N.pick('en') });
  clock += 10; b5.onTyping(1); b5.onTyping(1); assert.deepEqual(played2, ['nod'], 'one detected key triggers a nod via fallback');
  clock += 2; b5.onTyping(1); assert.equal(played2.length, 2, 'nods again after the throttle');
  eng2.m.actions.typing = {}; clock += 2; b5.onTyping(4); assert.equal(played2.at(-1), 'typing', 'uses the dedicated action when present');
  eng2.sleeping = true; clock += 2; b5.onTyping(3); assert.equal(played2.length, 3, 'does not nod while asleep');
  console.log('typing ok'); }

// Two consecutive fast typing seconds trigger an extra reaction without recording any typed characters.
{ const reactions = [], speech = [];
  const eng = { hover: false, sleeping: false, state: { action: 'idle' }, m: { actions: {} }, play: () => true };
  const b = new Behaviors({ getWin: () => win, getMonitor: () => mon, getCursor: () => null, engine: eng,
    say: x => speech.push(x), expr: x => reactions.push(x), play: x => reactions.push(x), line: k => k === 'typingFast' ? '快打！' : null, t: () => I18N.pick('en') });
  clock += 2; b.onTyping(7); clock += 1; b.onTyping(7);
  assert.ok(reactions.includes('shake') && reactions.includes('surprised'));
  assert.deepEqual(speech, ['快打！']);
  clock += 3; b.onTyping(0); clock += 1; b.onTyping(7);
  assert.equal(speech.length, 1, 'pause resets fast streak');
  console.log('fast typing reaction ok'); }
