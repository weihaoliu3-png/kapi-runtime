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


// 0.8.12: when the host provides onReact, triggers / stroke / clickMany go through it (reaction first, line sometimes) instead of sayFrom
{ const reacts = []; const e2 = new PetEngine({ manifest, persona, images }, { now, onSay: () => {}, onReact: (ev, key) => reacts.push(ev + ':' + key) });
  e2.hover = true; e2.click(0.3); e2.stroke(); e2.dragStart(); e2.dragEnd();
  assert.deepEqual(reacts, ['click:click', 'stroke:pet', 'dragStart:dragStart', 'dragEnd:dragEnd'], 'onReact receives the event and its line key');
  console.log('onReact routing ok'); }

// 0.8.13 drag physics: hanging from the grab point, swing stays within +-16 deg, three hard reversals -> dizzy -> stagger on release
{ const events = []; const e3 = new PetEngine({ manifest, persona, images }, { now, onSay: () => {}, onEvent: (ev) => events.push(ev) });
  e3.dragStart({ x: 256, y: 60 });
  assert.ok(e3.drag.active && e3.frame().pivot && e3.frame().pivot.x === 256, 'dragged frame rotates about the grab point');
  let maxAng = 0;
  for (let i = 0; i < 120; i++) { clock += 0.02; e3.dragMove(i % 10 < 5 ? 1500 : -1500, 0, 30000, 0); e3.update(); maxAng = Math.max(maxAng, Math.abs(e3.drag.ang)); }
  assert.ok(maxAng > 0.05 && maxAng <= 16 * Math.PI / 180 + 1e-6, `swings (${(maxAng * 180 / Math.PI).toFixed(1)} deg) but never past 16 deg`);
  assert.ok(events.filter(x => x === 'shake').length >= 3 && events.includes('dizzy'), 'hard reversals count as shakes and make it dizzy');
  e3.dragEnd();
  assert.equal(e3.state.action, 'stagger', 'dizzy release -> stagger'); assert.ok(events.includes('dizzyEnd'));
  clock += 2; e3.update(); assert.equal(e3.state.action, 'idle', 'stagger ends by itself');
  assert.equal(e3.frame().pivot, undefined, 'no pivot once released');
  console.log('drag physics ok'); }

// 0.8.15: frames8 crossfade honours the package value (no 220 ms floor) and defaults to 55 ms / holdMs 80
{ let c = 5000; const m = JSON.parse(JSON.stringify(manifest)); m.lookFollow = { mode: 'frames8', deadzonePx: 60, holdMs: 80, crossfadeMs: 55 };
  const ee = new PetEngine({ manifest: m, persona, images }, { now: () => c }); ee.hover = true;
  c += 1; ee.setLookVector(0, 0); c += 0.5; ee.setLookVector(300, 0);
  c += 0.03; assert.equal(ee.frame().layers.length, 2, 'still fading at 30 ms');
  c += 0.05; assert.equal(ee.frame().layers.length, 1, 'fade over by 80 ms (55 ms crossfade, not clamped to 220)');
  c += 1; ee.setLookVector(300, 0); c += 0.5; ee.setLookVector(-300, 0); c += 0.05; ee.setLookVector(-300, 0); assert.equal(ee.look.current, 'd135', 'held 50 ms after the first step (holdMs 80)');
  c += 0.05; ee.setLookVector(-300, 0); assert.equal(ee.look.current, 'd180', 'steps one neighbour once holdMs has passed');
  const m2 = JSON.parse(JSON.stringify(manifest)); m2.lookFollow = { mode: 'frames8', deadzonePx: 60 };
  const e3 = new PetEngine({ manifest: m2, persona, images }, { now: () => c }); e3.hover = true;
  c += 1; e3.setLookVector(0, 0); c += 0.5; e3.setLookVector(300, 0); c += 0.07; assert.equal(e3.frame().layers.length, 1, 'missing crossfadeMs -> 55 ms default');
  console.log('look timing 55/80 ok'); }

// 0.8.16: idle life — built-in procedural moves exist on every pet; a scripted glance drives the look while the cursor is far, the cursor wins when near
{ let c = 9000; const m = JSON.parse(JSON.stringify(manifest)); m.triggers.idleRandomEverySec = [99999, 99999]; const ee = new PetEngine({ manifest: m, persona, images }, { now: () => c });
  for (const id of globalThis.PET_LIFE_PRESETS) assert.equal(m.actions[id].type, 'procedural', id + ' present');
  assert.ok(ee.play('stretch', PET_PRIORITY.random)); for (let i = 0; i < 40; i++) { c += 0.05; ee.update(); } assert.equal(ee.state.action, 'idle', 'stretch finishes');
  assert.ok(ee.lookAlong(['d090', 'base', 'd270', 'base'], 0.6));
  for (let i = 0; i < 3; i++) { c += 0.1; ee.setLookVector(0, 2000); }   // cursor far below: ignored, the script drives
  assert.equal(ee.look.current, 'd090', 'first scripted direction');
  for (let i = 0; i < 40; i++) { c += 0.1; ee.setLookVector(0, 2000); }
  assert.equal(ee.lookScript, null, 'script ends'); assert.equal(ee.look.current, 'd180', 'then the real cursor (far below) applies again');
  ee.lookAlong(['d270', 'base'], 1); c += 0.2; ee.setLookVector(120, 0);   // cursor near: script cancelled, real direction
  assert.equal(ee.lookScript, null, 'cursor wins'); c += 0.3; ee.setLookVector(120, 0); assert.equal(ee.look.current, 'd090');
  console.log('idle life ok'); }

// 0.9.2: a real walk cycle (actions.walk frames, cycle: true) loops while walking and stops at arrival; without one nothing plays
{ let c = 20000; const m = JSON.parse(JSON.stringify(manifest)); m.triggers.idleRandomEverySec = [99999, 99999];
  m.actions.walk = { type: 'frames', dir: 'actions/walk', frames: 6, fps: 12, sequence: [0, 1, 2, 3, 4, 5], loops: -1, cycle: true };
  const im = { ...images, actions: { ...images.actions, walk: Array.from({ length: 6 }, (_, i) => img('walk' + i)) } };
  const ee = new PetEngine({ manifest: m, persona, images: im }, { now: () => c });
  assert.ok(ee.hasWalkCycle());
  ee.setWalking(true); assert.equal(ee.state.action, 'walk', 'walk frames play while walking');
  for (let i = 0; i < 40; i++) { c += 0.1; ee.update(); } assert.equal(ee.state.action, 'walk', 'keeps looping (4 s > one 0.5 s cycle)');
  ee.setWalking(false); assert.equal(ee.state.action, 'idle', 'stops at arrival');
  const m2 = JSON.parse(JSON.stringify(manifest)); const e2 = new PetEngine({ manifest: m2, persona, images }, { now: () => c });
  assert.ok(!e2.hasWalkCycle()); e2.setWalking(true); assert.equal(e2.state.action, 'idle', 'no walk frames: nothing plays');
  console.log('walk cycle ok'); }

// 0.9.4 look-follow switch: off forces the base frame and ignores the cursor + scripted glances; on restores the pack config without a reload
{ let c = 30000; const m = JSON.parse(JSON.stringify(manifest)); m.triggers.idleRandomEverySec = [99999, 99999];
  const ee = new PetEngine({ manifest: m, persona, images }, { now: () => c }); ee.hover = true;
  ee.setLookVector(300, 0); assert.equal(ee.look.current, 'd090');
  ee.setLookEnabled(false); assert.equal(ee.look.current, 'base', 'off: back to base at once'); assert.equal(ee._currentImage().name, 'base');
  c += 1; ee.setLookVector(300, 0); c += 1; ee.setLookVector(-300, 0); assert.equal(ee.look.current, 'base', 'off: the cursor is ignored');
  assert.equal(ee.lookAlong(['d090', 'base'], 1), false, 'off: no scripted glance'); assert.equal(ee.lookScript, null);
  ee.blink = { until: 0, next: c }; ee.update(); assert.ok(ee.blink.until > c, 'blinks still happen'); ee.blink.until = 0;
  ee.img.expressions = { happy: img('happy') }; ee.showExpression('happy', 1000); assert.equal(ee._currentImage().name, 'happy', 'expressions still happen'); ee.expr.until = 0;
  assert.ok(ee.play('wave'), 'actions still play'); ee._toIdle();
  assert.deepEqual(m.lookFollow, manifest.lookFollow, 'the package config is untouched');
  ee.setLookEnabled(true); c += 1; ee.setLookVector(300, 0); assert.equal(ee.look.current, 'd090', 'on: follows again, same config, no reload');
  assert.ok(ee.lookAlong(['d270', 'base'], 1));
  console.log('look toggle ok'); }
