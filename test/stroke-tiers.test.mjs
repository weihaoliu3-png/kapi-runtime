// 0.9.4 three-tier stroking: within one press-and-hold, reversals with >= 20 px travel each count; 3 -> light, 10 -> medium,
// 15 -> heart, each once per round; release / Ctrl / leaving the pet > 1 s / a drag end the round.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
globalThis.performance = { now: () => 0 };
for (const f of ['i18n', 'behaviors']) new Function(readFileSync(new URL(`../src/${f}.js`, import.meta.url), 'utf8'))();
const { StrokeTracker } = globalThis;

/** Press at x=100 and make `n` reversals with legs of `leg` px (sampled every 5 px like a 30 Hz poll); returns the tiers fired in order. */
function stroke(n, leg = 30, opts = {}) {
  const tr = opts.tracker || new StrokeTracker(); const fired = []; let t = 0, x = 100;
  if (!opts.resume) tr.press(x, t);
  const sampleTo = (target) => { const step = Math.sign(target - x) * 5; while (x !== target) { x = Math.abs(target - x) <= 5 ? target : x + step; t += 0.02; const ev = tr.move(x, t, true, false); if (ev) fired.push(ev); } };
  sampleTo(x + leg);                                     // the first leg sets the direction
  for (let i = 0; i < n; i++) sampleTo(x + (i % 2 ? leg : -leg));
  return { fired, tr, count: tr.count };
}
assert.deepEqual(stroke(2).fired, [], '2 reversals: nothing');
assert.deepEqual(stroke(3).fired, ['light'], '3: the light tier once');
assert.deepEqual(stroke(9).fired, ['light'], '9: no medium yet');
assert.deepEqual(stroke(10).fired, ['light', 'medium'], '10: medium once');
assert.deepEqual(stroke(14).fired, ['light', 'medium'], '14: no heart yet');
assert.deepEqual(stroke(15).fired, ['light', 'medium', 'heart'], '15: the heart once');
assert.deepEqual(stroke(30).fired, ['light', 'medium', 'heart'], '30: still once each; the round is locked after the heart');
assert.equal(stroke(30).count, 30, 'reversals keep being counted');
// release and press again: a fresh round counts from zero
{ const s = stroke(15); assert.equal(s.tr.end(), 15); assert.equal(s.tr.active, false);
  const again = stroke(3, 30, { tracker: s.tr }); assert.deepEqual(again.fired, ['light'], 're-press starts a new round'); assert.equal(again.count, 3); }
// jitter below 20 px never counts; a 20 px leg does
assert.equal(stroke(40, 10).count, 0, '10 px wobbles are not reversals');
assert.equal(stroke(40, 19).count, 0, '19 px: still noise');
assert.equal(stroke(5, 20).count, 5, 'exactly 20 px legs count');
assert.equal(stroke(5, 120).count, 5, 'long legs count once each, however many samples they take');
// Ctrl ends the round (the whip owns the cursor) and nothing fires afterwards
{ const tr = new StrokeTracker(); tr.press(100, 0); let x = 100, t = 0, fired = 0;
  for (let i = 0; i < 40; i++) { x += (i % 2 ? 30 : -30); t += 0.1; if (tr.move(x, t, true, true)) fired++; }
  assert.equal(fired, 0); assert.equal(tr.active, false, 'Ctrl ended the round'); }
// leaving the opaque pixels: a short gap is forgiven, more than 1 s ends the round
{ const tr = new StrokeTracker(); tr.press(100, 0); let t = 0;
  tr.move(130, t += 0.1, true, false); tr.move(100, t += 0.1, false, false); tr.move(130, t += 0.5, false, false); assert.equal(tr.active, true, '0.6 s off the pet: still a round');
  tr.move(100, t += 0.2, true, false); assert.equal(tr.count, 3, 'back on the pet, the turns counted');
  tr.move(130, t += 1.2, false, false); assert.equal(tr.active, false, '> 1 s away ends it'); }
// a drag start (host calls end) wipes the round
{ const s = stroke(5); s.tr.end(); assert.equal(s.tr.active, false); assert.equal(s.tr.count, 0); }
// the drag / stroke decision used by main.js: the first sideways leg is given room (48 px) to turn back; a vertical move is a drag at 10 px;
// once stroking, only a long clear move (> 140 px leg or > 70 px vertical) turns into a drag
{ const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.ok(main.includes('Math.hypot(ddx, ddy) > 48') && main.includes('Math.hypot(ddx, ddy) > 10') && main.includes('strokeTracker.legTravel() > 140'), 'drag thresholds as documented');
  assert.ok(main.includes("strokeTracker.press(e.clientX") && main.includes('strokeTracker.end();') && main.includes("if (ctrlHeld) strokeTracker.end()"), 'rounds start on mousedown, end on mouseup / Ctrl');
  assert.ok(main.includes("care.can('pet')") && main.includes("fxQueue.request((m && m.effect) || 'hearts'"), 'inside the 2-minute pet cooldown the heart is visual only');
  assert.ok(!/stroke\.xs/.test(main), 'the old hover stroke (instant heart) is gone'); }
console.log('stroke-tiers tests passed');
