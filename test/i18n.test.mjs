// i18n contract: the built-in sets are pure DATA with matching keys and matching {placeholders}, pick() turns
// templates into the functions call sites use, and a language pack merges over the top without being able to
// break any of that. A pack that drops a key or mangles a {placeholder} is the whole risk of shipping
// translations as data, so it is checked here and again (for the real packs) in the skill's selftest.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const g = {};
new Function('globalThis', readFileSync(join(HERE, '..', 'src', 'i18n.js'), 'utf8'))(g);
const { strings: S, pick, TEMPLATE_FNS, LOGIC_FNS } = g.I18N;

const SKIP = new Set(['_dir', '_lang']);
function leaves(o, p = '', acc = {}) {
  for (const k in o) {
    if (!p && SKIP.has(k)) continue;
    const v = o[k], path = p ? p + '.' + k : k;
    if (typeof v === 'string') acc[path] = v;
    else if (Array.isArray(v)) v.forEach((x, i) => { if (typeof x === 'string') acc[`${path}[${i}]`] = x; });
    else if (v && typeof v === 'object') leaves(v, path, acc);
  }
  return acc;
}
const phs = (s) => [...new Set(String(s).match(/\{\w+\}/g) || [])].sort();

// Which placeholders a given string is ALLOWED to use: the ones the English base uses there, plus any argument
// the call site passes for that key. A translation may use an argument English happens not to need (zh's
// care.cooldown says "刚{label}过" where English just says "Just did that"), but it may never invent a name —
// an unknown {foo} renders literally on screen — and it may never drop one the base shows, which is how a
// number or a name silently disappears from a sentence.
const LOGIC_ARGS = { 'pending.all': ['l'], 'growth.game.overOne': ['n'], 'growth.game.overMany': ['n'], 'growth.game.newRecord': [] };
function allowed(path) {
  const key = path.replace(/\[\d+\]$/, '');
  const args = TEMPLATE_FNS[key] || LOGIC_ARGS[key] || [];
  return new Set([...phs(EN[path] || ''), ...args.map((a) => `{${a}}`)]);
}

const EN = leaves(S.en);
assert.ok(Object.keys(EN).length > 250, 'the English base should have the full string set');

// ---- 1. every built-in set matches English key for key, and uses placeholders legally
for (const lang of Object.keys(S)) {
  const L = leaves(S[lang]);
  const missing = Object.keys(EN).filter((k) => !(k in L));
  const extra = Object.keys(L).filter((k) => !(k in EN));
  assert.deepEqual(missing, [], `${lang}: missing keys`);
  assert.deepEqual(extra, [], `${lang}: keys English does not have`);
  for (const k of Object.keys(EN)) {
    assert.ok(L[k].length > 0, `${lang}.${k}: empty`);
    const ok = allowed(k), used = phs(L[k]);
    const invented = used.filter((p) => !ok.has(p));
    assert.deepEqual(invented, [], `${lang}.${k}: unknown placeholder ${invented} (allowed: ${[...ok].join(' ') || 'none'})`);
    const lost = phs(EN[k]).filter((p) => !used.includes(p));
    assert.deepEqual(lost, [], `${lang}.${k}: dropped ${lost} that English shows — "${EN[k]}" vs "${L[k]}"`);
  }
}

// ---- 2. no functions left in the data (a pack is json; anything callable has to come from pick())
for (const lang of Object.keys(S)) {
  (function walk(o, p) {
    for (const k in o) {
      const v = o[k], path = p ? p + '.' + k : k;
      assert.notEqual(typeof v, 'function', `${lang}.${path} is a function — it must be a {placeholder} template`);
      if (v && typeof v === 'object') walk(v, path);
    }
  })(S[lang], '');
}

// ---- 3. pick() rebuilds every declared function, and they substitute
const get = (o, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
for (const lang of Object.keys(S)) {
  const T = pick(lang);
  for (const path of Object.keys(TEMPLATE_FNS)) {
    assert.equal(typeof get(T, path), 'function', `${lang}: ${path} should be a function after pick()`);
    const args = TEMPLATE_FNS[path].map((_, i) => `A${i}`);
    const out = get(T, path)(...args);
    // every {placeholder} the template uses has to be substituted; an argument the sentence does not need may be
    // left out (English's care.cooldown does not say which action it was), that is check 1's job to police
    assert.ok(!/\{\w+\}/.test(out), `${lang}: ${path} left a placeholder unfilled -> ${out}`);
    // and every placeholder this language's template DOES use must carry its value through
    for (const p of phs(leaves(S[lang])[path] || '')) {
      const i = TEMPLATE_FNS[path].indexOf(p.slice(1, -1));
      if (i >= 0) assert.ok(out.includes(args[i]), `${lang}: ${path} swallowed ${p} -> ${out}`);
    }
  }
  for (const path of Object.keys(LOGIC_FNS)) assert.equal(typeof get(T, path), 'function', `${lang}: ${path}`);
  assert.equal(T.growth.game.over(1, 0), T.growth.game.overOne.replace('{n}', '1') + T.growth.game.newRecord, `${lang}: over() one + record`);
  assert.ok(!T.growth.game.over(2, 9).includes(T.growth.game.newRecord), `${lang}: no record claim below the best`);
  assert.ok(T.pending.all(['A', 'B']).includes('A' + T.listSep + 'B'), `${lang}: pending.all joins with listSep`);
}

// ---- 4. a pack merges key by key and cannot break the untouched ones
const packed = pick('ja-JP', { tray: { quit: '終了' }, care: { feed: 'ごはん' }, listSep: '、', pending: { one: 'その{x}は仮のものです。' } });
assert.equal(packed.tray.quit, '終了');
assert.equal(packed.care.feed, 'ごはん');
assert.equal(packed.care.water, S.en.care.water, 'a key the pack does not mention keeps the English text');
assert.equal(packed.pending.one('ごはん'), 'そのごはんは仮のものです。', 'a pack template still becomes a working function');
assert.ok(packed.pending.all(['A', 'B']).includes('A、B'), 'the pack can change the list separator');
assert.equal(pick('ja-JP', { care: { feed: '' } }).care.feed, S.en.care.feed, 'an empty string in a pack is ignored, not shipped');
assert.equal(pick('ja-JP', null).care.feed, S.en.care.feed, 'no pack = built-in');

// ---- 5. Traditional Chinese starts from Simplified, everything else from English
assert.equal(pick('zh-TW').care.feed, S.zh.care.feed, 'zh-TW falls back to Chinese, not English');
assert.equal(pick('zh-Hant').menu.actions, S.zh.menu.actions);
assert.equal(pick('ko-KR').care.feed, S.en.care.feed, 'Korean with no pack falls back to English');

// ---- 6. direction
for (const l of ['ar', 'ar-SA', 'he-IL', 'fa', 'ur-PK']) assert.equal(pick(l)._dir, 'rtl', l);
for (const l of ['en', 'ja-JP', 'zh-CN', 'pt-BR', 'nl', 'ko-KR']) assert.equal(pick(l)._dir, 'ltr', l);

// ---- 7. the tray strings the Rust side renders must exist in every built-in set
for (const lang of Object.keys(S)) {
  for (const k of ['show', 'notebook', 'typing', 'import', 'switch', 'export', 'recover', 'diagnose', 'quit']) {
    assert.ok(typeof S[lang].tray[k] === 'string' && S[lang].tray[k].length > 0, `${lang}: tray.${k}`);
  }
}

// ---- 8. the fixed-length lists stay the length the code indexes into
for (const lang of Object.keys(S)) {
  assert.equal(S[lang].care.titles.length, 10, `${lang}: 10 level titles`);
  assert.equal(Object.keys(S[lang].care.rewards).length, 9, `${lang}: rewards for levels 2..10`);
  assert.equal(Object.keys(S[lang].growth.chapter).length, 10, `${lang}: 10 chapters`);
}

console.log('i18n.test.mjs ok');
