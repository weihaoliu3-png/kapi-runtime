// The notebook window's render logic, run against a stub DOM and a fixture pet (0.9.0)
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const html = readFileSync(new URL('../src/panel.html', import.meta.url), 'utf8');
const js = html.match(/<script>\r?\n([\s\S]*?)\r?\n\s*<\/script>/)[1];   // \r?: Windows checkouts turn LF into CRLF
new Function(readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8'))();
new Function(readFileSync(new URL('../src/growth.js', import.meta.url), 'utf8'))();
new Function(readFileSync(new URL('../src/engine.js', import.meta.url), 'utf8'))();   // the page loads it too: PET_PERFORMABLE decides which procedural presets are clickable
const els = {}; const el = (id) => els[id] || (els[id] = { innerHTML: '', textContent: '', querySelectorAll: () => [] });
globalThis.document = { getElementById: el, title: '' };
globalThis.location = { search: '?dir=%2Fpets%2Fx&lang=zh-CN' };
const pet = { name: '小云', actions: { idle: { type: 'procedural' }, wave: { type: 'frames' }, eat: { type: 'frames' }, drink: { type: 'procedural' }, sleep: { type: 'procedural' } }, layers: { expressions: { happy: 'a', sad: 'b' } }, lookFollow: { mode: 'frames8' }, voice: { kind: 'babble', species: 'kitten' } };
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();   // the fixture must be 'today' or the read-only Growth rolls the day and replaces the wishes
const state = { level: 3, mood: 60, growth: { day: today, wishes: [{ id: 'a', kind: 'stroke', target: 10, progress: 4, done: false }, { id: 'b', kind: 'learn', target: 1, progress: 0, done: false, platform: true }], coins: 6, stats: { stroke: 40, type: 1200 }, finds: [{ id: 'leaf', emoji: '🍂', at: 1 }, { id: 'leaf', emoji: '🍂', at: 2 }, { id: 'key', emoji: '🔑', at: 3 }], journal: [{ day: '2026-10-11', text: '你今天打了 300 个字。 还行。' }], best: { catch: 9 }, games: 2, learnedBaseline: 2 } };
const emitted = [];
globalThis.window = { __TAURI__: { core: { invoke: async (cmd, a) => { if (a.path.endsWith('pet.json')) return JSON.stringify(pet); if (a.path.endsWith('state.json')) return JSON.stringify(state); throw new Error('no persona'); } }, event: { emit: async (n, p) => emitted.push([n, p]), listen: async (n, fn) => { listeners[n] = fn; } } } };
const listeners = {};
globalThis.window.PET_PERFORMABLE = globalThis.PET_PERFORMABLE;   // in the browser both are the same object
let intervalFn = null; globalThis.setInterval = (fn) => { intervalFn = fn; return 1; };
await new Function('I18N', 'Growth', 'GROWTH_DEFS', js)(globalThis.I18N, globalThis.Growth, globalThis.GROWTH_DEFS);
await new Promise(r => setTimeout(r, 20));
assert.ok(el('name').textContent === '小云'); assert.ok(el('sub').textContent.includes('Lv.3') && el('sub').textContent.includes('老朋友'));
assert.ok(el('coins').textContent.includes('6'));
const body = el('body').innerHTML;
assert.ok(body.includes('挥手') && body.includes('学会的动作'), 'learned chips'); assert.ok(body.includes('先凑合的') && body.includes('喝水'), 'stand-ins listed');
assert.ok(body.includes('跳舞') && body.includes('还不会的'), 'candidates'); assert.ok(body.includes('真实叫声（kitten）') && body.includes('8 个方向'));
assert.ok(body.includes('>40<') && body.includes('>1200<') && body.includes('>9<'), 'stats');
// other tabs render without throwing
globalThis.window.__panel.setTab('wishes'); let b = el('body').innerHTML;
assert.ok(b.includes('被摸 10 下') && b.includes('width:40%') && b.includes('要回助手那里'), 'wishes with progress and the platform tag');
globalThis.window.__panel.setTab('finds'); b = el('body').innerHTML; assert.ok(b.includes('🍂') && b.includes('×2') && b.includes('旧钥匙') && b.includes('第 1 页'), 'finds grid');
globalThis.window.__panel.setTab('journal'); b = el('body').innerHTML; assert.ok(b.includes('2026-10-11') && b.includes('300'), 'diary');
// 0.9.3: the window is reused — it announces itself, and `notebook-open` from the pet window re-points it at a pet
assert.ok(emitted.some(([n]) => n === 'notebook-ready'), 'notebook-ready emitted'); assert.ok(emitted.some(([n, p]) => n === 'notebook-loaded' && p.ok), 'notebook-loaded ok');
assert.ok(typeof listeners['notebook-open'] === 'function', 'listens for notebook-open');
listeners['notebook-open']({ payload: { dir: 'C:\\pets\\y', lang: 'zh-CN' } }); await new Promise(r => setTimeout(r, 20));
assert.ok(emitted.filter(([n]) => n === 'notebook-loaded').length === 2, 'reloaded for the new dir');
globalThis.window.__panel.setTab('chapters'); b = el('body').innerHTML; assert.ok(b.includes('老朋友') && b.includes('混熟了') && b.includes('教它一个新动作'), 'chapters with tasks');
console.log('panel render ok');

// ---------- 0.9.4: skill cards + the panel-cmd / panel-ack protocol ----------
globalThis.window.__panel.setTab('skills'); b = el('body').innerHTML;
assert.ok(/data-kind="play" data-id="wave"/.test(b) && b.includes('点一下试试'), 'a frames action is a play card');
assert.ok(/class="card can[^"]*" role="button" tabindex="0"[^>]*data-id="eat"/.test(b), 'learned eat is a play card (care flow)');
assert.ok(/card info[^>]*data-id="sleep"/.test(b) && /card info[^>]*data-id="drink"/.test(b), 'stand-ins without a performable preset are information');
assert.ok(/data-kind="look"[^>]*data-id="look"/.test(b) && b.includes('role="switch"') && b.includes('aria-checked="true"'), 'look-follow is a switch, on by default');
assert.ok(/data-kind="voice"/.test(b) && b.includes('听一下'), 'voice card'); assert.ok(/data-kind="expr" data-id="happy"/.test(b) && b.includes('看一眼'), 'expression card');
assert.ok(/card info[^>]*data-id="dance"/.test(b) && !/card can[^>]*data-id="dance"/.test(b), 'not-yet moves are information only');
assert.ok(el('recent').textContent.includes('挥手') || el('recent').textContent.includes('吃饭'), 'header shows the latest learned move');
// a play click emits once; a second click while pending is ignored (double click)
const sent = () => emitted.filter(([n]) => n === 'panel-cmd');
const n0 = sent().length;
globalThis.window.__panel.activate('play', 'wave', 'play:wave'); globalThis.window.__panel.activate('play', 'wave', 'play:wave'); globalThis.window.__panel.activate('play', 'eat', 'play:eat');
assert.deepEqual(sent().slice(n0).map(([, p]) => p), [{ cmd: 'play', action: 'wave' }], 'one panel-cmd even on a double click, other cards locked meanwhile');
assert.ok(globalThis.window.__panel.pending() && globalThis.window.__panel.status('play:wave').text === '正在表演…', 'card shows performing');
assert.ok(typeof listeners['panel-ack'] === 'function', 'listens for panel-ack');
listeners['panel-ack']({ payload: { cmd: 'play', action: 'wave', ok: false, reason: 'busy' } });
assert.equal(globalThis.window.__panel.status('play:wave').text, '等它做完', 'busy reason shown'); assert.equal(globalThis.window.__panel.pending(), null, 'unlocked after the ack');
globalThis.window.__panel.activate('play', 'wave', 'play:wave'); assert.equal(sent().length, n0 + 2, 'can play again after the ack');
listeners['panel-ack']({ payload: { cmd: 'play', action: 'wave', ok: true, reason: '' } }); assert.equal(globalThis.window.__panel.status('play:wave').text, '做完了');
// look-follow switch emits {cmd:'lookFollow', on}
globalThis.window.__panel.toggleLook(); assert.deepEqual(sent().slice(-1)[0][1], { cmd: 'lookFollow', on: false }, 'switch off');
listeners['panel-ack']({ payload: { cmd: 'lookFollow', action: 'off', ok: true, reason: '' } }); assert.ok(el('body').innerHTML.includes('aria-checked="false"'), 'switch re-rendered off');
globalThis.window.__panel.toggleLook(); assert.deepEqual(sent().slice(-1)[0][1], { cmd: 'lookFollow', on: true }, 'switch on again');
listeners['panel-ack']({ payload: { cmd: 'lookFollow', action: 'on', ok: true, reason: '' } });
// expression and voice cards
globalThis.window.__panel.activate('expr', 'happy', 'expr:happy'); assert.deepEqual(sent().slice(-1)[0][1], { cmd: 'expr', name: 'happy' });
listeners['panel-ack']({ payload: { cmd: 'expr', action: 'happy', ok: true, reason: '' } });
globalThis.window.__panel.activate('voice', 'voice', 'voice:voice'); assert.deepEqual(sent().slice(-1)[0][1], { cmd: 'voice' });
listeners['panel-ack']({ payload: { cmd: 'voice', action: '', ok: true, reason: '' } });
// walk: frames without a cycle = disabled with a reason; with cycle = a play card that strolls
pet.actions.walk = { type: 'frames' }; await intervalFn(); b = el('body').innerHTML;
assert.ok(/card off[^>]*data-kind="walk" data-id="walk"/.test(b) && b.includes('还没学会侧身走路'), 'walk without a cycle is disabled with a reason');
pet.actions.walk = { type: 'frames', cycle: true }; await intervalFn(); b = el('body').innerHTML;
assert.ok(/card can[^>]*data-kind="walk" data-id="walk"/.test(b) && b.includes('去走一圈'), 'walk with a cycle is clickable');
globalThis.window.__panel.activate('walk', 'walk', 'walk:walk'); assert.deepEqual(sent().slice(-1)[0][1], { cmd: 'play', action: 'walk' });
listeners['panel-ack']({ payload: { cmd: 'play', action: 'walk', ok: false, reason: 'noWalk' } }); assert.equal(globalThis.window.__panel.status('walk:walk').text, '还没学会侧身走路');
// procedural nod is a play card too; an unknown procedural state (idle) is not a card
pet.actions.nod = { type: 'procedural', preset: 'nod' }; await intervalFn(); b = el('body').innerHTML;
assert.ok(/card can[^>]*data-kind="play" data-id="nod"/.test(b) && b.includes('点头'), 'procedural nod is playable'); assert.ok(!/data-id="idle"/.test(b), 'idle is not a card');
// empty state carries the pet's name
pet.actions = { idle: { type: 'procedural' } }; pet.layers.expressions = {}; await intervalFn(); b = el('body').innerHTML;
assert.ok(b.includes('小云 还在学习新本领') && b.includes('小云 还没有专门的表情'), 'character-flavoured empty states');
console.log('panel cards + protocol ok');
