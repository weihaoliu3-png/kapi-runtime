// Kapi typing garden (v0.8): typing grows a flower on the pet's head; the pet picks it and keeps it beside itself.
// Growth follows typing rate (key counts only, never text); pausing pauses, never regresses.
// Stages are growth units, accelerated by faster typing.
// Picked flowers accumulate in state.garden.flowers (shown up to `showMax` beside the pet) and feed the 'flower' milestone.
// Pure logic + drawing helpers; the host persists state and supplies prop images when the skill generated them.
(function (global) {
  'use strict';

  const DEFAULTS = { stagesSec: [8, 25, 50, 90], showMax: 5, style: 'daisy', color: '#ff7aa2', idleGapSec: 2 };

  class Garden {
    /** host: { now() -> seconds, save(state), onPick(flower), say(key), state } ; cfg = pet.json.garden */
    constructor(cfg, host) {
      this.cfg = Object.assign({}, DEFAULTS, cfg || {}); this.h = host; this.st = host.state;
      this.st.garden = Object.assign({ growthSec: 0, stage: 0, flowers: [], picked: 0 }, this.st.garden || {});
      this._lastTick = 0; this._pickAnim = null;
    }
    /** Host calls this once per second with the number of key presses seen in that second. */
    onTypingSecond(keys) {
      if (!keys || keys <= 0) return;
      const g = this.st.garden; const t = this.h.now();
      // one active second per real second, even if the host reports faster
      if (t - this._lastTick < 0.9) return; this._lastTick = t;
      // 1-2 keys/s: 1 unit; 3-5: 2 units; 6+: 3 units.
      g.growthSec += keys >= 6 ? 3 : keys >= 3 ? 2 : 1;
      const before = g.stage; g.stage = this.stageFor(g.growthSec);
      if (g.stage !== before) {
        if (g.stage === 1) { if (this.h.sfx) this.h.sfx('pop', 0.4); this.h.say('flowerBud'); } else if (g.stage === 2) { if (this.h.sfx) this.h.sfx('bloom', 0.4); if (this.h.react) this.h.react('happy'); this.h.say('flowerBloom'); }   // 0.8.15: each stage sounds
        if (g.stage >= 4) this.pick();
      }
      if (g.growthSec % 10 === 0 || g.stage !== before) this.h.save(this.st);
    }
    stageFor(sec) { const s = this.cfg.stagesSec; let k = 0; for (let i = 0; i < s.length; i++) if (sec >= s[i]) k = i + 1; return k; }
    /** Stage 4 reached: the flower moves from the head to the ground, a new bud cycle starts. */
    pick() {
      const g = this.st.garden; const t = this.h.now();
      const flower = { at: t, style: this.cfg.style, color: this.cfg.color };
      g.flowers.push(flower); g.picked += 1; g.growthSec = 0; g.stage = 0;
      this._pickAnim = { t0: t, dur: 1.2 };
      if (this.h.sfx) this.h.sfx('pluck', 0.5); this.h.say('flowerPick'); this.h.onPick(flower); this.h.save(this.st);
    }
    /** Drawing data for the host: head flower (stage 0 = none) and ground flowers; `pickAnim` 0..1 while a flower falls. */
    view() {
      const g = this.st.garden; const t = this.h.now();
      let pickAnim = null;
      if (this._pickAnim) { const k = (t - this._pickAnim.t0) / this._pickAnim.dur; if (k >= 1) this._pickAnim = null; else pickAnim = k; }
      return { headStage: Math.min(3, g.stage), ground: g.flowers.slice(-this.cfg.showMax), total: g.flowers.length, pickAnim, growthSec: g.growthSec, nextAt: this.cfg.stagesSec[Math.min(g.stage, 3)] };
    }
  }

  /** Procedural flower (used when the pet package has no props/flower_N.png). size = px of the head; stage 1..3. */
  function drawFlower(ctx, x, y, size, stage, color) {
    const s = size * (stage === 1 ? 0.45 : stage === 2 ? 0.7 : 1.0);
    ctx.save(); ctx.translate(x, y);
    ctx.strokeStyle = '#4caf50'; ctx.lineWidth = Math.max(2, s * 0.08); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, s * 0.5); ctx.quadraticCurveTo(s * 0.05, s * 0.2, 0, 0); ctx.stroke();           // stem
    ctx.fillStyle = '#66bb6a'; ctx.beginPath(); ctx.ellipse(-s * 0.12, s * 0.32, s * 0.12, s * 0.05, -0.6, 0, Math.PI * 2); ctx.fill();   // leaf
    if (stage === 1) { ctx.fillStyle = '#8bc34a'; ctx.beginPath(); ctx.ellipse(0, -s * 0.05, s * 0.14, s * 0.2, 0, 0, Math.PI * 2); ctx.fill(); }
    else {
      const petals = stage === 2 ? 5 : 7, r = s * (stage === 2 ? 0.17 : 0.22);
      ctx.fillStyle = color || '#ff7aa2';
      for (let i = 0; i < petals; i++) { const a = i / petals * Math.PI * 2; ctx.beginPath(); ctx.ellipse(Math.cos(a) * r, -s * 0.05 + Math.sin(a) * r, r * 0.75, r * 0.45, a, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = '#ffd54f'; ctx.beginPath(); ctx.arc(0, -s * 0.05, r * 0.55, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  global.Garden = Garden; global.GARDEN_DEFAULTS = DEFAULTS; global.drawFlower = drawFlower;
})(typeof window !== 'undefined' ? window : globalThis);
