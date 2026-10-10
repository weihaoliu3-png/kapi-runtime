import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const rust = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
assert.match(html, /<canvas id="fx"/);
assert.match(html, /#fx \{[^}]*pointer-events: none/);
assert.match(html, /<script src="effects\.js"><\/script>/);
assert.match(main, /KapiFx\.play\(fxCtx, fxCanvas\.width/);
assert.match(main, /BUILTIN_FX = \{ bubbleTea[\s\S]*KapiFx\.playVideoFrames\(/, 'bubble tea plays real frames: the package\'s own, else the runtime\'s built-in set');
assert.doesNotMatch(main, /open_fx_window|fx-ready|fx-play/);
assert.doesNotMatch(rust, /fn open_fx_window/);

let now = 0;
globalThis.performance = { now: () => now };
globalThis.requestAnimationFrame = (cb) => { now += 50; queueMicrotask(() => cb(now)); };
new Function(readFileSync(new URL('../src/effects.js', import.meta.url), 'utf8'))();
const localThrow = globalThis.KapiFx.planThrow({ x: 208, y: 328 }, 376, 450, 1, true);
assert.ok(localThrow.hitPoint.x < 376 - 40 && localThrow.hitPoint.y > 200,
  'bounded tea splash stays inward and below the pet face');

let clears = 0;
const frameDraws = [];
const ctx = new Proxy({}, {
  get(_target, key) {
    if (key === 'clearRect') return () => { clears += 1; };
    if (key === 'drawImage') return (img, _x, _y, width) => { frameDraws.push([img.id, width]); };
    return () => {};
  },
  set() { return true; },
});
await globalThis.KapiFx.playVideoFrames(ctx, 376, 450, [
  { id: 0, width: 720, height: 1280 },
  { id: 1, width: 720, height: 1280 },
  { id: 2, width: 720, height: 1280 },
], 10);
assert.deepEqual([...new Set(frameDraws.map(([id]) => id))], [0, 1, 2], 'video frames play in source order');
assert.ok(frameDraws.every(([, width]) => width >= 376), 'video effect fills the pet window');
assert.ok(clears >= 3, 'video effect renders and cleans up on completion');

const controller = new AbortController();
const beforeAbort = clears;
globalThis.requestAnimationFrame = (cb) => { controller.abort(); queueMicrotask(cb); };
await globalThis.KapiFx.play(ctx, 376, 450, 1, 'hearts', { local: true, signal: controller.signal });
assert.equal(clears, beforeAbort, 'aborted effect must not clear a newer effect; host owns final cleanup');
console.log('local effects ok');
