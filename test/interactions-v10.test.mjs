import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const pet = JSON.parse(readFileSync(new URL('./fixtures/kapi-v11.pet.json', import.meta.url)));
const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
assert.ok(mainSource.includes('strokeTracker.move(lx, t, overPet, false)') && mainSource.includes('!dragging && !ctrlHeld && !asleep'), 'petting (0.9.6: hover, no button) works on any visible pet pixel, never under Ctrl');
assert.equal(pet.version, 11);
assert.equal(pet.runtime.minVersion, '0.8.6');
assert.equal(pet.actions.dragWiggle.preset, 'dragWiggle');
assert.equal(pet.triggers.dragStart.action, 'dragWiggle');
for (const id of ['clickTea', 'strokeHeartV8']) assert.equal(pet.milestones.find(m => m.id === id).cooldownSec, 0);

new Function(readFileSync(new URL('../src/milestones.js', import.meta.url), 'utf8'))();
new Function(readFileSync(new URL('../src/garden.js', import.meta.url), 'utf8'))();
let now = 100; const fired = [];
const milestones = new globalThis.Milestones(pet.milestones, { now: () => now, state: {}, save: () => {}, fire: e => fired.push(e), say: () => {} });
milestones.record('stroke'); milestones.record('stroke');
assert.deepEqual(fired, ['hearts', 'hearts'], 'every recognized stroke may show hearts');
for (let burst = 0; burst < 2; burst++) for (let i = 0; i < 10; i++) { now += 0.5; milestones.record('click'); }
assert.deepEqual(fired.slice(2), ['bubbleTea', 'bubbleTea'], 'consecutive click bursts may throw tea');

const slowState = {}, fastState = {};
const host = state => ({ now: () => now, state, save: () => {}, say: () => {}, onPick: () => {} });
const slow = new globalThis.Garden(pet.garden, host(slowState));
const fast = new globalThis.Garden(pet.garden, host(fastState));
for (let i = 0; i < 5; i++) { now += 1; slow.onTypingSecond(1); fast.onTypingSecond(7); }
assert.equal(slowState.garden.growthSec, 5);
assert.equal(fastState.garden.growthSec, 15);
assert.ok(fastState.garden.stage > slowState.garden.stage, 'faster typing grows faster');
console.log('v11 interactions ok');
