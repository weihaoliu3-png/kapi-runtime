// Runs the engine headless with fake images to check the state machine, look-follow and keyframe sequencing.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
globalThis.performance = globalThis.performance || { now: () => Date.now() };
const src = readFileSync(new URL('../src/engine.js', import.meta.url), 'utf8');
new Function(src)(); // defines globalThis.PetEngine
const { PetEngine, PET_PRIORITY } = globalThis;

let clock = 0; const now = () => clock;
const img = (n) => ({ name: n });
const manifest = {
  schema: 2, render: { canvas: [512, 640], anchor: [256, 620] }, source: { cropped: false },
  lookFollow: { mode: 'frames8', deadzonePx: 60, holdMs: 250, crossfadeMs: 120 },
  actions: {
    idle: { type: 'procedural', preset: 'breathe' }, drag: { type: 'procedural', preset: 'sway' }, drop: { type: 'procedural', preset: 'bounce' }, nod: { type: 'procedural', preset: 'nod' },
    wave: { type: 'frames', dir: 'actions/wave', frames: 4, fps: 5, sequence: [0, 1, 2, 3, 2, 3, 1, 0], tweenMs: 120, loops: 1 },
    sleep: { type: 'frames', dir: 'actions/sleep', frames: 4, fps: 2, sequence: [0, 1, 2, 3], holdLast: true, wake: [3, 2, 1, 0], loops: 1 },
  },
  triggers: { click: { action: 'nod', say: 'click' }, dragStart: { action: 'drag', say: 'dragStart' }, dragEnd: { action: 'drop', say: 'dragEnd' },
    idleRandom: [{ action: 'wave', weight: 1, cooldownSec: 0 }], idleRandomEverySec: [1, 1], afterIdleMin: { minutes: 1, action: 'sleep' } },
};
const persona = { lines: { click: ['嗯？'], dragStart: ['喂'], dragEnd: ['哼'] } };
const images = { base: img('base'), blink: img('blink'), look: Object.fromEntries(['d000','d045','d090','d135','d180','d225','d270','d315'].map(d => [d, img(d)])),
  actions: { wave: [0,1,2,3].map(i => img('wave' + i)), sleep: [0,1,2,3].map(i => img('sleep' + i)) } };
const said = [];
const e = new PetEngine({ manifest, persona, images }, { now, onSay: (t) => said.push(t) });
e.hover = true; // suppress idle-random while testing deterministic paths

// look-follow: cursor to the screen-right -> d090
e.setLookVector(300, 0); assert.equal(e.look.current, 'd090');
// a cursor that jumped two sectors is followed one neighbour per hold, never skipping a direction frame
clock += 0.3; e.setLookVector(0, -300); assert.equal(e.look.current, 'd045', 'right -> up goes through d045 first');
clock += 0.3; e.setLookVector(0, -300); assert.equal(e.look.current, 'd000', 'then d000');
clock += 0.3; e.setLookVector(0, -300); assert.equal(e.look.current, 'd000', 'arrived: stays');
// up -> down-left: the short way round is d315, d270, d225 (3 holds), not through d090
clock += 0.3; e.setLookVector(-300, 300); assert.equal(e.look.current, 'd315');
clock += 0.3; e.setLookVector(-300, 300); assert.equal(e.look.current, 'd270');
clock += 0.3; e.setLookVector(-300, 300); assert.equal(e.look.current, 'd225', 'down-left = d225');
clock += 0.3; e.setLookVector(10, 10); assert.equal(e.look.current, 'base', 'deadzone -> base (direct)');
// 0.8.10: while a look frame is on screen, neither a blink nor an expression cuts to the idle front (that was the
// "jumps back to the default picture" of the v5 retro); both show as soon as the cursor is back in the deadzone
clock += 0.3; e.setLookVector(300, 0); assert.equal(e.look.current, 'd090');
e.blink.until = clock + 1; e.showExpression('happy', 5000);
assert.equal(e._currentImage().name, 'd090', 'look frame wins over blink + expression while following');
clock += 0.3; e.setLookVector(0, 0); assert.equal(e.look.current, 'base');
assert.equal(e._currentImage().name, 'blink', 'back on base: the pending blink shows now (no expression image in this fixture)');
e.blink.until = 0; assert.equal(e._currentImage().name, 'base');
e.blink = { until: 0, next: clock }; e.update(); // blink schedules only on base
assert.ok(e.blink.until > clock, 'blink fires on base');
clock += 0.5; e.setLookVector(300, 0); e.blink = { until: 0, next: clock }; e.update();
assert.equal(e.blink.until, 0, 'blink is skipped (rescheduled) while looking');
e.blink = { until: 0, next: clock + 3 + 4 }; e.setLookVector(0, 0); clock += 0.3; e.setLookVector(0, 0);
// hold: rapid change within holdMs is ignored
clock += 0.3; e.setLookVector(300, 0); clock += 0.05; e.setLookVector(-300, 0); assert.equal(e.look.current, 'd090');

// click -> nod + line
clock += 1; e.click(0.3); assert.equal(e.state.action, 'nod'); assert.equal(said.at(-1), '嗯？');
for (let i = 0; i < 60; i++) { clock += 0.05; e.update(); }
assert.equal(e.state.action, 'idle', 'nod finishes');

// A package without a custom typing animation gets a visible two-beat nod.
assert.equal(e.m.actions.typing.preset, 'typing');
e.play('typing'); clock += 0.175;
assert.ok(e.frame().dy >= 13, 'typing nod moves far enough to be visible after display scaling');
for (let i = 0; i < 20; i++) { clock += 0.05; e.update(); }
assert.equal(e.state.action, 'idle', 'typing nod finishes');

// wave sequence walks all 8 steps then returns to idle
e.play('wave'); const seen = [];
for (let i = 0; i < 60; i++) { clock += 0.1; e.update(); const f = e.frame(); seen.push(f.layers.at(-1).img.name); if (e.state.action === 'idle') break; }
assert.deepEqual([...new Set(seen)].filter(n => n.startsWith('wave')), ['wave0', 'wave1', 'wave2', 'wave3']);
assert.equal(e.state.action, 'idle');

// drag has top priority and blocks random
e.dragStart(); assert.equal(e.state.action, 'drag'); assert.equal(said.at(-1), '喂');
clock += 5; e.update(); assert.equal(e.state.action, 'drag', 'random cannot interrupt drag');
e.dragEnd(); assert.equal(e.state.action, 'drop');
for (let i = 0; i < 30; i++) { clock += 0.05; e.update(); }
assert.equal(e.state.action, 'idle');

// afterIdleMin -> sleep with holdLast, then click wakes via wake sequence
clock += 61; e.hover = false; e.update(); assert.equal(e.state.action, 'sleep');
for (let i = 0; i < 40; i++) { clock += 0.6; e.update(); }
assert.equal(e.state.action, 'sleep', 'holdLast keeps sleeping'); assert.equal(e.frame().layers.at(-1).img.name, 'sleep3');
e.click(0.3); assert.equal(e.state.waking, true); e.hover = true;
for (let i = 0; i < 20; i++) { clock += 0.6; e.update(); }
assert.equal(e.state.action, 'idle', 'wake sequence returns to idle');

// crossfade produces two layers right after a look change
clock += 1; e.setLookVector(0, 0); clock += 0.3; e.setLookVector(300, 0); clock += 0.03; const f = e.frame();
assert.equal(f.layers.length, 2, 'crossfade layers'); assert.ok(f.layers[0].alpha === 1 && f.layers[1].alpha < 1, 'old frame opaque, new fades in');
console.log('engine tests passed');
// keyframe tween persists across several render frames
{ let clock2 = 1000; const e2 = new PetEngine({ manifest, persona, images }, { now: () => clock2 }); e2.hover = true;
  e2.play('wave'); e2.frame(); clock2 += 0.2; e2.update(); e2.frame(); // step to key 1 at fps 5
  clock2 += 0.03; const a = e2.frame(); clock2 += 0.03; const b = e2.frame(); clock2 += 0.2; const c = e2.frame();
  assert.equal(a.layers.length, 2); assert.equal(b.layers.length, 2); assert.ok(b.layers[1].alpha > a.layers[1].alpha && a.layers[0].alpha === 1);
  console.log('tween ok, expired layers =', c.layers.length); }
// care fallbacks: eat overlay moves toward the mouth then finishes; sleeping slumps and shows z's
{ let c3 = 5000; const m3 = JSON.parse(JSON.stringify(manifest)); delete m3.actions.sleep; delete m3.triggers.afterIdleMin;
  const e3 = new PetEngine({ manifest: m3, persona, images }, { now: () => c3 }); e3.hover = true;
  e3.m.actions.eat = { type: 'procedural', preset: 'eat' }; e3.play('eat'); c3 += 0.2; let f = e3.frame(); assert.ok(f.overlay && f.overlay.icon === '🍙' && f.overlay.at < 0.5);
  for (let i = 0; i < 40; i++) { c3 += 0.1; e3.update(); } assert.equal(e3.state.action, 'idle', 'eat finishes');
  e3.setSleeping(true); assert.equal(e3.state.action, 'slump'); c3 += 1; f = e3.frame(); assert.ok(f.zzz && f.dy > 10, 'slumped with z');
  c3 += 100; e3.update(); assert.equal(e3.state.action, 'slump', 'stays asleep'); e3.setSleeping(false); assert.equal(e3.state.action, 'idle'); console.log('care fallback anims ok'); }
// ring mode: continuous index follows the angle, short crossfades, deadzone -> base
{ let c4 = 9000; const m4 = JSON.parse(JSON.stringify(manifest)); m4.lookFollow = { mode: 'ring', ringFrames: 48, deadzonePx: 60, crossfadeMs: 90, holdMs: 60 };
  const img4 = { ...images, ring: Array.from({ length: 48 }, (_, i) => img('r' + i)) };
  const e4 = new PetEngine({ manifest: m4, persona, images: img4 }, { now: () => c4 }); e4.hover = true;
  e4.setLookVector(0, -300); assert.equal(e4.look.current, 'r0', 'up = frame 0');
  for (let k = 0; k < 40; k++) { c4 += 0.1; e4.setLookVector(300, 0); } assert.equal(e4.look.current, 'r12', 'right = frame 12 after smoothing');
  c4 += 0.1; e4.setLookVector(5, 5); assert.equal(e4.look.current, 'base', 'deadzone');
  c4 += 0.03; const f4 = e4.frame(); assert.equal(f4.layers.length, 2, 'short crossfade into base'); console.log('ring ok'); }
