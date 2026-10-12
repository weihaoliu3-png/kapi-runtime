import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
new Function(readFileSync(new URL('../src/care.js', import.meta.url), 'utf8'))();
const { CareSystem } = globalThis;
const said = [], played = [];
new Function(readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8'))();
const host = { say: (t) => said.push(t), expr: () => {}, play: (id) => played.push(id), setSleeping: () => {}, setStageScale: () => {}, toast: () => {}, save: () => {}, line: () => null, t: () => globalThis.I18N.pick('en') };
const c = new CareSystem({ hunger: 50, lastTick: Date.now() - 8 * 3600e3 }, host);
assert.ok(c.s.hunger < 50 && c.s.hunger > 39.9, 'offline decay is gentle'); assert.ok(c.s.thirst >= 15, 'offline floor keeps thirst >= 15');
assert.ok(c.do('feed')); assert.ok(c.s.hunger > 30); assert.equal(c.do('feed'), false, 'cooldown');
assert.ok(c.do('water')); assert.ok(c.do('pet'));
assert.ok(c.s.xp >= 10 + 8 + 6 + 30, 'daily bonus applied once');
c.s.xp = 149; c._gainXp(1, 'pet'); assert.equal(c.s.level, 2); assert.ok(said.at(-1).includes('Level 2'));
c.do('sleep'); assert.equal(c.s.sleeping, true); c.do('sleep'); assert.equal(c.s.sleeping, false);
console.log('care tests passed');
// ticket ids + ledger merge
{ const c2 = new CareSystem({ level: 2, xp: 149 }, host); c2._gainXp(200, 'pet'); // -> level 3+ issues a ticket
  assert.ok(c2.s.ticketLog.length >= 1 && c2.s.ticketLog[0].id.startsWith('OT-3-'), 'ticket id issued');
  const pkg = { ticketLog: c2.s.ticketLog.map(t => ({ ...t, usedAt: 1, note: 'sweater' })) };
  const before = c2.s.tickets.outfit; assert.equal(c2.mergeLedger(pkg), c2.s.ticketLog.length); assert.equal(c2.s.tickets.outfit, before - c2.s.ticketLog.length);
  assert.equal(c2.mergeLedger(pkg), 0, 'idempotent'); console.log('ticket ledger ok'); }

// 0.8.11: a pet that came home before learning to sleep tells the host when the stand-in sleep plays (host.pending)
{ const pend = []; const h2 = { ...host, pending: (id) => pend.push(id) }; const c3 = new CareSystem({ energy: 10 }, h2);
  c3.do('sleep'); assert.deepEqual(pend, ['sleep'], 'sleep() notifies host.pending'); }
console.log('care pending hook ok');

// 0.8.15: level up plays a fanfare; waking plays a 'wake' reaction
{ const fx = [], re = [];
  const host = { say: () => {}, expr: () => {}, play: () => {}, setSleeping: () => {}, setStageScale: () => {}, toast: () => {}, save: () => {}, line: () => null,
    t: () => I18N.pick('en'), sfx: (n) => fx.push(n), react: (k) => re.push(k), pending: () => {} };
  const st = {}; const c = new CareSystem(st, host); c.s.xp = 0; c.s.level = 0;
  c._gainXp(100000, 'test'); assert.ok(fx.includes('fanfare'), 'level up fanfare');
  c.s.sleeping = true; c.wake(false); assert.ok(re.includes('wake'), 'wake reaction');
  console.log('care sounds ok'); }
