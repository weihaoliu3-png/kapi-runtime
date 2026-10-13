// Kapi rules (0.9.3): the pet package describes its own behaviour — "when X happens, do Y" — so a user's idea
// ("when I open Excel it yawns", "at 18:00 it holds up a sign", "when I drop a picture on it it dances") becomes
// pet.json data instead of a runtime rebuild. Pure logic; main.js supplies the host that actually plays / says / moves.
//
// pet.json.rules: [ { id, when, match?, if?, chance?, cooldownSec?, do: [ step, … ] } ]
//   when  : click clickMany stroke dragStart dragEnd landed typing typingFast typingLong idle time app fileDrop
//           desktopClick lowBattery hungry thirsty tired lonely levelUp wishDone sulk greet wake sleep hourly start
//   match : { app: "excel|word" (regex on the foreground app name / window title, for `app`),
//             ext: ["png","jpg"] (for `fileDrop`), time: "18:00" (for `time`), days: [1,2,3,4,5] (0=Sun),
//             hour: [9, 18] (any event: only between these hours), minutes: 30 (for `idle`: minutes without input),
//             count: 10 (clickMany: at least this many clicks) }
//   if    : { moodBelow, moodAbove, levelMin, levelMax, sleeping (true/false), species, flag: "name", notFlag: "name" }
//   chance: 0..1 (default 1)      cooldownSec: default 60 (time/app rules: 3600; start: once per run)
//   do    : { play: "dance" } | { say: "text" } | { say: { line: "lineKey" } } | { expr: "happy", ms: 2000 } |
//           { effect: "hearts" } | { sound: "chime" } | { react: "happy" } | { look: "d090" } | { walk: "cursor|left|right|random|edge" } |
//           { hide: true } | { come: true } | { mood: 5 } | { flag: "name", value: true } | { wait: 800 } | { toast: "text" }
// Unknown events / steps are ignored (an old runtime simply does less); the skill's validator rejects them before delivery.
(function (global) {
  'use strict';

  const EVENTS = ['click', 'clickMany', 'stroke', 'dragStart', 'dragEnd', 'landed', 'typing', 'typingFast', 'typingLong', 'idle', 'time', 'app', 'fileDrop',
    'desktopClick', 'lowBattery', 'hungry', 'thirsty', 'tired', 'lonely', 'levelUp', 'wishDone', 'sulk', 'greet', 'wake', 'sleep', 'hourly', 'start'];
  const STEPS = ['play', 'say', 'expr', 'effect', 'sound', 'react', 'look', 'walk', 'hide', 'come', 'mood', 'flag', 'wait', 'toast'];
  const DEFAULT_COOLDOWN = { time: 3600, app: 3600, hourly: 3000, start: 1e9, idle: 600 };

  class Rules {
    /** host: { now() -> sec, play(id), say(text, sticky), line(key), expr(name, ms), effect(id), sound(name), react(kind),
     *          look(dir), walk(where), hide(), come(), mood(delta), toast(text), state (object: state.rules = {fired, flags}),
     *          care() -> {mood, level, sleeping} | null, species() -> string|null, save() } */
    constructor(rules, host) {
      this.h = host; this.rules = Array.isArray(rules) ? rules.filter(r => r && typeof r === 'object' && EVENTS.includes(r.when) && Array.isArray(r.do)) : [];
      const st = host.state || {}; st.rules = st.rules || { fired: {}, flags: {} }; this.st = st.rules;
      this._running = 0; this._lastApp = null;
    }
    flags() { return this.st.flags; }
    /** Fire an event with a context ({app, title, ext, clicks, minutes, …}); returns the ids of the rules that ran. */
    fire(event, ctx) {
      ctx = ctx || {}; const ran = []; const now = this.h.now();
      for (const r of this.rules) {
        if (r.when !== event) continue;
        if (!this._matches(r, event, ctx, now)) continue;
        const cd = r.cooldownSec != null ? r.cooldownSec : (DEFAULT_COOLDOWN[event] || 60);
        const key = r.id || (event + ':' + this.rules.indexOf(r));
        if (now - (this.st.fired[key] || -1e9) < cd) continue;
        if (r.chance != null && Math.random() > r.chance) continue;
        this.st.fired[key] = now; ran.push(key);
        this._run(r.do.slice());
      }
      if (ran.length && this.h.save) this.h.save();
      return ran;
    }
    _matches(r, event, ctx, now) {
      const m = r.match || {}; const c = r.if || {};
      const d = new Date(now * 1000);
      if (m.hour && !(d.getHours() >= m.hour[0] && d.getHours() < m.hour[1])) return false;
      if (m.days && !m.days.includes(d.getDay())) return false;
      if (event === 'time') { const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; if (m.time !== hhmm) return false; }
      if (event === 'app') {
        if (!m.app) return false;
        let re; try { re = new RegExp(m.app, 'i'); } catch (_) { return false; }
        const hay = `${ctx.app || ''} ${ctx.title || ''}`;
        if (!re.test(hay)) return false;
        if (ctx.sameAsLast) return false;                                   // only when the foreground app changes to a match
      }
      if (event === 'fileDrop' && m.ext && !(m.ext.map(x => String(x).toLowerCase().replace(/^\./, '')).includes(String(ctx.ext || '').toLowerCase()))) return false;
      if (event === 'idle' && m.minutes && !((ctx.minutes || 0) >= m.minutes)) return false;
      if (event === 'clickMany' && m.count && !((ctx.clicks || 0) >= m.count)) return false;
      const care = this.h.care ? this.h.care() : null;
      if (c.moodBelow != null && !(care && care.mood < c.moodBelow)) return false;
      if (c.moodAbove != null && !(care && care.mood > c.moodAbove)) return false;
      if (c.levelMin != null && !(care && care.level >= c.levelMin)) return false;
      if (c.levelMax != null && !(care && care.level <= c.levelMax)) return false;
      if (c.sleeping != null && !!(care && care.sleeping) !== !!c.sleeping) return false;
      if (c.species && (this.h.species ? this.h.species() : null) !== c.species) return false;
      if (c.flag && !this.st.flags[c.flag]) return false;
      if (c.notFlag && this.st.flags[c.notFlag]) return false;
      return true;
    }
    _run(steps) {
      const h = this.h; const self = this;
      function next() {
        const s = steps.shift(); if (!s || typeof s !== 'object') return;
        try {
          if (s.wait != null) { setTimeout(next, Math.max(0, Number(s.wait) || 0)); return; }
          if (s.play != null) h.play(String(s.play));
          else if (s.say != null) { const txt = typeof s.say === 'object' ? (s.say.line ? h.line(s.say.line) : null) : String(s.say); if (txt) h.say(txt, !!s.sticky); }
          else if (s.expr != null) h.expr(String(s.expr), s.ms || 2000);
          else if (s.effect != null) h.effect(String(s.effect));
          else if (s.sound != null) h.sound(String(s.sound));
          else if (s.react != null) h.react(String(s.react));
          else if (s.look != null) h.look(String(s.look));
          else if (s.walk != null) h.walk(String(s.walk));
          else if (s.hide) h.hide();
          else if (s.come) h.come();
          else if (s.mood != null) h.mood(Number(s.mood) || 0);
          else if (s.flag != null) { self.st.flags[String(s.flag)] = s.value == null ? true : s.value; }
          else if (s.toast != null) h.toast(String(s.toast));
        } catch (_) {}
        next();
      }
      next();
    }
    /** Validation helper (also used by the skill's validator through node): [] when fine, else messages. */
    static validate(rules, manifest) {
      const out = []; if (rules == null) return out;
      if (!Array.isArray(rules)) return ['rules must be an array'];
      rules.forEach((r, i) => {
        const tag = `rules[${i}]${r && r.id ? ' (' + r.id + ')' : ''}`;
        if (!r || typeof r !== 'object') { out.push(`${tag}: must be an object`); return; }
        if (!EVENTS.includes(r.when)) out.push(`${tag}: when must be one of ${EVENTS.join(', ')}`);
        if (!Array.isArray(r.do) || !r.do.length) out.push(`${tag}: do must be a non-empty array`);
        else r.do.forEach((s, j) => {
          const keys = Object.keys(s || {}).filter(k => STEPS.includes(k));
          if (!keys.length) out.push(`${tag}.do[${j}]: unknown step (use ${STEPS.join(' / ')})`);
          if (s && s.play != null && manifest && manifest.actions && !manifest.actions[s.play]) out.push(`${tag}.do[${j}]: action '${s.play}' not in actions`);
          if (s && s.say && typeof s.say === 'object' && s.say.line && manifest && manifest.__lines && !manifest.__lines[s.say.line]) out.push(`${tag}.do[${j}]: line '${s.say.line}' not in persona.lines`);
        });
        if (r.when === 'time' && !(r.match && /^\d{2}:\d{2}$/.test(r.match.time || ''))) out.push(`${tag}: time rules need match.time "HH:MM"`);
        if (r.when === 'app' && !(r.match && r.match.app)) out.push(`${tag}: app rules need match.app (regex)`);
      });
      return out;
    }
  }

  global.KapiRules = Rules; global.KAPI_RULE_EVENTS = EVENTS; global.KAPI_RULE_STEPS = STEPS;
})(typeof window !== 'undefined' ? window : globalThis);
