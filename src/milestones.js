// Kapi interaction milestones (v0.8): one table drives "click it 10 times -> bubble tea", "5 strokes -> hearts",
// "5 flowers -> petals". Thresholds come from pet.json.milestones (skill-configurable); the runtime only has defaults.
// Counters, cooldowns and trigger history live in state.json.milestones[id] and survive restarts.
// Pure logic: the host supplies now() and persists state; effects are fired through host.fire(effect, milestone).
(function (global) {
  'use strict';

  const DEFAULTS = [
    { id: 'clickTea',   event: 'click',  count: 10, windowSec: 15, cooldownSec: 0, effect: 'bubbleTea', say: 'clickTea' },
    { id: 'strokeLove', event: 'stroke', count: 5,  windowSec: 0,  cooldownSec: 0, effect: 'hearts',    say: 'strokeLove' },
    { id: 'flowers5',   event: 'flower', count: 5,  windowSec: 0,  cooldownSec: 0,   effect: 'petals',    say: 'garden' },
  ];

  class Milestones {
    /** host: { now() -> seconds, save(state), fire(effect, m), say(key), state (object to mutate: state.milestones) } */
    constructor(defs, host) {
      this.defs = (defs && defs.length ? defs : DEFAULTS).map(d => Object.assign({ windowSec: 0, cooldownSec: 0, count: 1 }, d));
      this.h = host; this.st = host.state; this.st.milestones = this.st.milestones || {};
      for (const d of this.defs) this.st.milestones[d.id] = Object.assign({ times: [], total: 0, lastFired: 0, fired: 0 }, this.st.milestones[d.id] || {});
    }
    /** Record one event; returns the list of milestones that fired now. */
    record(event, n) {
      const t = this.h.now(); const fired = [];
      for (const d of this.defs) {
        if (d.event !== event) continue;
        const s = this.st.milestones[d.id];
        s.total += (n || 1);
        if (d.windowSec > 0) { s.times = s.times.filter(x => t - x < d.windowSec); for (let i = 0; i < (n || 1); i++) s.times.push(t); }
        else { s.times = []; s.pending = (s.pending || 0) + (n || 1); }
        const reached = d.windowSec > 0 ? s.times.length >= d.count : (s.pending || 0) >= d.count;
        const cool = d.cooldownSec > 0 && s.lastFired && t - s.lastFired < d.cooldownSec;
        if (reached && !cool) {
          s.lastFired = t; s.fired += 1; s.times = []; s.pending = 0;
          fired.push(d); this.h.fire(d.effect, d); if (d.say) this.h.say(d.say);
        } else if (reached && cool) {
          // keep the window from re-firing the moment the cooldown ends: reset the burst counter, keep cumulative ones
          if (d.windowSec > 0) s.times = [];
        }
      }
      if (fired.length || event) this.h.save(this.st);
      return fired;
    }
    progress(id) { const d = this.defs.find(x => x.id === id); const s = d && this.st.milestones[d.id]; if (!d || !s) return null; return { have: d.windowSec > 0 ? s.times.length : (s.pending || 0), need: d.count, fired: s.fired }; }
  }

  global.Milestones = Milestones; global.MILESTONE_DEFAULTS = DEFAULTS;
})(typeof window !== 'undefined' ? window : globalThis);
