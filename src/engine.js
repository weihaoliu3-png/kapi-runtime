// Kapi engine: pet-package interpretation, animation state machine, rendering.
// Runtime-agnostic (no Tauri calls) so it can be unit-tested in Node with a fake canvas.
(function (global) {
  'use strict';

  const PROCEDURAL = {
    breathe: (t) => ({ sy: 1 + 0.012 * Math.sin(t * 2 * Math.PI / 3.2) }),          // 3.2s cycle
    sway:    (t, ctx) => ({ rot: Math.max(-6, Math.min(6, (ctx.dragVX || 0) * -0.04)) }),
    bounce:  (t) => { const p = Math.min(1, t / 0.5); const s = 1 - 0.12 * Math.sin(p * Math.PI); return { sy: s, sx: 2 - s, done: p >= 1 }; },
    nod:     (t) => { const p = Math.min(1, t / 0.7); return { dy: 6 * Math.abs(Math.sin(p * Math.PI * 2)), done: p >= 1 }; },
    shake:   (t) => { const p = Math.min(1, t / 0.6); return { dx: 8 * Math.sin(p * Math.PI * 4), done: p >= 1 }; },
    jump:    (t) => { const p = Math.min(1, t / 0.6); return { dy: -40 * Math.sin(p * Math.PI), done: p >= 1 }; },
    wiggle:  (t) => { const p = Math.min(1, t / 0.8); return { rot: 4 * Math.sin(p * Math.PI * 6), done: p >= 1 }; },
    typing:  (t) => { const p = Math.min(1, t / 0.7); return { dy: 14 * Math.abs(Math.sin(p * Math.PI * 2)), rot: 3 * Math.sin(p * Math.PI * 2), done: p >= 1 }; },
    dragWiggle: (t) => ({ dx: 4 * Math.sin(t * 19) }),                                   // the struggle; the swing itself is the pendulum (0.8.13)
    stagger: (t) => { const p = Math.min(1, t / 1.6); const e = Math.exp(-t * 1.5); return { rot: 10 * Math.sin(t * 9) * e, dx: 8 * Math.sin(t * 6) * e, done: p >= 1 }; },   // dizzy after a hard shake
    // care fallbacks (used only when the pet has no eat / drink / sleep frames)
    eat:     (t) => { const D = 2.6; const p = Math.min(1, t / D); const chew = t > 1.1 && t < 2.2 ? 4 * Math.abs(Math.sin((t - 1.1) * Math.PI * 4)) : 0;
                      return { dy: chew, overlay: { icon: '🍙', from: [-0.35, 0.55], to: [0.08, 0.28], at: Math.min(1, t / 1.0), hide: t > 2.2 }, done: p >= 1 }; },
    drink:   (t) => { const D = 2.6; const p = Math.min(1, t / D); const tilt = t > 1.0 && t < 2.1 ? -6 : 0;
                      return { rot: tilt, overlay: { icon: '💧', from: [0.3, 0.55], to: [0.06, 0.26], at: Math.min(1, t / 1.0), hide: t > 2.1 }, done: p >= 1 }; },
    slump:   (t) => ({ dy: 14 * Math.min(1, t / 0.8), rot: -6 * Math.min(1, t / 0.8), zzz: true }),
    // 0.8.16 "alive" idle moves: small whole-body motions the life scheduler (behaviors.js) sprinkles between events
    stretch: (t) => { const D = 1.6; const p = Math.min(1, t / D); const up = Math.sin(Math.min(1, p / 0.45) * Math.PI / 2); const down = p > 0.6 ? (p - 0.6) / 0.4 : 0;
                      return { sy: 1 + 0.07 * up - 0.03 * down, sx: 1 - 0.03 * up + 0.015 * down, dy: -4 * up, done: p >= 1 }; },
    tilt:    (t) => { const D = 1.8; const p = Math.min(1, t / D); const e = p < 0.25 ? p / 0.25 : p > 0.75 ? (1 - p) / 0.25 : 1; return { rot: 7 * e, done: p >= 1 }; },
    shiver:  (t) => { const p = Math.min(1, t / 0.5); return { dx: 2.5 * Math.sin(p * Math.PI * 14), rot: 1.5 * Math.sin(p * Math.PI * 14), done: p >= 1 }; },
    yawn:    (t) => { const D = 1.7; const p = Math.min(1, t / D); const o = Math.sin(p * Math.PI); return { sy: 1 + 0.04 * o, dy: -3 * o, rot: -2 * o, done: p >= 1 }; },
    settle:  (t) => { const p = Math.min(1, t / 0.7); const q = Math.sin(p * Math.PI); return { sy: 1 - 0.06 * q, sx: 1 + 0.04 * q, dy: 3 * q, done: p >= 1 }; },
  };
  const LIFE_PRESETS = ['stretch', 'tilt', 'shiver', 'yawn', 'settle', 'jump'];
  const DIRS = ['d000', 'd045', 'd090', 'd135', 'd180', 'd225', 'd270', 'd315'];
  const PRIORITY = { drag: 100, user: 80, chat: 60, sleep: 40, random: 20, idle: 0 };

  class PetEngine {
    /**
     * @param {object} pkg  {manifest, persona, images: {base, blink, look:{d000..}, actions:{id:[img]}}}
     * @param {object} opts {onSay(text, sticky), onReact(event, lineKey) (0.8.12: wordless reaction first, line sometimes), onAction(id), now()}
     */
    constructor(pkg, opts) {
      this.m = pkg.manifest; this.p = pkg.persona; this.img = pkg.images; this.opts = opts || {};
      this.now = this.opts.now || (() => performance.now() / 1000);
      this.canvasW = this.m.render.canvas[0]; this.canvasH = this.m.render.canvas[1];
      if (!this.m.actions.typing) this.m.actions.typing = { type: 'procedural', preset: 'typing' };
      for (const id of LIFE_PRESETS) if (!this.m.actions[id]) this.m.actions[id] = { type: 'procedural', preset: id, builtin: true };   // 0.8.16 idle life
      this.flip = false; this.extraRot = 0;
      this.state = { action: 'idle', prio: PRIORITY.idle, t0: this.now(), seqIdx: 0, frameT0: this.now(), loopsDone: 0, waking: false };
      this.look = { target: 'base', current: 'base', fadeFrom: null, fadeT0: 0, lastChange: -Infinity, sectorIdx: -1 };
      this.lookScript = null;                 // 0.8.16: a scripted glance ({dirs, i, next, hold}) that drives the look while the cursor is far away
      this.expr = { name: null, until: 0 };   // temporary expression frame (happy / surprised / sleepy)
      this.sleeping = false;                  // care system: sleeping keeps eyes closed and blocks random actions
      this.blink = { until: 0, next: this.now() + 3 + Math.random() * 4 };
      // 0.8.13 drag physics: the pet hangs from the grab point like a pendulum (angle about the grab, driven by gravity
      // and the hand's acceleration), and counts hard direction reversals -> dizzy
      this.drag = { active: false, vx: 0, vy: 0, ax: 0, ay: 0, grab: null, ang: 0, angV: 0, shaken: false, dizzy: false, revs: [], lastVx: 0, lastT: 0 };
      this.dizzyUntil = 0;
      this.lastInput = this.now(); this.lastRandom = this.now(); this.nextRandomIn = this._randIn();
      this.cooldown = {}; this.clickTimes = [];
      this.transitionFrom = null; this.transitionT0 = 0;
    }

    _randIn() { const [a, b] = this.m.triggers.idleRandomEverySec || [40, 120]; return a + Math.random() * (b - a); }

    // ---------- public API used by main.js ----------
    /** 0.8.16: look along `dirs` (['d270','d225','base', …]) holding each `holdSec`; the cursor coming near cancels it. */
    lookAlong(dirs, holdSec) { if (this.sleeping || !this.img.look || this.lookEnabled === false) return false; this.lookScript = { dirs: dirs.slice(), i: 0, next: this.now() + (holdSec || 0.9), hold: holdSec || 0.9 }; return true; }
    _scriptedVector(dx, dy, lf) {
      const sc = this.lookScript; if (!sc) return null;
      const rr = lf.radiusPx || 600; const t = this.now();
      if (Math.hypot(dx, dy) < rr * 0.5 || this.hover || this.drag.active) { this.lookScript = null; return null; }   // the real cursor wins
      if (t >= sc.next) { sc.i += 1; sc.next = t + sc.hold; }
      if (sc.i >= sc.dirs.length) { this.lookScript = null; return { dx: 0, dy: 0 }; }
      const d = sc.dirs[Math.min(sc.i, sc.dirs.length - 1)]; const k = DIRS.indexOf(d);
      if (k < 0) return { dx: 0, dy: 0 };
      const a = k * Math.PI / 4; return { dx: Math.sin(a) * rr * 0.4, dy: -Math.cos(a) * rr * 0.4 };
    }
    setLookVector(dx, dy) {
      if (this.lookEnabled === false) return;
      const lf = this.m.lookFollow || {};
      const sv = this._scriptedVector(dx, dy, lf); if (sv) { dx = sv.dx; dy = sv.dy; }
      if (lf.mode === 'ring') return this._setLookRing(dx, dy, lf);
      if (lf.mode !== 'frames8') return;
      if (this.sleeping) return;
      const len = Math.hypot(dx, dy); let target = 'base';
      const rr = lf.radiusPx || 600;
      this.lookVec = { x: Math.max(-1, Math.min(1, dx / rr)), y: Math.max(-1, Math.min(1, dy / rr)) };
      const dz = lf.deadzonePx || 60;
      // hysteresis on the deadzone: need to go 25% beyond to leave base, 25% inside to return
      const leavingBase = this.look.current === 'base' ? len >= dz * 1.25 : len >= dz * 0.75;
      if (leavingBase) {
        let ang = Math.atan2(dx, -dy) * 180 / Math.PI; if (ang < 0) ang += 360;      // 0 = up, clockwise
        let idx = Math.round(ang / 45) % 8;
        // hysteresis on sector edges: stay in the current sector unless we are > 8° past its border
        if (this.look.sectorIdx >= 0 && idx !== this.look.sectorIdx) {
          const center = this.look.sectorIdx * 45; let d = ((ang - center) % 360 + 540) % 360 - 180;
          if (Math.abs(d) < 22.5 + 8) idx = this.look.sectorIdx;
        }
        target = DIRS[idx];
        if (!this.img.look || !this.img.look[target]) target = 'base'; else this.look.sectorIdx = idx;
      } else this.look.sectorIdx = -1;
      const t = this.now();
      if (target !== this.look.target && t - this.look.lastChange >= (lf.holdMs || 80) / 1000) {
        // never jump over a direction: a fast cursor that crossed several sectors is followed one neighbour per hold,
        // along the shorter way round, so every change is an adjacent-frame crossfade (base <-> any direction is direct)
        let next = target;
        const ci = DIRS.indexOf(this.look.current), ti = DIRS.indexOf(target);
        if (ci >= 0 && ti >= 0 && ci !== ti) {
          let d = ((ti - ci) % 8 + 8) % 8; if (d > 4) d -= 8;                 // -3..4 steps, shortest way
          next = DIRS[(ci + Math.sign(d) + 8) % 8];
          if (!this.img.look || !this.img.look[next]) next = target;
        }
        this.look.fadeFrom = this.look.current; this.look.fadeT0 = t;
        this.look.target = next; this.look.current = next; this.look.lastChange = t;
      }
    }

    /** Ring mode: continuous angle -> frame index; adjacent frames differ little so short crossfades read as motion. */
    _setLookRing(dx, dy, lf) {
      if (this.sleeping) return;
      const n = this.img.ring ? this.img.ring.length : 0; if (!n) return;
      const len = Math.hypot(dx, dy); const dz = lf.deadzonePx || 60; const rr = lf.radiusPx || 600;
      this.lookVec = { x: Math.max(-1, Math.min(1, dx / rr)), y: Math.max(-1, Math.min(1, dy / rr)) };
      const inside = this.look.current === 'base' ? len < dz * 1.25 : len < dz * 0.75;
      let target = 'base';
      if (!inside) {
        let ang = Math.atan2(dx, -dy) * 180 / Math.PI; if (ang < 0) ang += 360;
        // smooth the angle so the index does not jitter between neighbours
        if (this._ringAng === undefined) this._ringAng = ang;
        let d = ((ang - this._ringAng) % 360 + 540) % 360 - 180; this._ringAng = (this._ringAng + d * 0.35 + 360) % 360;
        target = 'r' + (Math.round(this._ringAng / 360 * n) % n);
      }
      const t = this.now();
      if (target !== this.look.target && t - this.look.lastChange >= (lf.holdMs || 60) / 1000) {
        this.look.fadeFrom = this.look.current; this.look.fadeT0 = t;
        this.look.target = target; this.look.current = target; this.look.lastChange = t;
      }
    }
    _lookImg(name) {
      if (name === 'base') return this.img.base;
      if (name[0] === 'r' && this.img.ring) return this.img.ring[+name.slice(1)] || this.img.base;
      return (this.img.look && this.img.look[name]) || this.img.base;
    }

    play(id, prio) {
      if (id === 'stagger' && !this.m.actions.stagger) this.m.actions.stagger = { type: 'procedural', preset: 'stagger' };   // runtime-only, never in a pack
      const a = this.m.actions[id]; if (!a) return false;
      // 0.9.4: a cycle action (walk) is locomotion — only the movement state machine (setWalking) may start it, so the
      // window always moves while the legs do. idleRandom / lifeAct / rules / menus asking for it get a refusal (logged once).
      if (a.cycle && !this._walkPlay) { this._logOnce('cycle-refused ' + id + ' (only the walk state machine plays a cycle action)'); return false; }
      const p = prio ?? PRIORITY.user;
      if (p < this.state.prio && !this._finished()) return false;
      this.transitionFrom = this._currentImage(); this.transitionT0 = this.now();
      this.state = { action: id, prio: p, t0: this.now(), seqIdx: 0, frameT0: this.now(), loopsDone: 0, waking: false };
      if (this.opts.onAction) this.opts.onAction(id);
      return true;
    }

    trigger(name, opts) {
      const tr = this.m.triggers[name]; if (!tr) return;
      if (tr.action) this.play(tr.action, name === 'dragStart' ? PRIORITY.drag : name.startsWith('chat') ? PRIORITY.chat : PRIORITY.user);
      if (tr.say) { if (this.opts.onReact) this.opts.onReact(name, tr.say); else this.sayFrom(tr.say); }
    }

    sayFrom(key) {
      const lines = (this.p.lines || {})[key]; if (!lines || !lines.length) return;
      const text = lines[Math.floor(Math.random() * lines.length)];
      if (this.opts.onSay) this.opts.onSay(text, false);
    }

    click(yRatio) {
      const t = this.now(); this.lastInput = t;
      this.clickTimes = this.clickTimes.filter(x => t - x < 10); this.clickTimes.push(t);
      if (this._wake()) return;                       // sleeping pet: a click just wakes it
      const sinceInput = t - (this._prevInput || t); this._prevInput = t;
      if (this.clickTimes.length >= 4) { if (this.opts.onReact) this.opts.onReact('clickMany', 'clickMany'); else this.sayFrom('clickMany'); this.play('shake'); this.showExpression('angry', 2500); return; }
      if (sinceInput > 600) { this.showExpression('surprised', 1500); }
      if (yRatio > 0.6 && this.m.triggers.clickBody) this.trigger('clickBody'); else this.trigger('click');
      this.showExpression('happy', 1200);
    }
    /** Called by the runtime when the cursor strokes the head (back-and-forth). */
    stroke() {
      this.userInput(); this.showExpression('shy', 1000); if (this.opts.onReact) this.opts.onReact('stroke', 'pet'); else this.sayFrom('pet');
      setTimeout(() => this.showExpression('happy', 1500), 1000);
      if (this.opts.onStroke) this.opts.onStroke(); return true;
    }
    /** grab = where the hand took hold, in canvas px (null = top centre). */
    dragStart(grab) {
      const d = this.drag; d.active = true; d.grab = grab || { x: this.m.render.anchor[0], y: this.canvasH * 0.12 };
      d.ang = 0; d.angV = 0; d.vx = d.vy = d.ax = d.ay = 0; d.revs = []; d.lastVx = 0; d.lastT = this.now(); d.dizzy = false; d.shaken = false;
      this.lastInput = this.now(); this._wake(); this.trigger('dragStart');
    }
    dragMove(vx, vy, ax, ay) {
      const d = this.drag; const t = this.now();
      d.vx = vx; d.vy = vy || 0; d.ax = ax || 0; d.ay = ay || 0;
      if (Math.abs(vx) > 900) { d.shaken = true; }
      // a hard reversal = one shake; three within 2.5 s = dizzy (stars, surprised face, a sound per shake via onEvent)
      if (d.lastVx && Math.sign(vx) !== Math.sign(d.lastVx) && Math.abs(vx) > 600 && Math.abs(d.lastVx) > 600) {
        d.revs = d.revs.filter(x => t - x < 2.5); d.revs.push(t);
        if (this.opts.onEvent) this.opts.onEvent('shake');
        if (d.revs.length >= 3 && !d.dizzy) { d.dizzy = true; this.showExpression('surprised', 1500); if (this.opts.onEvent) this.opts.onEvent('dizzy'); }
      }
      if (Math.abs(vx) > 200) d.lastVx = vx;
    }
    dragEnd() {
      const d = this.drag; d.active = false; this._toIdle(); this.trigger('dragEnd');
      if (d.dizzy) {
        this.dizzyUntil = this.now() + 1.8; this.play('stagger', PRIORITY.user); this.showExpression('angry', 2000);
        if (this.opts.onEvent) this.opts.onEvent('dizzyEnd');
      } else if (d.shaken) this.showExpression('angry', 2000);
      d.dizzy = false; d.shaken = false; d.ang = 0; d.angV = 0; d.grab = null;
    }
    /** Pendulum step: the pet is a mass at its centre hanging from the grab point; the hand's acceleration is a
     *  pseudo-force. Clamped to +-16 deg so the sprite stays inside its window. */
    _stepPendulum(dt) {
      const d = this.drag; if (!d.active || !d.grab) return;
      const cx = this.m.render.anchor[0], cy = this.canvasH * 0.55;               // centre of mass, canvas px
      const dx0 = cx - d.grab.x, dy0 = cy - d.grab.y; const L2 = Math.max(400, dx0 * dx0 + dy0 * dy0);
      const c = Math.cos(d.ang), sn = Math.sin(d.ang); const rx = dx0 * c - dy0 * sn, ry = dx0 * sn + dy0 * c;
      const g = 2600;                                                              // canvas px / s^2 (feels like a plush, not a brick)
      const fx = -d.ax * 0.9, fy = g - d.ay * 0.5;
      const torque = (rx * fy - ry * fx) / L2;
      d.angV += torque * dt; d.angV *= Math.exp(-dt * 2.2); d.ang += d.angV * dt;
      const lim = 16 * Math.PI / 180;
      if (d.ang > lim) { d.ang = lim; d.angV = Math.min(0, d.angV) * 0.3; } else if (d.ang < -lim) { d.ang = -lim; d.angV = Math.max(0, d.angV) * 0.3; }
    }
    userInput() { this._prevInput = this.lastInput; this.lastInput = this.now(); this._wake(); }
    /** Show a generated expression frame (layers.expressions[name]) for ms milliseconds while idle. */
    showExpression(name, ms) { if (this.img.expressions && this.img.expressions[name]) { this.expr = { name, until: this.now() + (ms || 1500) / 1000 }; } }
    setSleeping(on) {
      this.sleeping = !!on;
      if (on) {
        if (!this.m.actions.slump) this.m.actions.slump = { type: 'procedural', preset: 'slump' };
        const id = this.m.actions.sleep && this.m.actions.sleep.type === 'frames' ? 'sleep' : 'slump';
        this.play(id, PRIORITY.sleep); this.look.current = this.look.target = 'base';
      }
      else { this._wake(); if (this.state.action === 'idle') this._toIdle(); }
    }
    chatWait() { this.trigger('chatWait'); }
    chatReply() { this.trigger('chatReply'); }
    stopChat() { if (this.state.prio === PRIORITY.chat) this._toIdle(); }

    /** 0.9.2 walk cycle: while the behaviours move the window, a real `walk` frames action (cycle: true, loops -1)
     *  plays and keeps looping; when the walk ends it returns to idle. Without walk frames nothing happens (the old bob). */
    hasWalkCycle() { const a = this.m.actions.walk; return !!(a && a.type === 'frames' && a.cycle); }
    setWalking(on) {
      this.walking = !!on;
      if (!this.hasWalkCycle() || this.sleeping || this.drag.active) { if (!on && this.state.action === 'walk') this._toIdle(); return; }
      if (on && this.state.action !== 'walk' && (this.state.action === 'idle' || this._finished())) { this._walkPlay = true; try { this.play('walk', PRIORITY.random + 1); } finally { this._walkPlay = false; } }
      if (!on && this.state.action === 'walk') this._toIdle();
    }
    /** The frames of a walk cycle face `actions.walk.facing` ("right" by default): mirror when moving against it. */
    walkFlip(movingLeft) {
      const a = this.m.actions.walk; const facing = (a && a.facing === 'left') ? 'left' : 'right';
      return facing === 'left' ? !movingLeft : !!movingLeft;
    }
    _logOnce(line) { this._logged = this._logged || {}; if (this._logged[line]) return; this._logged[line] = 1; if (this.opts.onLog) { try { this.opts.onLog(line); } catch (_) {} } }
    /** 0.9.4 look-follow switch (settings.lookFollow): off = base frame, no direction frames, no scripted glances; the
     *  package config stays in place so switching back on restores it without a reload. Blinks / expressions / actions untouched. */
    setLookEnabled(on) {
      this.lookEnabled = on !== false;
      if (!this.lookEnabled) { this.lookScript = null; this.look.fadeFrom = null; this.look.current = this.look.target = 'base'; this.look.sectorIdx = -1; this.lookVec = null; this._lv = null; }
    }

    // ---------- tick ----------
    update() {
      const t = this.now(); const s = this.state; const a = this.m.actions[s.action];
      if (this.drag.active) { const dt = Math.min(0.05, Math.max(0.001, t - (this.drag.lastT || t))); this.drag.lastT = t; this._stepPendulum(dt); }
      if (a && a.type === 'frames') {
        const seq = s.waking ? (a.wake || []) : a.sequence;
        const hold = 1 / Math.max(1, a.fps);
        if (t - s.frameT0 >= hold) {
          s.frameT0 = t; s.seqIdx += 1;
          if (s.seqIdx >= seq.length) {
            if (s.waking) { this._toIdle(); }
            else if (a.holdLast) { s.seqIdx = seq.length - 1; }
            else { s.loopsDone += 1; if ((a.cycle && this.walking) || a.loops < 0 || s.loopsDone < (a.loops || 1)) s.seqIdx = 0; else this._toIdle(); }
          }
        }
      } else if (a && a.type === 'procedural' && s.action !== 'idle' && s.action !== 'drag') {
        const r = PROCEDURAL[a.preset] ? PROCEDURAL[a.preset](t - s.t0, this.drag) : { done: true };
        if (r.done) this._toIdle();
      }
      if (s.action === 'drag' && !this.drag.active) this._toIdle();
      // blink
      // 0.8.10: blink only while resting on base. The blink / expression images are the idle front's family; while the
      // head follows the cursor the look frames are on screen, and a 100 ms cut to the front reads as "jumped to another picture".
      if (t >= this.blink.next && this.img.blink && (s.action === 'idle')) {
        if (this.look.current === 'base') this.blink.until = t + 0.1;
        this.blink.next = t + 3 + Math.random() * 4;
      }
      // idle random
      const tr = this.m.triggers;
      if (s.action === 'idle' && !this.sleeping && !this.drag.active && t - this.lastRandom > this.nextRandomIn && !this.hover) {
        this.lastRandom = t; this.nextRandomIn = this._randIn();
        const pool = (tr.idleRandom || []).filter(x => {
          const a = this.m.actions[x.action]; if (!a) return false;
          if (a.cycle) { this._logOnce('idle-random skipped ' + x.action + ' (cycle action: walking is the movement state machine\'s job)'); return false; }   // 0.9.4
          return !this.cooldown[x.action] || t - this.cooldown[x.action] > (x.cooldownSec || 0);
        });
        const total = pool.reduce((q, x) => q + (x.weight || 1), 0);
        let r = Math.random() * total;
        for (const x of pool) { r -= (x.weight || 1); if (r <= 0) { this.cooldown[x.action] = t; this.play(x.action, PRIORITY.random); break; } }
      }
      // after idle -> sleep
      if (tr.afterIdleMin && s.action === 'idle' && !this.sleeping && t - this.lastInput > tr.afterIdleMin.minutes * 60 && this.m.actions[tr.afterIdleMin.action]) {
        this.play(tr.afterIdleMin.action, PRIORITY.sleep);
      }
    }

    _finished() { const a = this.m.actions[this.state.action]; return !a || this.state.action === 'idle'; }
    _toIdle() { this.transitionFrom = this._currentImage(); this.transitionT0 = this.now(); this.state = { action: 'idle', prio: PRIORITY.idle, t0: this.now(), seqIdx: 0, frameT0: this.now(), loopsDone: 0, waking: false }; }
    _wake() {
      const a = this.m.actions[this.state.action];
      if (a && a.type === 'procedural' && a.preset === 'slump') { this._toIdle(); return true; }
      if (a && a.type === 'frames' && a.holdLast && !this.state.waking) {
        if (a.wake && a.wake.length) { this.state.waking = true; this.state.seqIdx = 0; this.state.frameT0 = this.now(); }
        else this._toIdle();
        return true;
      }
      return false;
    }

    _currentImage() {
      const s = this.state; const a = this.m.actions[s.action];
      if (a && a.type === 'frames') {
        const seq = s.waking ? (a.wake || a.sequence) : a.sequence;
        const idx = seq[Math.min(s.seqIdx, seq.length - 1)];
        return (this.img.actions[s.action] || [])[idx] || this.img.base;
      }
      if (this.sleeping) return (this.img.expressions && this.img.expressions.sleepy) || this.img.blink || this.img.base;
      // while a look frame is on screen, expressions and blinks wait: they are drawn from the idle front, and cutting to it
      // mid-follow is the "jumps back to the default picture" of the v5 retro. Touch / click happen inside the deadzone
      // (current === 'base'), so the expressions the user triggers by hand still show at once.
      if (this.look.current !== 'base') return this._lookImg(this.look.current);
      if (this.now() < this.expr.until && this.img.expressions && this.img.expressions[this.expr.name]) return this.img.expressions[this.expr.name];
      if (this.now() < this.blink.until && this.img.blink) return this.img.blink;
      return this.img.base;
    }

    /** Returns draw instructions: {images:[{img, alpha}], sx, sy, dx, dy, rot} in canvas units. */
    frame() {
      const t = this.now(); const s = this.state; const a = this.m.actions[s.action] || {};
      const cur = this._currentImage();
      const layers = [{ img: cur, alpha: 1 }];
      // crossfade sources: look change, action transition, keyframe step. Each expires independently; the newest wins.
      const lf = this.m.lookFollow || {};
      const cands = [];
      if (this.look.fadeFrom && this.look.fadeFrom !== this.look.current && s.action === 'idle')
        cands.push({ kind: 'look', img: this._lookImg(this.look.fadeFrom), t0: this.look.fadeT0, ms: lf.mode === 'ring' ? (lf.crossfadeMs || 90) : (lf.crossfadeMs || 55) });   // 0.8.15: the package value is honoured as written (the old 220 ms floor made every frames8 fade a visible double head)
      if (this.transitionFrom && this.transitionFrom !== cur)
        cands.push({ kind: 'trans', img: this.transitionFrom, t0: this.transitionT0, ms: Math.max(a.tweenMs || 0, 120) });
      if (a.type === 'frames') {
        if (this._lastKeyImg && this._lastKeyImg !== cur) this._keyFade = { img: this._lastKeyImg, t0: t };
        if (this._keyFade && this._keyFade.img !== cur) cands.push({ kind: 'key', img: this._keyFade.img, t0: this._keyFade.t0, ms: a.tweenMs || 0 });
      } else this._keyFade = null;
      let best = null;
      for (const c of cands) {
        let k = c.ms > 0 ? Math.min(1, (t - c.t0) * 1000 / c.ms) : 1;
        if (k < 1) k = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;   // ease-in-out
        if (k >= 1 || !c.img) { if (c.kind === 'look') this.look.fadeFrom = null; if (c.kind === 'trans') this.transitionFrom = null; if (c.kind === 'key') this._keyFade = null; continue; }
        if (!best || c.t0 > best.t0) best = { ...c, k };
      }
      // old frame stays fully opaque underneath; only the new frame fades in — overlapping pixels never dip below 100%
      if (best && best.img !== cur) { layers[0].alpha = best.k; layers.unshift({ img: best.img, alpha: 1 }); }
      this._lastKeyImg = a.type === 'frames' ? cur : null;
      // procedural transform
      let tf = { sx: 1, sy: 1, dx: 0, dy: 0, rot: 0 };
      if (a.type === 'procedural') {
        const f = PROCEDURAL[a.preset]; if (f) Object.assign(tf, f(t - s.t0, this.drag));
        if (s.action === 'idle') Object.assign(tf, PROCEDURAL.breathe(t));
      }
      // continuous micro-parallax toward the cursor (whole sprite, so no seams): keeps "tracking" alive between frame switches
      if (s.action === 'idle' && !this.sleeping && this.lookVec && ['frames8', 'ring'].includes((this.m.lookFollow || {}).mode)) {
        this._lv = this._lv || { x: 0, y: 0 }; const k = 0.12;
        this._lv.x += (this.lookVec.x - this._lv.x) * k; this._lv.y += (this.lookVec.y - this._lv.y) * k;
        tf.dx = (tf.dx || 0) + this._lv.x * 5; tf.dy = (tf.dy || 0) + this._lv.y * 3;
      }
      if (this.drag.active && this.drag.grab) { tf.rot = (tf.rot || 0) + this.drag.ang * 180 / Math.PI; tf.pivot = this.drag.grab; tf.sy = (tf.sy || 1) * 1.025; }   // hanging from the hand
      if (this.m.source && this.m.source.cropped && a.preset === 'bounce') { tf.sx = 1; tf.sy = 1; }
      if (a.type === 'procedural' && (a.preset === 'eat' || a.preset === 'drink') && this.img.expressions && this.img.expressions.happy && (t - s.t0) > 1.1) layers[layers.length - 1] = { img: this.img.expressions.happy, alpha: 1 };
      return { layers, ...tf };
    }

    /** Draw into a 2D context; scale = display px per canvas px. */
    draw(ctx, scale, originX, originY) {
      const f = this.frame(); const anchorX = this.m.render.anchor[0], anchorY = this.m.render.anchor[1];
      const ax = f.pivot ? f.pivot.x : anchorX, ay = f.pivot ? f.pivot.y : anchorY;     // rotate about the grab point while dragged
      ctx.save();
      ctx.translate(originX + ax * scale + f.dx * scale, originY + ay * scale + f.dy * scale);
      ctx.rotate((f.rot + (this.extraRot || 0)) * Math.PI / 180);
      ctx.scale(f.sx * (this.flip ? -1 : 1), f.sy);
      for (const L of f.layers) {
        if (!L.img) continue;
        ctx.globalAlpha = L.alpha;
        ctx.drawImage(L.img, -ax * scale, -ay * scale, this.canvasW * scale, this.canvasH * scale);
      }
      ctx.restore(); ctx.globalAlpha = 1;
      // overlays drawn in window space (not flipped / rotated): care icons and floating z's
      const W = this.canvasW * scale, H = this.canvasH * scale;
      if (f.overlay && !f.overlay.hide) {
        const o = f.overlay; const e = o.at < 0.5 ? 2 * o.at * o.at : 1 - Math.pow(-2 * o.at + 2, 2) / 2;
        const x = originX + W / 2 + (o.from[0] + (o.to[0] - o.from[0]) * e) * W, y = originY + (o.from[1] + (o.to[1] - o.from[1]) * e) * H;
        ctx.font = `${Math.round(H * 0.12)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(o.icon, x, y);
      }
      if (f.zzz || this.sleeping) {
        const t = this.now();
        ctx.font = `${Math.round(H * 0.09)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (let i = 0; i < 3; i++) { const ph = ((t * 0.6 + i / 3) % 1); ctx.globalAlpha = 1 - ph; ctx.fillStyle = '#3a3634';
          ctx.fillText('z', originX + W * (0.68 + 0.08 * i), originY + H * (0.18 - ph * 0.22)); }
        ctx.globalAlpha = 1;
      }
    }
  }

  global.PetEngine = PetEngine;
  // 0.9.5: breathe / sway / slump / dragWiggle / stagger are STATES (idle, dragging, asleep, dizzy), not tricks you can
  // ask for. One list, used by main.js (panel-cmd / menu) and panel.html (which cards are clickable) — never copied by hand.
  const NOT_TRICKS = ['breathe', 'sway', 'slump', 'dragWiggle', 'stagger', 'typing'];
  global.PET_PRIORITY = PRIORITY; global.PET_DIRS = DIRS; global.PET_LIFE_PRESETS = LIFE_PRESETS; global.PET_PROCEDURAL = Object.keys(PROCEDURAL);
  global.PET_PERFORMABLE = Object.keys(PROCEDURAL).filter((x) => !NOT_TRICKS.includes(x));
})(typeof window !== 'undefined' ? window : globalThis);
