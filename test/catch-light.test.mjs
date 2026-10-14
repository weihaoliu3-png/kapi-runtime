// 0.9.4 catch the light: pet.json.catchLight.durationSec (default 10, 5-60) drives countdown + settlement + target;
// one settlement per round (9.9 s: nothing, 10.0 s: once); the lunge and the "want to learn" prompt follow the species.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
for (const f of ['i18n', 'growth']) new Function(readFileSync(new URL(`../src/${f}.js`, import.meta.url), 'utf8'))();
const { CatchRound, catchLightConfig, GROWTH_DEFS, I18N } = globalThis;

// defaults: 10 s, target 8 (15 points per 20 s, scaled), jump when the pet has nothing better
{ const c = catchLightConfig({ actions: { idle: {} } });
  assert.equal(c.durationSec, 10); assert.equal(c.target, 8); assert.equal(c.action, 'jump'); assert.equal(c.actionSource, 'fallback'); assert.equal(c.learnKey, null, 'unknown species: no learn prompt');
  assert.equal(catchLightConfig({}).durationSec, 10, 'old packs without the field run 10 s'); }
// range + scaling
assert.equal(catchLightConfig({ catchLight: { durationSec: 20 } }).target, 15, '20 s keeps the old 15-point target');
assert.equal(catchLightConfig({ catchLight: { durationSec: 2 } }).durationSec, 5, 'clamped to 5');
assert.equal(catchLightConfig({ catchLight: { durationSec: 999 } }).durationSec, 60, 'clamped to 60');
assert.equal(catchLightConfig({ catchLight: { durationSec: 'abc' } }).durationSec, 10, 'garbage -> default');
assert.equal(catchLightConfig({ catchLight: { durationSec: 7 } }).target, 5, 'round(15*7/20) = 5');

// species-adapted action: package choice > species list > jump; the chosen action must exist
const withActs = (ids, extra) => ({ actions: Object.fromEntries(ids.map(id => [id, { type: 'frames' }])), ...extra });
assert.equal(catchLightConfig(withActs(['pounce', 'peck'], { voice: { species: 'cat' } })).action, 'pounce');
assert.equal(catchLightConfig(withActs(['pounce', 'peck'], { voice: { species: 'bird' } })).action, 'peck');
assert.equal(catchLightConfig(withActs(['hop'], { voice: { species: 'bird' } })).action, 'hop', 'bird: peck > hop > jump');
assert.equal(catchLightConfig(withActs(['chase'], { voice: { species: 'dog-small' } })).action, 'chase', 'dogs: pounce > chase > jump');
assert.equal(catchLightConfig(withActs(['hop', 'pounce'], { voice: { species: 'rabbit' } })).action, 'hop', 'a rabbit hops even when it knows a pounce');
assert.equal(catchLightConfig(withActs(['dash'], { voice: { species: 'rodent' } })).action, 'dash');
assert.equal(catchLightConfig(withActs(['reach', 'pounce'], { voice: { kind: 'tts', preset: 'female' } })).action, 'reach', 'a person reaches, never pounces');
assert.equal(catchLightConfig(withActs(['pounce'], { voice: { species: 'cat' }, catchLight: { action: 'peck' } })).action, 'pounce', 'an explicit action that does not exist is ignored');
assert.equal(catchLightConfig(withActs(['pounce', 'roll'], { voice: { species: 'cat' }, catchLight: { action: 'roll' } })).action, 'roll', 'an explicit existing action wins');
assert.equal(catchLightConfig(withActs(['pounce'], { species: 'dog' })).actionSource, 'species', 'pet.json.species is honoured too');
for (const sp of ['cat', 'kitten', 'dog', 'dog-small', 'dog-large', 'bird', 'rabbit', 'rodent', 'human', 'unknown']) {
  const c = catchLightConfig({ actions: {}, voice: sp === 'human' ? { kind: 'tts' } : sp === 'unknown' ? {} : { species: sp } });
  assert.equal(c.action, 'jump', sp + ' with no moves falls back to jump'); assert.equal(c.durationSec, 10);
}

// learn prompt: cats -> pounce, birds -> peck, people -> tap, everyone else nothing; never when the move is already known
assert.equal(catchLightConfig({ actions: {}, voice: { species: 'cat' } }).learnKey, 'wantPounce');
assert.equal(catchLightConfig({ actions: {}, voice: { species: 'kitten' } }).learnKey, 'wantPounce');
assert.equal(catchLightConfig({ actions: {}, voice: { species: 'bird' } }).learnKey, 'wantPeck');
assert.equal(catchLightConfig({ actions: {}, voice: { kind: 'tts', preset: 'male' } }).learnKey, 'wantTap');
for (const sp of ['dog', 'dog-large', 'rabbit', 'rodent']) assert.equal(catchLightConfig({ actions: {}, voice: { species: sp } }).learnKey, null, sp + ': no prompt');
assert.equal(catchLightConfig({ actions: {}, voice: {} }).learnKey, null, 'unknown: no prompt');
assert.equal(catchLightConfig(withActs(['pounce'], { voice: { species: 'cat' } })).learnKey, null, 'already knows the pounce');
for (const lang of ['zh', 'en']) { const G = I18N.strings[lang].growth.game; for (const k of ['wantPounce', 'wantPeck', 'wantTap']) assert.ok(typeof G[k] === 'string' && G[k].length > 4, lang + ' ' + k); assert.ok(G.start(10).includes('10'), lang + ' start line carries the duration'); }

// one settlement per round, with a fake clock: 9.9 s no end, 10.0 s ends exactly once, hits after the end do not count
{ const cfg = catchLightConfig({ actions: {} }); let t = 5000; const r = new CatchRound(cfg, t);
  assert.equal(r.remaining(t), 10); assert.ok(r.hit()); assert.ok(r.hit()); assert.equal(r.score, 2);
  let ends = 0;
  for (let k = 0; k < 99; k++) { t += 0.1; if (r.tick(t)) ends++; }
  assert.equal(ends, 0, 'nothing at 9.9 s'); assert.ok(Math.abs(r.remaining(t) - 0.1) < 1e-6);
  t = 5010; assert.equal(r.tick(t), true, 'ends at 10.0 s'); ends++;
  for (let k = 0; k < 50; k++) { t += 0.1; if (r.tick(t)) ends++; }
  assert.equal(ends, 1, 'settled exactly once'); assert.equal(r.hit(), false, 'no score after the end'); assert.equal(r.score, 2);
  assert.equal(r.reachedTarget(), false); for (let i = 0; i < 6; i++) new CatchRound(cfg, 0).hit();
  const r2 = new CatchRound(cfg, 0); for (let i = 0; i < 8; i++) r2.hit(); assert.ok(r2.reachedTarget(), '8 points reach the 10 s target');
  // a 30 s pack: same class, same single settlement, scaled target
  const c30 = catchLightConfig({ catchLight: { durationSec: 30 } }); const r3 = new CatchRound(c30, 0); assert.equal(c30.target, 23);
  assert.equal(r3.tick(29.99), false); assert.equal(r3.tick(30), true); assert.equal(r3.tick(31), false);
  console.log('catch round ok'); }
assert.deepEqual(Object.keys(GROWTH_DEFS.CATCH_ACTIONS).sort(), ['bird', 'cartoon', 'cat', 'dog', 'dog-large', 'dog-small', 'human', 'kitten', 'rabbit', 'rodent']);
console.log('catch-light tests passed');
