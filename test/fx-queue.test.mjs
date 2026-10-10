// Effects are queue-one: one on the canvas at a time, at most one waiting, newest pending wins, never two alive.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.performance = { now: () => 0 };
globalThis.requestAnimationFrame = () => {};
new Function(readFileSync(new URL('../src/effects.js', import.meta.url), 'utf8'))();
const { Queue } = globalThis.KapiFx;

const log = []; const resolvers = [];
const q = new Queue((effect) => new Promise((res) => { log.push('start:' + effect); resolvers.push(res); }));
assert.equal(q.request('petals', 1), 'started');
await Promise.resolve(); await Promise.resolve();
assert.equal(q.request('petals', 2), 'queued', 'second stroke during playback is queued, not stacked');
assert.equal(q.request('petals', 3), 'queued');
assert.equal(q.request('hearts', 4), 'queued', 'only the newest pending request survives');
assert.equal(q.alive, 1, 'exactly one effect alive');
resolvers[0]();
await new Promise((r) => setTimeout(r, 0));
assert.deepEqual(log, ['start:petals', 'start:hearts'], 'after the first ends, ONE queued effect plays (the newest)');
assert.equal(q.maxAlive, 1, 'max simultaneous effects over the whole run is 1');
q.request('petals', 5); q.clear();
resolvers[1]();
await new Promise((r) => setTimeout(r, 0));
assert.equal(log.length, 2, 'clear() drops the pending effect (pet switch / hide)');
assert.equal(q.playing, null);
// a player that throws (missing tea frames) must not wedge the queue
const q2 = new Queue(() => Promise.reject(new Error('frames missing')));
q2.request('bubbleTea'); await new Promise((r) => setTimeout(r, 0));
assert.equal(q2.playing, null, 'queue recovers after a failed effect');
assert.equal(q2.request('hearts'), 'started');
console.log('fx queue OK');
