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

// 0.8.15: every interaction sounds — typing nod carries a soft 'typing' reaction (same 1.5 s cadence, never asleep),
// a fast streak a 'surprise', landing a thud + 'drop', edge cling a knock + 'surprise', greeting a 'greet', low battery a 'whine'
{ const snd = [], fx = [];
  const eng = { hover: false, sleeping: false, state: { action: 'idle' }, m: { actions: { nod: {} } }, play: () => true };
  const b = new Behaviors({ getWin: () => win, getMonitor: () => mon, getCursor: () => null, engine: eng, say: () => {}, expr: () => {}, play: () => {},
    line: () => null, t: () => I18N.pick('en'), react: (k, v) => snd.push(k + (v != null ? '@' + v : '')), sfx: (n) => fx.push(n) });
  clock += 10; b.onTyping(1); b.onTyping(1); assert.deepEqual(snd, ['typing@0.28'], 'one soft typing note per nod');
  clock += 2; b.onTyping(1); assert.equal(snd.length, 2, 'again after the throttle');
  eng.sleeping = true; clock += 2; b.onTyping(1); assert.equal(snd.length, 2, 'silent while asleep'); eng.sleeping = false;
  clock += 2; b.onTyping(7); clock += 1; b.onTyping(7); assert.ok(snd.includes('surprise'), 'fast streak startles');
  clock += 1000; b.onBattery({ percent: 10, charging: false }); assert.equal(snd.at(-1), 'whine', 'low battery whines');
  b.onOtherPet('p2', { x: win.x + 10, y: win.y, w: 100, h: 100 }, 'Momo'); assert.equal(snd.at(-1), 'greet', 'greets another pet aloud');
  // throw and land
  b.mode = 'fly'; b.v = { x: 10, y: 0 }; const w = { ...win, y: mon.y + mon.h - win.h }; b.h.getWin = () => w;
  for (let i = 0; i < 200 && b.mode === 'fly'; i++) { const r = b.step(1 / 30); if (r) { w.x = r.x; w.y = r.y; } }
  assert.equal(b.mode, 'idle'); assert.ok(fx.includes('thud') && snd.includes('drop'), 'landing: thud + oof');
  console.log('interaction sounds (behaviors) ok'); }

// 0.8.16 idle life: fires every 15-45 s (scaled by mood), never twice the same act in a row, never while busy / hovering / asleep
{ const played = [], scripts = [];
  const eng = { hover: false, sleeping: false, state: { action: 'idle' }, m: { actions: { nod: {}, wave: { type: 'frames' } } }, drag: { active: false }, lookScript: null,
    play: (id) => { played.push(id); return true; }, lookAlong: (d) => { scripts.push(d); return true; } };
  let busy = false;
  const lw = { ...win };
  const b = new Behaviors({ getWin: () => lw, getMonitor: () => mon, getCursor: () => ({ x: 2000, y: 100 }), engine: eng, say: () => {}, expr: () => {}, play: () => {}, line: () => null,
    t: () => I18N.pick('en'), mood: () => 100, busy: () => busy });
  const acts = []; const orig = b.lifeAct.bind(b); b.lifeAct = () => { const p = orig(); acts.push(p); return p; };
  const tick = () => { clock += 1; const r = b.step(1); if (r) { lw.x = r.x; lw.y = r.y; } };
  for (let i = 0; i < 60 * 40; i++) tick();              // 40 minutes
  assert.ok(acts.length >= 40 && acts.length <= 200, 'about one act every 15-36 s at mood 100: ' + acts.length);
  for (let i = 1; i < acts.length; i++) assert.notEqual(acts[i], acts[i - 1], 'no immediate repeat');
  assert.ok(new Set(acts).size >= 6, 'variety: ' + [...new Set(acts)].join(','));
  busy = true; const n = acts.length; for (let i = 0; i < 600; i++) tick(); assert.equal(acts.length, n, 'quiet while a bubble / panel is open');
  busy = false; eng.sleeping = true; for (let i = 0; i < 600; i++) tick(); assert.equal(acts.length, n, 'quiet while asleep');
  console.log('idle life (behaviors) ok'); }

// 0.8.16 desktop awareness: a click far away -> sometimes a glance; a burst of clicks -> a startle (once per 12 s); nothing while asleep
{ const scripts = [], played = [], ex = [];
  const eng = { hover: false, sleeping: false, state: { action: 'idle' }, m: { actions: {} }, drag: { active: false }, lookScript: null, play: (id) => { played.push(id); return true; }, lookAlong: (d) => { scripts.push(d); return true; } };
  const b = new Behaviors({ getWin: () => win, getMonitor: () => mon, getCursor: () => null, engine: eng, say: () => {}, expr: (n) => ex.push(n), play: () => {}, line: () => null, t: () => I18N.pick('en') });
  clock += 100; assert.equal(b.onDesktopClick('left', win.x + 60, win.y + 300), 'glance', 'a click right next to it: always a look');
  assert.ok(scripts.at(-1)[0].startsWith('d'), 'toward the click');
  clock += 100; let r = b.onDesktopClick('left', win.x + 1500, win.y); clock += 0.2; r = b.onDesktopClick('left', win.x + 1500, win.y) || r; clock += 0.2; r = b.onDesktopClick('left', win.x + 1500, win.y) || r;
  assert.ok(played.includes('shiver') && ex.includes('surprised'), 'triple click = startled');
  clock += 100; eng.sleeping = true; assert.equal(b.onDesktopClick('left', win.x + 60, win.y + 300), null, 'asleep: nothing');
  console.log('desktop clicks ok'); }
