// Kapi desktop behaviours (v0.4): throw physics, edge cling, hide & peek, walk / come here, perch on the active window,
// typing reactions, low battery, two pets greeting. Pure motion math lives here; main.js supplies window I/O.
(function (global) {
  'use strict';

  const GRAVITY = 2600;        // px/s^2
  const BOUNCE = 0.38;         // velocity kept after bounce
  const FRICTION = 0.85;       // horizontal damping per bounce
  const WALK_SPEED = 130;      // px/s (a real walk cycle plays at this speed too; see engine.setWalking)
  const PEEK_VISIBLE = 0.28;   // fraction of the pet left visible when hiding at an edge

  class Behaviors {
    /**
     * host: { getWin() -> {x,y,w,h}, setWin(x,y), getMonitor() -> {x,y,w,h}, getCursor() -> {x,y},
     *         engine, say(text), expr(name, ms), play(id), line(key), t() }
     */
    constructor(host) {
      this.h = host; this.mode = 'idle'; // idle | fly | cling | peek | walk | perch
      this.v = { x: 0, y: 0 }; this.target = null; this.flip = false; this.lastPerchRect = null;
      this.typing = { count: 0, lastNod: 0, fastStreak: 0, lastBurst: -Infinity, lastTick: 0 }; this.lastLowBattery = 0; this.lastGreet = {};
      this.wanderAt = performance.now() / 1000 + 90 + Math.random() * 120; this.clingUntil = 0;
      this.lifeAt = performance.now() / 1000 + 12 + Math.random() * 15; this.lastLife = '';
    }

    // ---------- 0.8.16 desktop awareness: the user clicking around the screen ----------
    /** A mouse button went down at screen (x, y) (physical px / scale handled by the host). Not on the pet itself. */
    onDesktopClick(button, x, y) {
      const e = this.h.engine; const w = this.h.getWin(); const t = performance.now() / 1000;
      if (!w || e.sleeping || e.drag.active || e.hover) return null;
      this.clicks = (this.clicks || []).filter(c => t - c.t < 1.2); this.clicks.push({ t, x, y });
      const dirs = global.PET_DIRS || ['d000', 'd045', 'd090', 'd135', 'd180', 'd225', 'd270', 'd315'];
      const dx = x - (w.x + w.w / 2), dy = y - (w.y + w.h * 0.25); let ang = Math.atan2(dx, -dy) * 180 / Math.PI; if (ang < 0) ang += 360;
      const dir = dirs[Math.round(ang / 45) % 8];
      // a burst of clicks (double-click, frantic clicking) -> startled; a single click -> a glance that way, only sometimes
      if (this.clicks.length >= 3) { this.clicks = []; if (t - (this.lastStartle || 0) > 12) { this.lastStartle = t; this.h.expr('surprised', 1400); e.play('shiver', global.PET_PRIORITY.random); if (this.h.react) this.h.react('surprise', 0.3); e.lookAlong([dir, 'base'], 1.2); return 'startle'; } return null; }
      if (button === 'right') { if (t - (this.lastGlance || 0) > 3) { this.lastGlance = t; e.lookAlong([dir, 'base'], 1.6); return 'glance'; } return null; }
      if (Math.hypot(dx, dy) < 260) { if (t - (this.lastGlance || 0) > 2) { this.lastGlance = t; e.lookAlong([dir, 'base'], 1.0); return 'glance'; } return null; }   // close by: always look
      if (t - (this.lastGlance || 0) > 6 && Math.random() < 0.45) { this.lastGlance = t; e.lookAlong([dir, 'base'], 1.2); return 'glance'; }
      return null;
    }

    // ---------- 0.8.16 idle life: something small every 15-45 s so the pet never sits like a sticker ----------
    _lifeInterval() {
      const mood = this.h.mood ? this.h.mood() : 70;                        // 0..100; a happy pet fidgets more
      const k = 1.6 - Math.max(0, Math.min(100, mood)) / 100 * 0.8;           // 0.8x (mood 100) .. 1.6x (mood 0)
      return (15 + Math.random() * 30) * k;
    }
    lifeAct() {
      const e = this.h.engine; const m = (e.m && e.m.actions) || {};
      const dirs = global.PET_DIRS || ['d000', 'd045', 'd090', 'd135', 'd180', 'd225', 'd270', 'd315'];
      const learned = Object.keys(m).filter(id => m[id].type === 'frames' && !['eat', 'drink', 'sleep', 'typing', 'walk', 'groom'].includes(id));
      const groom = m.groom && m.groom.type === 'frames';
      const menu = [
        ['lookAround', 24], ['glance', 12], ['stretch', 12], ['tilt', 12], ['wander', 12], ['yawn', 7], ['shiver', 5], ['hop', 5], ['settle', 6], ['learned', learned.length ? 8 : 0],
        ['groom', groom ? 18 : 0],                                        // 0.9.2: a real grooming clip (舔毛 / 理头发) is the most "alive" thing it has
      ].filter(([id]) => id !== this.lastLife);
      const total = menu.reduce((q, x) => q + x[1], 0); let r = Math.random() * total; let pick = menu[0][0];
      for (const [id, w] of menu) { r -= w; if (r <= 0) { pick = id; break; } }
      this.lastLife = pick;
      const cursor = this.h.getCursor(), w = this.h.getWin();
      switch (pick) {
        case 'lookAround': {                                               // a slow look to one side, then the other, back to front
          const a = dirs[2 + Math.floor(Math.random() * 3) * 2];           // d090 / d180 / d270
          const b = a === 'd090' ? 'd270' : a === 'd270' ? 'd090' : (Math.random() < 0.5 ? 'd090' : 'd270');
          if (!e.lookAlong([a, 'base', b, 'base'], 0.8 + Math.random() * 0.5)) this.wander(); break; }
        case 'glance': {                                                   // look where the cursor is, even far away
          if (cursor && w) { const dx = cursor.x - (w.x + w.w / 2), dy = cursor.y - (w.y + w.h * 0.25); let ang = Math.atan2(dx, -dy) * 180 / Math.PI; if (ang < 0) ang += 360;
            e.lookAlong([dirs[Math.round(ang / 45) % 8], 'base'], 1.4); } break; }
        case 'stretch': e.play('stretch', global.PET_PRIORITY.random); this.h.expr('happy', 1200); break;
        case 'tilt': e.play('tilt', global.PET_PRIORITY.random); break;
        case 'wander': this.wander(); break;
        case 'yawn': e.play('yawn', global.PET_PRIORITY.random); this.h.expr('sleepy', 1800); if (this.h.react && Math.random() < 0.4) this.h.react('sleep', 0.3); break;
        case 'shiver': e.play('shiver', global.PET_PRIORITY.random); break;
        case 'hop': e.play('jump', global.PET_PRIORITY.random); if (this.h.react && Math.random() < 0.3) this.h.react('happy', 0.3); break;
        case 'settle': e.play('settle', global.PET_PRIORITY.random); break;
        case 'learned': e.play(learned[Math.floor(Math.random() * learned.length)], global.PET_PRIORITY.random); break;
        case 'groom': e.play('groom', global.PET_PRIORITY.random); if (this.h.react && Math.random() < 0.3) this.h.react('stroke', 0.3); break;
      }
      return pick;
    }

    // ---------- throw ----------
    throwWith(vx, vy) {
      if (Math.hypot(vx, vy) < 350) return false;
      this.mode = 'fly'; this.v = { x: vx * 0.9, y: vy * 0.9 }; this.h.expr('surprised', 1500); return true;
    }

    // ---------- hide / peek ----------
    peek() {
      const w = this.h.getWin(), m = this.h.getMonitor(); if (!w || !m) return;
      const toLeft = (w.x - m.x) < (m.x + m.w - (w.x + w.w));
      this.target = { x: toLeft ? m.x - w.w * (1 - PEEK_VISIBLE) : m.x + m.w - w.w * PEEK_VISIBLE, y: w.y };
      this.mode = 'peek'; this.flip = !toLeft; this.h.say(this.h.line('hide') || this.h.t().beh.hide);
    }
    unpeek() { if (this.mode !== 'peek') return; const m = this.h.getMonitor(), w = this.h.getWin(); this.target = { x: Math.min(Math.max(w.x, m.x), m.x + m.w - w.w), y: w.y }; this.mode = 'walk'; }

    // ---------- walk ----------
    walkTo(x, y) { const w = this.h.getWin(); this.target = { x, y: y ?? w.y }; this.flip = x < w.x; this.mode = 'walk'; }
    comeHere() { const c = this.h.getCursor(), w = this.h.getWin(); if (!c || !w) return; this.walkTo(c.x - w.w / 2, w.y); this.h.say(this.h.line('comeHere') || this.h.t().beh.coming); }
    wander() {
      const w = this.h.getWin(), m = this.h.getMonitor(); if (!w || !m) return;
      const real = this.h.engine.hasWalkCycle && this.h.engine.hasWalkCycle();
      const dx = (Math.random() < 0.5 ? -1 : 1) * (real ? 150 + Math.random() * 350 : 80 + Math.random() * 160);   // a real walker goes farther
      this.walkTo(Math.min(Math.max(w.x + dx, m.x), m.x + m.w - w.w), w.y);
    }

    // ---------- follow the cursor ----------
    setFollow(on) { this.follow = !!on; if (on) { this.mode = 'idle'; this.target = null; this.h.say(this.h.line('follow') || this.h.t().beh.follow); } else if (this.mode === 'walk' && this._followTarget) { this.mode = 'idle'; this.target = null; } this._followTarget = false; }
    _followStep(dt) {
      const c = this.h.getCursor(), w = this.h.getWin(), m = this.h.getMonitor(); if (!c || !w || !m) return null;
      // keep the pet just below-right of the cursor so it never covers what the user is pointing at
      const tx = Math.min(Math.max(c.x + 40, m.x), m.x + m.w - w.w), ty = Math.min(Math.max(c.y - w.h * 0.35, m.y), m.y + m.h - w.h);
      const dx = tx - w.x, dy = ty - w.y, dist = Math.hypot(dx, dy);
      if (dist < 24) { this._followTarget = false; return null; }
      const speed = Math.min(420, 90 + dist * 1.2) * dt;                 // faster when far, gentle when close
      this.flip = dx < 0; this._followTarget = true;
      const bob = (this.h.engine.hasWalkCycle && this.h.engine.hasWalkCycle()) ? 0 : Math.sin(performance.now() / 90) * 3;
      return { x: w.x + dx / dist * Math.min(speed, dist), y: w.y + dy / dist * Math.min(speed, dist) + bob, rot: 0, flip: this.flip, walking: true };
    }

    // ---------- perch on active window ----------
    setPerch(on) {
      this.mode = on ? 'perch' : 'idle'; this.lastPerchRect = null; this._perchMove = false; this.target = null;
      this.perchSince = on ? performance.now() / 1000 : 0; this.perchHinted = false; this.perchedOnce = false;
      if (on) this.h.say(this.h.line('perch') || this.h.t().beh.perch);
    }
    /**
     * Sit on the top-right corner of `rect` (logical px). Maximised / full-height windows (top edge at or above the
     * monitor top, so the pet would be pushed off-screen) are handled by sitting *inside* the corner instead.
     * Returns true when a new target was set.
     */
    perchOn(rect, petFootY, petW) {
      if (!rect || rect.w < 200 || rect.h < 80) return false;
      const key = `${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.w)}`;
      if (this.lastPerchRect === key) return false; this.lastPerchRect = key;
      const w = this.h.getWin(), m = this.h.getMonitor() || { x: -1e9, y: -1e9, w: 2e9, h: 2e9 };
      let x = rect.x + rect.w - petW - 24; let y = rect.y - petFootY;
      if (y < m.y) y = Math.max(m.y, rect.y);                                   // maximised: sit inside the corner
      x = Math.min(Math.max(x, m.x), m.x + m.w - petW);
      y = Math.min(y, m.y + m.h - petFootY);
      this.target = { x, y }; this.flip = x < w.x; this._perchMove = true; if (!this.perchedOnce && this.h.sfx) this.h.sfx('knock', 0.35); this.perchedOnce = true; return true;
    }
    /** Called by the host every poll while in perch mode and no window has been found yet: hint once after 3s. */
    perchNoWindow() {
      if (this.mode !== 'perch' || this.perchedOnce || this.perchHinted) return;
      if (performance.now() / 1000 - this.perchSince > 3) { this.perchHinted = true; this.h.say(this.h.line('perchHint') || this.h.t().beh.perchHint); }
    }

    // ---------- typing / battery / greeting ----------
    onTyping(keys) {
      const t = performance.now() / 1000; this.typing.count += keys;
      if (t - this.typing.lastTick > 1.6) this.typing.fastStreak = 0;
      this.typing.lastTick = t;
      this.typing.fastStreak = keys >= 6 ? this.typing.fastStreak + 1 : 0;
      if (this.typing.fastStreak >= 2 && t - this.typing.lastBurst >= 8 && !this.h.engine.sleeping) {
        this.typing.lastBurst = t;
        this.h.expr('surprised', 1200);
        this.h.play('shake'); if (this.h.react) this.h.react('surprise');
        const line = this.h.line('typingFast'); if (line) this.h.say(line);
      }
      // One detected press is enough: the 80ms global-input poll can miss fast press/release pairs.
      // The engine supplies a visible procedural typing nod when the pet has no dedicated typing action.
      if (keys > 0 && t - this.typing.lastNod >= 1.5 && !this.h.engine.sleeping && this.h.engine.state.action === 'idle') {
        const acts = (this.h.engine.m && this.h.engine.m.actions) || {};
        const action = acts.typing ? 'typing' : (acts.nod ? 'nod' : null);
        if (action && this.h.engine.play(action, global.PET_PRIORITY.random)) { this.typing.lastNod = t; if (this.h.react) this.h.react('typing', 0.28); }   // 0.8.15: a soft note with every nod
      }
      if (this.typing.count > 400) { this.typing.count = 0; this.h.say(this.h.line('typingLong') || this.h.t().beh.typingLong); }
    }
    onBattery(info) {
      if (!info) return; const t = performance.now() / 1000;
      if (info.percent <= 20 && !info.charging && t - this.lastLowBattery > 900) { this.lastLowBattery = t; this.h.expr('surprised', 2500); if (this.h.react) this.h.react('whine'); this.h.say((this.h.line('lowBattery') || this.h.t().beh.lowBattery).replace('{p}', Math.round(info.percent)), true); }
    }
    onOtherPet(id, rect, name) {
      const w = this.h.getWin(); if (!w || !rect) return;
      const overlap = !(rect.x > w.x + w.w || rect.x + rect.w < w.x); const t = performance.now() / 1000;
      if (overlap && t - (this.lastGreet[id] || -1e9) > 300) { this.lastGreet[id] = t; this.h.expr('happy', 2500); if (this.h.react) this.h.react('greet'); this.h.say((this.h.line('greet') || this.h.t().beh.greet).replace('{name}', name || '')); this.h.play('wave'); }
    }

    // ---------- per-frame motion; returns {x,y,rot,flip} or null when nothing to move ----------
    step(dt) {
      const w = this.h.getWin(), m = this.h.getMonitor(); if (!w || !m) return null;
      if (this.follow && this.mode === 'idle' && !this.h.engine.hover && !this.h.engine.sleeping) { const r = this._followStep(dt); if (r) return r; }
      if (this.mode === 'fly') {
        this.v.y += GRAVITY * dt; let x = w.x + this.v.x * dt, y = w.y + this.v.y * dt;
        const floor = m.y + m.h - w.h + 0; let bounced = false;
        if (y >= floor) { y = floor; this.v.y = -this.v.y * BOUNCE; this.v.x *= FRICTION; bounced = true; if (Math.abs(this.v.y) < 120) { this.v.y = 0; } }
        if (x <= m.x - w.w * 0.6) { x = m.x - w.w * 0.6; this.v.x = -this.v.x * BOUNCE; }
        if (x >= m.x + m.w - w.w * 0.4) { x = m.x + m.w - w.w * 0.4; this.v.x = -this.v.x * BOUNCE; }
        const settled = this.v.y === 0 && Math.abs(this.v.x) < 20 && y >= floor - 1;
        if (settled) { this.mode = 'idle'; this.v = { x: 0, y: 0 }; this.h.play('drop'); this.h.expr('angry', 2000); if (this.h.sfx) this.h.sfx('thud', 0.5); if (this.h.react) this.h.react('drop'); this.h.say(this.h.line('thrown') || this.h.t().beh.thrown); return { x, y: floor, rot: 0, flip: this.flip, landed: true }; }
        if (bounced && Math.abs(this.v.y) > 200) { this.h.play('drop'); if (this.h.sfx) this.h.sfx('thud', 0.3); }
        const rot = Math.max(-25, Math.min(25, this.v.x * 0.02));
        return { x, y, rot, flip: this.flip };
      }
      if (this.mode === 'walk' || this.mode === 'peek' || this._perchMove) {
        if (!this.target) { this.mode = this.mode === 'perch' ? 'perch' : 'idle'; return null; }
        const dx = this.target.x - w.x, dy = this.target.y - w.y; const dist = Math.hypot(dx, dy);
        const sp = (this.mode === 'peek' ? 260 : WALK_SPEED) * dt;
        if (dist <= sp) { const t = this.target; this.target = null; const done = this.mode; if (this.mode === 'walk') this.mode = 'idle'; this._perchMove = false; return { x: t.x, y: t.y, rot: 0, flip: this.flip, arrived: done }; }
        const bob = (this.h.engine.hasWalkCycle && this.h.engine.hasWalkCycle()) ? 0 : Math.sin(performance.now() / 90) * 3;   // real frames carry their own motion
        return { x: w.x + dx / dist * sp, y: w.y + dy / dist * sp + (this.mode === 'walk' ? bob : 0), rot: 0, flip: this.flip, walking: true };
      }
      if (this.mode === 'idle' && performance.now() / 1000 > this.lifeAt) {
        const t = performance.now() / 1000; this.lifeAt = t + this._lifeInterval();
        const e = this.h.engine;
        if (!e.hover && e.state.action === 'idle' && !e.sleeping && !e.drag.active && !(this.h.busy && this.h.busy()) && !e.lookScript) this.lifeAct();
      }
      if (this.mode === 'idle' && performance.now() / 1000 > this.wanderAt) {
        const real = this.h.engine.hasWalkCycle && this.h.engine.hasWalkCycle();
        this.wanderAt = performance.now() / 1000 + (real ? 60 + Math.random() * 90 : 180 + Math.random() * 240);   // a pet that can really walk strolls every 1-2.5 min
        if (!this.h.engine.hover && this.h.engine.state.action === 'idle' && !this.h.engine.sleeping && Math.random() < 0.5) this.wander();
      }
      // edge cling: pet mostly off-screen after a drag
      if (this.mode === 'cling') {
        if (performance.now() / 1000 > this.clingUntil) { const x = Math.min(Math.max(w.x, m.x), m.x + m.w - w.w); this.mode = 'walk'; this.target = { x, y: w.y }; this.flip = x < w.x; if (this.h.react) this.h.react('happy'); this.h.say(this.h.line('climbBack') || this.h.t().beh.climbBack); }
        return null;
      }
      return null;
    }
    checkEdgeAfterDrag() {
      const w = this.h.getWin(), m = this.h.getMonitor(); if (!w || !m) return false;
      const offL = m.x - w.x, offR = (w.x + w.w) - (m.x + m.w);
      if (offL > w.w * 0.35 || offR > w.w * 0.35) { this.mode = 'cling'; this.clingUntil = performance.now() / 1000 + 4; this.h.expr('surprised', 2000); if (this.h.sfx) this.h.sfx('knock', 0.4); if (this.h.react) this.h.react('surprise'); this.h.say(this.h.line('cling') || this.h.t().beh.cling); return true; }
      return false;
    }
  }

  global.Behaviors = Behaviors;
})(typeof window !== 'undefined' ? window : globalThis);
