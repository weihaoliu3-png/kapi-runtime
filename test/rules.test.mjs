import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
new Function(readFileSync(new URL('../src/rules.js', import.meta.url), 'utf8'))();
const { KapiRules } = globalThis;
let now = Math.floor(new Date(2026, 9, 13, 18, 0, 0).getTime() / 1000);   // Tue 18:00 local
const log = []; const state = {}; let care = { mood: 50, level: 2, sleeping: false };
const host = { now: () => now, play: (id) => log.push('play:' + id), say: (t) => log.push('say:' + t), line: (k) => ({ praise: '谢谢～' })[k], expr: (n) => log.push('expr:' + n),
  effect: (e) => log.push('fx:' + e), sound: (s) => log.push('snd:' + s), react: (k) => log.push('re:' + k), look: (d) => log.push('look:' + d), walk: (w) => log.push('walk:' + w),
  hide: () => log.push('hide'), come: () => log.push('come'), mood: (d) => { care.mood += d; log.push('mood:' + d); }, toast: (t) => log.push('toast:' + t), state, care: () => care, species: () => 'cat', save: () => {} };
const rules = [
  { id: 'excel', when: 'app', match: { app: 'excel|表格' }, do: [{ expr: 'sleepy' }, { say: '又是表格……' }] },
  { id: 'offwork', when: 'time', match: { time: '18:00', days: [1, 2, 3, 4, 5] }, do: [{ play: 'wave' }, { say: '下班！' }] },
  { id: 'pic', when: 'fileDrop', match: { ext: ['png', 'jpg'] }, do: [{ play: 'dance' }, { effect: 'hearts' }] },
  { id: 'praise', when: 'stroke', if: { moodAbove: 40 }, cooldownSec: 10, do: [{ say: { line: 'praise' } }, { react: 'happy' }] },
  { id: 'quiet', when: 'idle', match: { minutes: 30 }, do: [{ play: 'groom' }] },
  { id: 'nightcat', when: 'click', if: { species: 'dog' }, do: [{ say: 'wrong species' }] },
  { id: 'flagged', when: 'click', if: { notFlag: 'seen' }, do: [{ say: 'first click' }, { flag: 'seen' }] },
  { id: 'bad', when: 'nope', do: [] },
];
const R = new KapiRules(rules, host);
assert.equal(R.rules.length, 7, 'invalid rule dropped');
assert.deepEqual(R.fire('app', { app: 'EXCEL.EXE', title: 'Book1' }), ['excel']); assert.deepEqual(log.splice(0), ['expr:sleepy', 'say:又是表格……']);
assert.deepEqual(R.fire('app', { app: 'EXCEL.EXE', title: 'Book1', sameAsLast: true }), [], 'same app again: nothing');
assert.deepEqual(R.fire('app', { app: 'notepad' }), []);
assert.deepEqual(R.fire('time', {}), ['offwork']); log.length = 0;
now += 60; assert.deepEqual(R.fire('time', {}), [], 'cooldown (and the minute passed)');
assert.deepEqual(R.fire('fileDrop', { ext: 'PNG' }), ['pic']); assert.deepEqual(log.splice(0), ['play:dance', 'fx:hearts']);
assert.deepEqual(R.fire('fileDrop', { ext: 'exe' }), []);
assert.deepEqual(R.fire('stroke', {}), ['praise']); assert.deepEqual(log.splice(0), ['say:谢谢～', 're:happy']);
assert.deepEqual(R.fire('stroke', {}), [], 'cooldown 10 s'); now += 11; care.mood = 10; assert.deepEqual(R.fire('stroke', {}), [], 'mood condition');
assert.deepEqual(R.fire('idle', { minutes: 10 }), []); assert.deepEqual(R.fire('idle', { minutes: 45 }), ['quiet']);
assert.deepEqual(R.fire('click', {}), ['flagged'], 'dog-only rule skipped for a cat; flag rule runs'); assert.ok(state.rules.flags.seen); log.length = 0;
now += 100; assert.deepEqual(R.fire('click', {}), [], 'flag set: not again');
// wait steps run async in order
const R2 = new KapiRules([{ id: 'w', when: 'wake', do: [{ say: 'a' }, { wait: 10 }, { say: 'b' }] }], host); R2.fire('wake', {});
await new Promise(r => setTimeout(r, 40)); assert.deepEqual(log.splice(0), ['say:a', 'say:b']);
// validation
const v = KapiRules.validate([{ when: 'time', do: [{ play: 'x' }] }, { when: 'bogus', do: [{ nope: 1 }] }, { when: 'app', match: { app: 'a' }, do: [{ say: 'ok' }] }], { actions: { wave: {} } });
assert.equal(v.length, 4, v.join('|')); assert.deepEqual(KapiRules.validate(null), []);
console.log('rules ok');
