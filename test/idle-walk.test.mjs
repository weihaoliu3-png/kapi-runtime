// 0.9.4: idle life + real strolls are built in (an empty triggers.idleRandom changes nothing), a walk moves the window
// (coordinates change continuously, not just engine.state.action === 'walk'), a cycle action is never played on the spot,
// and a missing monitor rect is survived and logged once a minute instead of silently freezing the pet.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
let clock = 1000; globalThis.performance = { now: () => clock * 1000 };
for (const f of ['i18n', 'engine', 'behaviors']) new Function(readFileSync(new URL(`../src/${f}.js`, import.meta.url), 'utf8'))();
const { PetEngine, Behaviors, I18N, PET_PRIORITY } = globalThis;

const img = (n) => ({ name: n });
function makeManifest(idleRandom) {
  return {
    schema: 2, render: { canvas: [512, 640], anchor: [256, 620] }, source: { cropped: false }, lookFollow: { mode: 'frames8', deadzonePx: 60 },
    actions: {
      idle: { type: 'procedural', preset: 'breathe' }, drag: { type: 'procedural', preset: 'sway' }, drop: { type: 'procedural', preset: 'bounce' }, nod: { type: 'procedural', preset: 'nod' },
      wave: { type: 'frames', dir: 'actions/wave', frames: 4, fps: 5, sequence: [0, 1, 2, 3], loops: 1 },
      walk: { type: 'frames', dir: 'actions/walk', frames: 4, fps: 8, sequence: [0, 1, 2, 3, 0, 1, 2, 3], loops: -1, cycle: true },
    },
    triggers: { click: { action: 'nod' }, idleRandom, idleRandomEverySec: [5, 10] },
  };
}
const images = { base: img('base'), blink: null, look: Object.fromEntries(['d000', 'd045', 'd090', 'd135', 'd180', 'd225', 'd270', 'd315'].map(d => [d, img(d)])),
  actions: { wave: [0, 1, 2, 3].map(i => img('wave' + i)), walk: [0, 1, 2, 3].map(i => img('walk' + i)) } };

function harness(idleRandom, monitor) {
  const logs = [];
  const e = new PetEngine({ manifest: makeManifest(idleRandom), persona: {}, images }, { now: () => clock, onLog: (l) => logs.push(l) });
  e.drag = e.drag || { active: false };
  const win = { x: 700, y: 500, w: 360, h: 480 };
  let mon = monitor === undefined ? { x: 0, y: 0, w: 1920, h: 1040 } : monitor;
  const b = new Behaviors({ getWin: () => win, getMonitor: () => mon, getCursor: () => ({ x: 1800, y: 100 }), engine: e,
    say: () => {}, expr: () => {}, play: (id) => e.play(id), line: () => null, t: () => I18N.pick('en'), mood: () => 80, busy: () => false, busyWhy: () => null, log: (l) => logs.push(l) });
  const acts = []; const orig = b.lifeAct.bind(b); b.lifeAct = () => { const p = orig(); acts.push(p); return p; };
  const walks = []; let cur = null;
  // one 33 ms tick of main.js' movement loop
  const tick = (dt = 1 / 30) => {
    clock += dt; e.update(); e.setLookVector(1100, -400);               // main.js' 30 Hz poll: the cursor is far away (scripted glances can run)
    const r = b.step(dt);
    if (!r) { if (e.walking) e.setWalking(false); if (cur) { walks.push(cur); cur = null; } return null; }
    const walking = !!r.walking && (b.mode === 'walk' || b.follow);
    e.flip = walking ? e.walkFlip(!!r.flip) : !!r.flip; e.setWalking(walking);
    if (walking) { cur = cur || { xs: [win.x], states: [], flips: [] }; cur.xs.push(r.x); cur.states.push(e.state.action); cur.flips.push(e.flip); }
    win.x = r.x; win.y = r.y;
    if (r.arrived === 'walk') { e.setWalking(false); if (cur) { cur.xs.push(r.x); walks.push(cur); cur = null; } }
    return r;
  };
  return { e, b, win, mon, logs, acts, walks, tick, setMon: (m) => { mon = m; } };
}

// ---- 10 simulated minutes with an EMPTY idleRandom: life acts and at least one stroll that really moves the window ----
{ const H = harness([]);
  for (let i = 0; i < 30 * 60 * 10; i++) H.tick();
  assert.ok(H.acts.length >= 8, 'built-in life acts happen with an empty idleRandom: ' + H.acts.length);
  assert.ok(H.walks.length >= 1, 'at least one stroll in 10 minutes: ' + H.walks.length);
  for (const w of H.walks) {
    const xs = w.xs; assert.ok(xs.length >= 10, 'a stroll lasts many ticks');
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] !== xs[i - 1], 'x changes on every tick of a walk');
    const dir = Math.sign(xs[1] - xs[0]); for (let i = 2; i < xs.length; i++) assert.equal(Math.sign(xs[i] - xs[i - 1]), dir, 'monotonic: no back-and-forth on the spot');
    assert.ok(Math.abs(xs.at(-1) - xs[0]) >= H.win.w - 1, `a real walker goes at least one window width (${Math.round(Math.abs(xs.at(-1) - xs[0]))} px)`);
    assert.ok(w.states.every(s => s === 'walk'), 'the walk cycle plays while the window moves');
    assert.ok(w.flips.every(f => f === (dir < 0)), 'facing right by default: mirrored only when moving left');
    for (const x of xs) assert.ok(x >= H.mon.x + 8 - 1 && x + H.win.w <= H.mon.x + H.mon.w - 8 + 1, 'never outside the work area minus the 8 px margin: ' + x);
  }
  assert.ok(H.win.y + H.win.h <= H.mon.y + H.mon.h, 'stays above the taskbar (work area bottom)');
  assert.equal(H.e.state.action === 'walk' && H.b.mode !== 'walk', false, 'never a walk animation without the walk state machine');
  assert.ok(H.logs.some(l => /^idle-scheduled \w+ \d+$/.test(l)), 'idle-scheduled <pick> <delaySec> logged');
  assert.ok(H.logs.some(l => /^walk-start -?\d+,-?\d+ -> -?\d+,-?\d+$/.test(l)), 'walk-start <from> -> <to> logged');
  assert.ok(H.logs.some(l => l === 'walk-end arrived'), 'walk-end arrived logged');
  console.log(`idle life + walk ok: ${H.acts.length} acts, ${H.walks.length} strolls`); }

// ---- the same run with idleRandom = [] vs. with a custom pool: built-in life is identical in kind (acts + strolls both present) ----
{ const H = harness([{ action: 'wave', weight: 1 }]);
  for (let i = 0; i < 30 * 60 * 10; i++) H.tick();
  assert.ok(H.acts.length >= 8 && H.walks.length >= 1, 'a custom pool adds to, never replaces, the built-in life');
  console.log('custom pool ok'); }

// ---- `walk` listed in idleRandom (or asked for as a trick) never plays on the spot; refused and logged once ----
{ const H = harness([{ action: 'walk', weight: 100 }]);
  H.b.lifeAt = Infinity; H.b.wanderAt = Infinity;                       // only the engine's own idle-random can act here
  for (let i = 0; i < 30 * 120; i++) { H.tick(); assert.notEqual(H.e.state.action, 'walk', 'walk from idleRandom is ignored'); }
  assert.equal(H.logs.filter(l => l.startsWith('idle-random skipped walk')).length, 1, 'logged exactly once');
  assert.equal(H.e.play('walk', PET_PRIORITY.user), false, 'engine.play(walk) from anyone but the walk state machine is refused');
  assert.equal(H.logs.filter(l => l.startsWith('cycle-refused walk')).length, 1);
  assert.equal(H.e.state.action, 'idle');
  // lifeAct 'learned' never picks the cycle action
  for (let i = 0; i < 300; i++) { H.b.lastLife = ''; const p = H.b.lifeAct(); assert.notEqual(H.e.state.action, 'walk', 'lifeAct ' + p + ' never starts the cycle'); H.e._toIdle(); H.b.mode = 'idle'; H.b.target = null; }
  console.log('cycle guard ok'); }

// ---- facing: a pack whose walk frames face left is mirrored when moving RIGHT ----
{ const H = harness([]); assert.equal(H.e.walkFlip(true), true); assert.equal(H.e.walkFlip(false), false);
  H.e.m.actions.walk.facing = 'left'; assert.equal(H.e.walkFlip(true), false); assert.equal(H.e.walkFlip(false), true);
  console.log('facing ok'); }

// ---- walk interruptions: a stopWalk (click / panel / failed move) ends the cycle at once; sleep ends it on the next step ----
{ const H = harness([]);
  assert.ok(H.b.wander()); H.tick(); assert.equal(H.e.state.action, 'walk');
  assert.ok(H.b.stopWalk('interrupted')); H.tick(); assert.equal(H.b.mode, 'idle'); assert.equal(H.e.state.action, 'idle', 'cycle stops with the walk');
  assert.ok(H.logs.includes('walk-end interrupted'));
  assert.ok(H.b.wander()); H.tick(); H.e.setSleeping(true); H.tick(); assert.equal(H.b.mode, 'idle', 'sleep ends a stroll'); assert.notEqual(H.e.state.action, 'walk');
  console.log('walk interruption ok'); }

// ---- wander targets cover left / centre / right of the work area and avoid repeating the previous region ----
{ const H = harness([]); const regions = []; const lo = H.mon.x + 8, span = H.mon.w - H.win.w - 16;
  for (let i = 0; i < 40; i++) { H.b.wander(); const x = H.b.target.x; regions.push(x < lo + span / 3 ? 'L' : x < lo + 2 * span / 3 ? 'C' : 'R'); H.win.x = x; H.b.mode = 'idle'; H.b.target = null; }
  assert.deepEqual([...new Set(regions)].sort(), ['C', 'L', 'R'], 'all three regions are visited: ' + regions.join(''));
  for (let i = 1; i < regions.length; i++) assert.notEqual(regions[i], regions[i - 1], 'no immediate region repeat');
  console.log('wander regions ok'); }

// ---- no monitor rect: step() returns null, nothing crashes, "idle-skipped norect" is logged once per minute ----
{ const H = harness([], null);
  for (let i = 0; i < 30 * 90; i++) assert.equal(H.tick(), null, 'no motion without a monitor');
  assert.equal(H.logs.filter(l => l === 'idle-skipped norect').length, 2, 'once per minute over 90 s: ' + H.logs.filter(l => l === 'idle-skipped norect').length);
  assert.equal(H.acts.length, 0); assert.equal(H.e.state.action, 'idle');
  H.setMon({ x: 0, y: 0, w: 1920, h: 1040 }); let moved = false;        // the monitor appears later (the fallback chain found one): life resumes
  for (let i = 0; i < 30 * 60 * 5; i++) { const r = H.tick(); if (r) moved = true; }
  assert.ok(H.acts.length > 0 && moved, 'life resumes once a rect exists');
  console.log('norect ok'); }

// ---- idle-skipped reasons name what blocked the act ----
{ const H = harness([]); H.b.wanderAt = Infinity;
  H.e.hover = true; for (let i = 0; i < 30 * 100; i++) H.tick(); assert.ok(H.logs.some(l => l === 'idle-skipped hover'), 'hover'); H.e.hover = false;
  H.e.setSleeping(true); for (let i = 0; i < 30 * 100; i++) H.tick(); assert.ok(H.logs.some(l => l === 'idle-skipped sleep'), 'sleep'); H.e.setSleeping(false);
  H.b.h.busyWhy = () => 'panel'; for (let i = 0; i < 30 * 100; i++) H.tick(); assert.ok(H.logs.some(l => l === 'idle-skipped panel'), 'panel'); H.b.h.busyWhy = () => null;
  console.log('idle-skipped reasons ok'); }
console.log('idle-walk tests passed');
