// 0.9.6 stroking is HOVER-driven: the bare cursor sweeping back and forth over opaque pet pixels, no button held.
// Reversals with >= 20 px travel on both legs count; 3 -> light, 10 -> medium, 15 -> heart, each once per round.
// Ctrl, sleep, a mouse button, a drag, the window hiding, or > 1.2 s off the pixels end the round.
// (0.9.4 required the left button down. At 33 ms + 3 IPC round trips the first sample after mousedown is already
//  > 10 px from the press point, so main.js' arbitration read every stroke as "picked up" — petting was unreachable.)
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
globalThis.performance = { now: () => 0 };
for (const f of ['i18n', 'behaviors']) new Function(readFileSync(new URL(`../src/${f}.js`, import.meta.url), 'utf8'))();
const { StrokeTracker } = globalThis;

/** Hover-sweep over the pet: enter at x=100 and make `n` reversals with legs of `leg` px, sampled every 5 px like the
 *  33 ms poll. `over` / `ctrl` mimic what poll() passes. Returns the tiers fired in order. */
function stroke(n, leg = 30, opts = {}) {
  const tr = opts.tracker || new StrokeTracker({ minTravel: 20, graceSec: 1.2 }); const fired = []; let t = opts.t0 || 0, x = 100;
  if (!opts.resume) tr.press(x, t);
  const sampleTo = (target) => { const step = Math.sign(target - x) * 5; while (x !== target) { x = Math.abs(target - x) <= 5 ? target : x + step; t += 0.02; const ev = tr.move(x, t, true, !!opts.ctrl); if (ev) fired.push(ev); } };
  sampleTo(x + leg);                                     // the first leg sets the direction
  for (let i = 0; i < n; i++) sampleTo(x + (i % 2 ? leg : -leg));
  return { fired, tr, count: tr.count, t };
}
// (1)-(7) the three tiers, each once per round
assert.deepEqual(stroke(2).fired, [], '(1) 2 reversals: nothing');
assert.deepEqual(stroke(3).fired, ['light'], '(2) 3: the light tier once');
assert.deepEqual(stroke(9).fired, ['light'], '(3) 9: no medium yet');
assert.deepEqual(stroke(10).fired, ['light', 'medium'], '(4) 10: medium once');
assert.deepEqual(stroke(14).fired, ['light', 'medium'], '(5) 14: no heart yet');
assert.deepEqual(stroke(15).fired, ['light', 'medium', 'heart'], '(6) 15: the heart once');
assert.deepEqual(stroke(30).fired, ['light', 'medium', 'heart'], '(7) 30: still once each; the round locks after the heart');
assert.equal(stroke(30).count, 30, 'reversals keep being counted after the heart');
// (8) jitter below 20 px is never a reversal; exactly 20 px is
assert.equal(stroke(40, 10).count, 0, '(8) 10 px wobbles are not reversals');
assert.equal(stroke(40, 19).count, 0, '(8) 19 px: still noise');
assert.equal(stroke(5, 20).count, 5, 'exactly 20 px legs count');
assert.equal(stroke(5, 120).count, 5, 'long legs count once each, however many samples they take');
// (9) Ctrl belongs to the whip: nothing counts while it is held, and the round is gone
{ const tr = new StrokeTracker({ minTravel: 20, graceSec: 1.2 }); tr.press(100, 0); let x = 100, t = 0, fired = 0;
  for (let i = 0; i < 40; i++) { x += (i % 2 ? 30 : -30); t += 0.1; if (tr.move(x, t, true, true)) fired++; }
  assert.equal(fired, 0, '(9) no tier while Ctrl is held'); assert.equal(tr.active, false, 'Ctrl ended the round'); assert.equal(tr.count, 0, 'and cleared the count'); }
// (10) leaving the pet: a short gap across transparent pixels is forgiven, more than 1.2 s ends the round and the next
// visit counts from zero
{ const tr = new StrokeTracker({ minTravel: 20, graceSec: 1.2 }); tr.press(100, 0); let t = 0;
  tr.move(130, t += 0.1, true, false); tr.move(100, t += 0.1, false, false); tr.move(130, t += 0.5, false, false);
  assert.equal(tr.active, true, '0.6 s off the pet: still the same round');
  tr.move(100, t += 0.2, true, false); assert.equal(tr.count, 3, 'back on the pet, the turns counted');
  tr.move(130, t += 1.3, false, false); assert.equal(tr.active, false, '(10) > 1.2 s away ends it');
  const again = stroke(3, 30, { tracker: tr }); assert.deepEqual(again.fired, ['light'], 'coming back starts a new round'); assert.equal(again.count, 3, 'counting from zero'); }
// a drag start (main.js calls end()) wipes the round
{ const s = stroke(5); assert.equal(s.tr.end(), 5, 'end() reports the count for the log line'); assert.equal(s.tr.active, false); assert.equal(s.tr.count, 0); }

// ---------- main.js wiring: hover feeds the tracker, the button only ever drags ----------
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
assert.ok(/graceSec: 1\.2/.test(main), 'the host grace window is 1.2 s');
// the samples come from the hit-test branch of poll(), guarded by !dragging / !ctrlHeld / not asleep
assert.ok(main.includes('if (!dragging && !ctrlHeld && !asleep && !catchGame)') && main.includes("const asleep = !!(care && care.s.sleeping)"), 'hover stroking is gated on no button, no Ctrl, awake, not mid-game');
// chasing the dot sweeps the cursor over the pet exactly like a stroke: no hearts / growth for playing, and the
// game's own hit reaction keeps the face to itself
assert.ok(main.includes("endStroke(ctrlHeld ? 'ctrl' : catchGame ? 'game' : 'sleep')"), 'a round in progress ends when the catch game starts');
assert.ok(main.includes('if (overPet && !strokeTracker.active) { strokeTracker.press(lx, t)') && main.includes('strokeTracker.move(lx, t, overPet, false)'), 'first hover sample opens a round, every sample feeds it with the real `over`');
assert.ok(main.includes('if (tier) { appendLog(`stroke-tier ${tier} count=${strokeTracker.count}`); strokeTier(tier); }'), 'a tier logs and fires');
// NO press-and-hold stroking anywhere: mousedown ends the round, the drag threshold is the plain 10 px one
assert.ok(!/strokeTracker\.press\(e\.clientX/.test(main), 'mousedown no longer opens a stroke round');
assert.ok(main.includes("endStroke('press')"), 'mousedown ends the round instead');
assert.ok(!/becomesDrag/.test(main) && !/legTravel\(\) > 140/.test(main) && !/Math\.hypot\(ddx, ddy\) > 48/.test(main), 'the 0.9.4 stroke-vs-drag arbitration is gone');
assert.ok(main.includes("if (Math.hypot(ddx, ddy) > 10) { dragMoved = true; appendLog('drag-start'); }"), 'a drag is simply > 10 px from the press point');
assert.ok(!/stroke\.xs/.test(main), 'the pre-0.9.4 instant-heart hover stroke is gone too');
// all five diagnostic lines a user can self-check in kapi-debug.log within a minute
for (const line of ["appendLog('stroke-start')", 'stroke-tier ${tier} count=', 'stroke-end ${why} count=', "appendLog('drag-start')", "appendLog('click')"])
  assert.ok(main.includes(line), 'diagnostic log: ' + line);
for (const why of ['press', 'ctrl', 'sleep', 'hidden', 'away']) assert.ok(new RegExp(`'${why}'|stroke-end ${why}`).test(main), 'stroke-end reason: ' + why);
// the log must stay readable: the cursor crosses the pet constantly and appendLog rewrites the whole 120-line file,
// so a start is throttled (like 0.9.4's idle-skipped) and a round that counted nothing gets no end line
assert.ok(main.includes('if (now - strokeStartLoggedAt < 2000) return;'), 'stroke-start is throttled to one line per 2 s');
assert.ok(main.includes('if (n) appendLog(`stroke-end ${why} count=${n}`);') && main.includes('!strokeTracker.active && before'), 'a pass-through round (count 0) logs no end line');
assert.ok(main.includes("care.can('pet')") && main.includes("fxQueue.request((m && m.effect) || 'hearts'"), 'inside the 2-minute pet cooldown the heart stays visual only');
// the tiers themselves did not move
{ const beh = readFileSync(new URL('../src/behaviors.js', import.meta.url), 'utf8');
  assert.ok(beh.includes('{ light: 3, medium: 10, heart: 15 }'), 'tiers unchanged'); }

// pressing the button means NO tier can fire any more: poll() returns from the drag branch before the hit test, and
// the round was already ended at mousedown. Mirrored here: once end() has run, replaying the whole sweep fires nothing.
{ const tr = new StrokeTracker({ minTravel: 20, graceSec: 1.2 }); tr.press(100, 0); tr.end();        // mousedown
  let x = 100, t = 0, fired = 0;
  for (let i = 0; i < 60; i++) { x += (i % 2 ? 30 : -30); t += 0.03; if (tr.move(x, t, true, false)) fired++; }
  assert.equal(fired, 0, 'no tier fires while the button is down'); assert.equal(tr.active, false, 'and no round is silently running'); }
console.log('stroke-tiers tests passed');
