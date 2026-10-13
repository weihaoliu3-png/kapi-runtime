// Kapi growth (0.9.0): what makes "tomorrow" worth opening — daily wishes, things it brings back, a one-line diary,
// a sulk when neglected, chapters with a task that only the assistant (platform) can finish, and the catch game score.
// Pure logic: the host supplies now(), persistence, the pet manifest and the lines; main.js draws and the panel window
// (panel.html) reads state.json to show it. Everything lives in state.json under `growth`.
(function (global) {
  'use strict';

  const DAY = 86400;
  const rid = () => Math.random().toString(36).slice(2, 8);
  const dayKey = (sec) => { const d = new Date(sec * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  // ---- wishes: small things the pet hopes for today; three a day, one of them sometimes needs the assistant ----
  // kind -> {target, weight, event}. `learn` is the platform wish: it completes when the package gains a new skill.
  const WISH_POOL = {
    stroke: { target: 10, weight: 10, event: 'stroke' },
    click:  { target: 12, weight: 6,  event: 'click' },
    type:   { target: 800, weight: 10, event: 'type' },
    feed:   { target: 2, weight: 8,  event: 'feed' },
    water:  { target: 2, weight: 8,  event: 'water' },
    sleep:  { target: 1, weight: 6,  event: 'sleep' },
    flower: { target: 1, weight: 5,  event: 'flower' },
    game:   { target: 1, weight: 7,  event: 'game' },
    gift:   { target: 1, weight: 3,  event: 'gift' },
    notebook: { target: 1, weight: 4, event: 'panel' },
    learn:  { target: 1, weight: 0,  event: 'learned', platform: true },   // only placed by the weekly rule
  };
  const WISH_COIN = 3, WISH_ALL_BONUS = 5;

  // ---- things it brings back while you were away ----
  const FINDS = [
    { id: 'leaf', emoji: '🍂', r: 1 }, { id: 'pebble', emoji: '🪨', r: 1 }, { id: 'cap', emoji: '🧢', r: 1 }, { id: 'plane', emoji: '✈️', r: 1 }, { id: 'yarn', emoji: '🧶', r: 1 }, { id: 'wrapper', emoji: '🍬', r: 1 },
    { id: 'feather', emoji: '🪶', r: 2 }, { id: 'key', emoji: '🔑', r: 2 }, { id: 'shell', emoji: '🐚', r: 2 }, { id: 'ribbon', emoji: '🎀', r: 2 }, { id: 'clip', emoji: '📎', r: 2 }, { id: 'cookie', emoji: '🍪', r: 2 },
    { id: 'plush', emoji: '🧸', r: 3 }, { id: 'coin', emoji: '🪙', r: 3 }, { id: 'acorn', emoji: '🌰', r: 3 }, { id: 'stub', emoji: '🎫', r: 3 }, { id: 'sock', emoji: '🧦', r: 3 }, { id: 'star', emoji: '⭐', r: 3 },
  ];
  const FIND_PAGE = 6;                 // a full page (6 different finds) earns an outfit ticket -> back to the assistant
  const FIND_MIN_ABSENT = 25 * 60;     // away at least this long
  const FIND_MAX_PER_DAY = 2;

  // ---- chapters: level ranges with a name and, every other chapter, a task only the assistant can finish ----
  const CHAPTERS = [
    { id: 'c1', from: 1, task: null },
    { id: 'c2', from: 2, task: 'newAction' },      // learn one new action (frames action count grows)
    { id: 'c3', from: 3, task: null },
    { id: 'c4', from: 4, task: 'outfit' },         // wear an outfit (needs the ticket redeemed at the assistant)
    { id: 'c5', from: 5, task: null },
    { id: 'c6', from: 6, task: 'care3' },          // eat, drink and sleep all really learned
    { id: 'c7', from: 7, task: null },
    { id: 'c8', from: 8, task: 'newAction2' },     // two more actions than at chapter 2
    { id: 'c9', from: 9, task: null },
    { id: 'c10', from: 10, task: null },
  ];

  // sulk: one hour of YOU being at the computer (typing / mousing) without touching it once. Time away does not count,
  // so coming back from lunch never starts a sulk; ignoring it while you work all afternoon does.
  const SULK_AFTER_SEC = 3600, SULK_STROKES = 10;

  class Growth {
    /** host: { now() -> sec, save(), manifest, say(key, vars), react(kind), sfx(name), fire(effect), care (CareSystem|null), level() } */
    constructor(state, host) {
      this.h = host; this.st = state;
      const g = this.st.growth = Object.assign({
        day: '', wishes: [], coins: 0, stats: {}, dayStats: {}, finds: [], findsToday: 0, journal: [], learnedBaseline: null,
        lastInputAt: 0, lastCareAt: 0, ignoredSec: 0, sulk: null, sulkStrokes: 0, best: { catch: 0 }, games: 0, chapterDone: {}, weeklyLearnAt: 0, log: [],
      }, this.st.growth || {});
      if (g.learnedBaseline == null) g.learnedBaseline = this.learnedCount();
      g.lastInputAt = g.lastInputAt || host.now(); g.lastCareAt = g.lastCareAt || host.now();
      this.tick();
    }
    // ---- helpers ----
    learnedCount() { const a = (this.h.manifest && this.h.manifest.actions) || {}; return Object.keys(a).filter(id => a[id].type === 'frames').length; }
    learnedIds() { const a = (this.h.manifest && this.h.manifest.actions) || {}; return Object.keys(a).filter(id => a[id].type === 'frames'); }
    careReal() { const a = (this.h.manifest && this.h.manifest.actions) || {}; return ['eat', 'drink', 'sleep'].filter(id => a[id] && a[id].type === 'frames'); }
    hasOutfit() { const o = this.h.manifest && this.h.manifest.outfits; return !!(o && o.items && Object.keys(o.items).length) || !!this.st.outfit; }

    // ---- day rollover ----
    tick() {
      const g = this.st.growth; const now = this.h.now(); const today = dayKey(now);
      if (g.day !== today) {
        if (g.day) this._writeJournal(g.day, g.dayStats);
        g.day = today; g.dayStats = {}; g.findsToday = 0;
        this._newWishes(now);
        this.h.save();
      }
      this._checkSulk(now);
    }
    _newWishes(now) {
      const g = this.st.growth; const keep = g.wishes.filter(w => w.platform && !w.done);   // the learn wish carries over until done
      const pool = Object.keys(WISH_POOL).filter(k => !WISH_POOL[k].platform && !(k === 'flower' && !(this.h.manifest && this.h.manifest.garden)));
      const picked = [];
      while (picked.length < 3 && pool.length) {
        const total = pool.reduce((q, k) => q + WISH_POOL[k].weight, 0); let r = Math.random() * total; let k = pool[0];
        for (const c of pool) { r -= WISH_POOL[c].weight; if (r <= 0) { k = c; break; } }
        pool.splice(pool.indexOf(k), 1); picked.push(k);
      }
      g.wishes = [...keep, ...picked.map(k => ({ id: rid(), kind: k, target: WISH_POOL[k].target, progress: 0, done: false }))];
      // once a week (and whenever none is pending) the pet wishes for something only the assistant can give
      if (!keep.length && now - (g.weeklyLearnAt || 0) >= 7 * DAY) { g.weeklyLearnAt = now; g.wishes.push({ id: rid(), kind: 'learn', target: 1, progress: 0, done: false, platform: true, baseline: this.learnedCount() }); }
    }

    // ---- events from the pet window ----
    /** event: stroke | click | type(n chars) | feed | water | sleep | flower | game(score) | gift | panel | input | care | learned */
    record(event, n) {
      const g = this.st.growth; n = n == null ? 1 : n; const now = this.h.now();
      this.tick();
      g.stats[event] = (g.stats[event] || 0) + n; g.dayStats[event] = (g.dayStats[event] || 0) + n;
      if (event === 'input' || event === 'type') { const gap = now - (g.lastInputAt || now); if (gap > 0 && gap <= 5) g.ignoredSec += gap; g.lastInputAt = now; }   // only seconds you were actually here
      if (event === 'feed' || event === 'water' || event === 'stroke' || event === 'sleep' || event === 'click' || event === 'game' || event === 'gift') { g.lastCareAt = now; g.ignoredSec = 0; }
      if (event === 'game') { g.games += 1; if (n > (g.best.catch || 0)) g.best.catch = n; }
      if (g.sulk && event === 'stroke') { g.sulkStrokes += n; if (g.sulkStrokes >= SULK_STROKES) this._reconcile(); }
      const done = [];
      for (const w of g.wishes) {
        if (w.done) continue;
        const def = WISH_POOL[w.kind]; if (!def || def.event !== event) continue;
        w.progress = Math.min(w.target, w.progress + (event === 'type' ? n : (event === 'game' ? 1 : n)));
        if (w.progress >= w.target) { w.done = true; w.doneAt = now; g.coins += WISH_COIN; done.push(w); }
      }
      if (done.length) {
        for (const w of done) { this.h.say('wishDone', { wish: w.kind }); this.h.react && this.h.react('happy'); this.h.sfx && this.h.sfx('chime', 0.35); this._log('wish', w.kind); }
        if (g.wishes.every(w => w.done || w.platform)) { g.coins += WISH_ALL_BONUS; this.h.fire && this.h.fire('hearts'); this.h.say('wishAll'); }
      }
      this.h.save();
      return done.map(w => w.kind);
    }
    /** The package changed (new version loaded): a learn wish completes when the frames count grew. */
    onPackageChanged() {
      const g = this.st.growth; const n = this.learnedCount(); const done = [];
      for (const w of g.wishes) if (!w.done && w.kind === 'learn' && n > (w.baseline == null ? g.learnedBaseline : w.baseline)) { w.done = true; w.doneAt = this.h.now(); g.coins += WISH_COIN * 2; done.push(w); }
      if (done.length) { this.h.say('wishDone', { wish: 'learn' }); this.h.fire && this.h.fire('hearts'); }
      this.h.save(); return done.length;
    }

    // ---- away & back: it brings something ----
    /** Call when input resumes after a gap. Returns the find (or null). */
    onReturn(absentSec) {
      const g = this.st.growth; this.tick();
      if (absentSec < FIND_MIN_ABSENT || g.findsToday >= FIND_MAX_PER_DAY) return null;
      if (Math.random() > 0.55) return null;
      const owned = new Set(g.finds.map(f => f.id));
      const weights = FINDS.map(f => (owned.has(f.id) ? 0.35 : 1) * (f.r === 1 ? 5 : f.r === 2 ? 3 : 1));
      const total = weights.reduce((a, b) => a + b, 0); let r = Math.random() * total; let pick = FINDS[0];
      for (let i = 0; i < FINDS.length; i++) { r -= weights[i]; if (r <= 0) { pick = FINDS[i]; break; } }
      const f = { id: pick.id, emoji: pick.emoji, at: this.h.now(), new: !owned.has(pick.id) };
      g.finds.push(f); g.findsToday += 1; g.dayStats.find = (g.dayStats.find || 0) + 1; this._log('find', pick.id);
      // a full page of different finds -> an outfit ticket (only the assistant can turn it into clothes)
      const distinct = new Set(g.finds.map(x => x.id)).size; const pages = Math.floor(distinct / FIND_PAGE);
      if (pages > (g.findPages || 0)) { g.findPages = pages; f.page = true; if (this.h.care) { this.h.care.s.tickets.outfit = (this.h.care.s.tickets.outfit || 0) + 1; this.h.care.s.ticketLog = [...(this.h.care.s.ticketLog || []), { type: 'outfit', at: Date.now(), from: 'finds' }]; } }
      this.h.save();
      return f;
    }

    // ---- diary ----
    _writeJournal(day, s) {
      const g = this.st.growth; const parts = [];
      const T = this.h.t ? this.h.t().growth : null; if (!T) return;
      if (s.type) parts.push(T.jType(s.type)); if (s.stroke) parts.push(T.jStroke(s.stroke)); if (s.feed || s.water) parts.push(T.jCare((s.feed || 0) + (s.water || 0)));
      if (s.find) parts.push(T.jFind(s.find)); if (s.game) parts.push(T.jGame(g.best.catch)); if (s.whip) parts.push(T.jWhip(s.whip));
      if (!parts.length) parts.push(T.jQuiet);
      const mood = this.h.care ? this.h.care.s.mood : 70;
      parts.push(mood >= 70 ? T.jHappy : mood >= 40 ? T.jOk : T.jSad);
      g.journal = [...g.journal, { day, text: parts.join(' ') }].slice(-30);
    }

    // ---- sulk: ignored for a day and a half with a bad mood ----
    _checkSulk(now) {
      const g = this.st.growth; const asleep = this.h.care && this.h.care.s.sleeping;
      if (!g.sulk && !asleep && g.ignoredSec >= SULK_AFTER_SEC) { g.sulk = { since: now }; g.sulkStrokes = 0; g.ignoredSec = 0; this.h.say('sulkStart'); this._log('sulk'); if (this.h.react) this.h.react('angry'); this.h.save(); }
    }
    _reconcile() { const g = this.st.growth; g.sulk = null; g.sulkStrokes = 0; this.h.say('sulkEnd'); this.h.fire && this.h.fire('hearts'); this.h.react && this.h.react('happy'); this._log('reconcile'); if (this.h.care) this.h.care.s.mood = Math.max(this.h.care.s.mood, 60); }
    sulking() { return !!this.st.growth.sulk; }

    // ---- chapters ----
    chapter() {
      const lv = this.h.level ? this.h.level() : 1; let cur = CHAPTERS[0];
      for (const c of CHAPTERS) if (lv >= c.from) cur = c;
      return { ...cur, level: lv, taskDone: cur.task ? this.taskDone(cur.task, cur) : null };
    }
    taskDone(task) {
      const g = this.st.growth;
      switch (task) {
        case 'newAction': return this.learnedCount() > g.learnedBaseline;
        case 'newAction2': return this.learnedCount() >= g.learnedBaseline + 3;
        case 'outfit': return this.hasOutfit();
        case 'care3': return this.careReal().length === 3;
        default: return false;
      }
    }

    _log(kind, what) { const g = this.st.growth; g.log = [...g.log, { t: Math.floor(this.h.now()), kind, what }].slice(-60); }

    /** Everything the notebook window shows. */
    summary() {
      const g = this.st.growth; const m = this.h.manifest || {}; const a = m.actions || {};
      const learned = this.learnedIds(); const standIn = ['eat', 'drink', 'sleep'].filter(id => !(a[id] && a[id].type === 'frames'));
      return {
        day: g.day, coins: g.coins, wishes: g.wishes, finds: g.finds, findPages: g.findPages || 0, journal: g.journal, best: g.best, games: g.games, sulk: g.sulk,
        chapter: this.chapter(), chapters: CHAPTERS, stats: g.stats, learned, standIn,
        expressions: Object.keys((m.layers && m.layers.expressions) || {}), look: (m.lookFollow || {}).mode || 'none', voice: m.voice || {}, outfits: Object.keys((m.outfits && m.outfits.items) || {}),
      };
    }
  }

  global.Growth = Growth;
  global.GROWTH_DEFS = { WISH_POOL, FINDS, FIND_PAGE, CHAPTERS, FIND_MIN_ABSENT, SULK_AFTER_SEC, SULK_STROKES };
})(typeof window !== 'undefined' ? window : globalThis);
