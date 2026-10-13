// The notebook window's render logic, run against a stub DOM and a fixture pet (0.9.0)
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const html = readFileSync(new URL('../src/panel.html', import.meta.url), 'utf8');
const js = html.match(/<script>\r?\n([\s\S]*?)\r?\n\s*<\/script>/)[1];   // \r?: Windows checkouts turn LF into CRLF
new Function(readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8'))();
new Function(readFileSync(new URL('../src/growth.js', import.meta.url), 'utf8'))();
const els = {}; const el = (id) => els[id] || (els[id] = { innerHTML: '', textContent: '', querySelectorAll: () => [] });
globalThis.document = { getElementById: el, title: '' };
globalThis.location = { search: '?dir=%2Fpets%2Fx&lang=zh-CN' };
const pet = { name: '小云', actions: { idle: { type: 'procedural' }, wave: { type: 'frames' }, eat: { type: 'frames' }, drink: { type: 'procedural' }, sleep: { type: 'procedural' } }, layers: { expressions: { happy: 'a', sad: 'b' } }, lookFollow: { mode: 'frames8' }, voice: { kind: 'babble', species: 'kitten' } };
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();   // the fixture must be 'today' or the read-only Growth rolls the day and replaces the wishes
const state = { level: 3, mood: 60, growth: { day: today, wishes: [{ id: 'a', kind: 'stroke', target: 10, progress: 4, done: false }, { id: 'b', kind: 'learn', target: 1, progress: 0, done: false, platform: true }], coins: 6, stats: { stroke: 40, type: 1200 }, finds: [{ id: 'leaf', emoji: '🍂', at: 1 }, { id: 'leaf', emoji: '🍂', at: 2 }, { id: 'key', emoji: '🔑', at: 3 }], journal: [{ day: '2026-10-11', text: '你今天打了 300 个字。 还行。' }], best: { catch: 9 }, games: 2, learnedBaseline: 2 } };
const emitted = [];
globalThis.window = { __TAURI__: { core: { invoke: async (cmd, a) => { if (a.path.endsWith('pet.json')) return JSON.stringify(pet); if (a.path.endsWith('state.json')) return JSON.stringify(state); throw new Error('no persona'); } }, event: { emit: (n, p) => emitted.push([n, p]) } } };
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
globalThis.window.__panel.setTab('chapters'); b = el('body').innerHTML; assert.ok(b.includes('老朋友') && b.includes('混熟了') && b.includes('教它一个新动作'), 'chapters with tasks');
console.log('panel render ok');
