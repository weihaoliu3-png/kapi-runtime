import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
new Function(readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8'))();
new Function(readFileSync(new URL('../src/growth.js', import.meta.url), 'utf8'))();
const { Growth, GROWTH_DEFS, I18N } = globalThis;
const T = () => I18N.pick('zh');
let now = Date.UTC(2026, 9, 12, 10) / 1000 + 8 * 3600;   // some morning
const manifest = { actions: { idle: { type: 'procedural' }, wave: { type: 'frames' }, eat: { type: 'frames' }, drink: { type: 'procedural' }, sleep: { type: 'procedural' } }, garden: { color: '#f00' } };
const said = [], fired = []; let saves = 0; let level = 1;
const care = { s: { mood: 70, tickets: { outfit: 0, holiday: 0 }, ticketLog: [] } };
const host = () => ({ now: () => now, save: () => saves++, manifest, say: (k, v) => said.push(k), react: () => {}, sfx: () => {}, fire: (e) => fired.push(e), care, level: () => level, t: T });
const st = {}; const g = new Growth(st, host());
// day one: three wishes + the weekly learn wish
assert.equal(st.growth.wishes.filter(w => !w.platform).length, 3, 'three daily wishes');
assert.equal(st.growth.wishes.filter(w => w.platform).length, 1, 'one platform wish');
assert.equal(st.growth.learnedBaseline, 2, 'baseline frames actions (wave, eat)');
// completing a wish
const w = st.growth.wishes.find(x => !x.platform); const def = GROWTH_DEFS.WISH_POOL[w.kind];
for (let i = 0; i < 20; i++) g.record(def.event, def.event === 'type' ? 100 : 1);
assert.ok(w.done, 'wish done by its event'); assert.ok(said.includes('wishDone')); assert.equal(st.growth.coins, 3);
// all three -> bonus + hearts
for (const x of st.growth.wishes.filter(x => !x.platform && !x.done)) { const d = GROWTH_DEFS.WISH_POOL[x.kind]; for (let i = 0; i < 20; i++) g.record(d.event, d.event === 'type' ? 200 : 1); }
assert.ok(fired.includes('hearts') && said.includes('wishAll'), 'all wishes bonus'); assert.equal(st.growth.coins, 14);
// learn wish completes only when the package gains a frames action
assert.equal(g.onPackageChanged(), 0); manifest.actions.dance = { type: 'frames' }; assert.equal(g.onPackageChanged(), 1, 'new frames action = learned');
assert.ok(st.growth.wishes.find(x => x.kind === 'learn').done);
// finds: nothing for short absences, something (sometimes) after 25 min, max 2 a day; a page of 6 gives an outfit ticket
assert.equal(g.onReturn(600), null, 'short absence: nothing');
let got = 0; for (let i = 0; i < 40 && got < 2; i++) { const f = g.onReturn(3600); if (f) got++; }
assert.equal(got, 2, 'two finds max per day'); assert.equal(g.onReturn(3600), null, 'third blocked');
const g2st = {}; const g2 = new Growth(g2st, host());
for (let d = 0; d < 20; d++) { now += 86400; g2.tick(); for (let i = 0; i < 30; i++) g2.onReturn(3600); }
assert.ok(new Set(g2st.growth.finds.map(f => f.id)).size >= 6, 'eventually six different finds'); assert.ok(care.s.tickets.outfit >= 1, 'a full page earned an outfit ticket');
assert.ok(g2st.growth.journal.length >= 1 && g2st.growth.journal[0].text.length > 0, 'a diary line per day'); assert.ok(g2st.growth.journal.length <= 30);
// day rollover regenerates wishes
const before = st.growth.day; now += 86400; g.tick(); assert.notEqual(st.growth.day, before); assert.equal(st.growth.wishes.filter(x => !x.done && !x.platform).length, 3, 'fresh wishes');
// sulk after one hour of the user being present without touching it; time away does not count; ten strokes reconcile
const s3 = {}; const g3 = new Growth(s3, host());
now += 3 * 3600; g3.record('input'); assert.ok(!g3.sulking(), 'three hours away: no sulk');
for (let i = 0; i < 1500; i++) { now += 2; g3.record('input'); } assert.ok(!g3.sulking(), '50 minutes of typing: not yet');
g3.record('stroke'); for (let i = 0; i < 1700; i++) { now += 2; g3.record('input'); } assert.ok(!g3.sulking(), 'a stroke resets the hour');
for (let i = 0; i < 200; i++) { now += 2; g3.record('input'); } assert.ok(g3.sulking(), 'an hour ignored while present: sulks'); assert.ok(said.includes('sulkStart'));
for (let i = 0; i < 10; i++) g3.record('stroke'); assert.ok(!g3.sulking(), 'reconciled by strokes'); assert.ok(said.includes('sulkEnd')); assert.ok(care.s.mood >= 60);
// chapters: tasks that need the assistant
level = 2; const c = g.chapter(); assert.equal(c.id, 'c2'); assert.equal(c.task, 'newAction'); assert.equal(c.taskDone, true, 'dance was learned after the baseline (g was created before it)');
assert.equal(g3.chapter().taskDone, false, 'a pet first seen with dance has it in its baseline');
level = 6; assert.equal(g.chapter().taskDone, false, 'drink/sleep still stand-ins');
const sum = g.summary(); assert.deepEqual(sum.standIn, ['drink', 'sleep']); assert.ok(sum.learned.includes('wave'));
// game score
g3.record('game', 7); g3.record('game', 4); assert.equal(s3.growth.best.catch, 7); assert.equal(s3.growth.games, 2);
assert.ok(saves > 0);
console.log('growth tests passed');
