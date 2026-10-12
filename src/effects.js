// Kapi milestone effects: procedural particle scenes drawn on a separate canvas inside the pet window.
//   bubbleTea : a cup (prop image from the pet package, or a drawn one) flies from the pet on a parabola, bursts at the
//               screen edge, leaves a tea splat that fades, and pearls rain down, bounce and vanish.
//   hearts / petals / notes : a 3-second fall of shapes over the whole screen.
// Everything here is screen effect, not character art, so it is drawn with code; only the cup in hand is a package prop.
// Pure: plan*() functions are testable without a canvas; play() needs one.
(function (global) {
  'use strict';

  const rand = (a, b) => a + Math.random() * (b - a);

  /** Parabola from `from` (screen px) toward the nearer vertical edge; returns {t -> {x,y,rot}, hitAt, hitPoint}. */
  function planThrow(from, W, H, dir, local = false) {
    const toRight = dir ? dir > 0 : from.x < W / 2;
    const edge = local ? Math.max(60, W * 0.16) : 40;
    const target = { x: toRight ? W - edge : edge,
      y: local ? Math.max(H * 0.38, Math.min(H * 0.72, from.y - H * 0.12)) : Math.max(80, Math.min(H * 0.55, from.y - H * 0.25)) };
    const T = local ? 0.9 : 1.1;                                              // seconds of flight
    const g = local ? 620 : 1800;                                             // keep the bounded throw inside the pet window
    const vx = (target.x - from.x) / T;
    const vy = (target.y - from.y - 0.5 * g * T * T) / T;
    return {
      hitAt: T, hitPoint: target, toRight,
      at(t) { const k = Math.min(T, t); return { x: from.x + vx * k, y: from.y + vy * k + 0.5 * g * k * k, rot: (toRight ? 1 : -1) * k * 9 }; },
    };
  }

  function planPearls(p, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ x: p.x, y: p.y, vx: rand(-520, 520), vy: rand(-900, -200), r: rand(5, 9), life: rand(1.6, 2.6), bounce: rand(0.35, 0.55) });
    return out;
  }

  function drawCup(ctx, x, y, s, rot, img) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    if (img) { const w = s, h = s * (img.height / img.width); ctx.drawImage(img, -w / 2, -h / 2, w, h); }
    else {
      ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.strokeStyle = '#c9a27a'; ctx.lineWidth = s * 0.05;
      ctx.beginPath(); ctx.moveTo(-s * 0.32, -s * 0.5); ctx.lineTo(s * 0.32, -s * 0.5); ctx.lineTo(s * 0.24, s * 0.5); ctx.lineTo(-s * 0.24, s * 0.5); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#c9a27a'; ctx.beginPath(); ctx.moveTo(-s * 0.3, -s * 0.1); ctx.lineTo(s * 0.3, -s * 0.1); ctx.lineTo(s * 0.24, s * 0.5); ctx.lineTo(-s * 0.24, s * 0.5); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#3b2a20'; for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.arc(-s * 0.15 + (i % 3) * s * 0.15, s * 0.22 + Math.floor(i / 3) * s * 0.14, s * 0.05, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = '#ffb3c7'; ctx.fillRect(-s * 0.03, -s * 0.95, s * 0.06, s * 0.5);     // straw
    }
    ctx.restore();
  }

  function drawSplat(ctx, p, s, alpha) {
    ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = '#c9a27a';
    ctx.beginPath();
    for (let i = 0; i < 14; i++) { const a = i / 14 * Math.PI * 2; const r = s * (0.6 + 0.4 * Math.abs(Math.sin(i * 2.3))); const x = p.x + Math.cos(a) * r, y = p.y + Math.sin(a) * r * 0.8; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#e3c9a8'; ctx.beginPath(); ctx.arc(p.x - s * 0.15, p.y - s * 0.1, s * 0.25, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function shape(ctx, kind, x, y, s, rot, color) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.fillStyle = color;
    if (kind === 'hearts') { ctx.beginPath(); ctx.moveTo(0, s * 0.3); ctx.bezierCurveTo(-s, -s * 0.5, -s * 0.3, -s, 0, -s * 0.4); ctx.bezierCurveTo(s * 0.3, -s, s, -s * 0.5, 0, s * 0.3); ctx.fill(); }
    else if (kind === 'notes') { ctx.beginPath(); ctx.ellipse(0, s * 0.3, s * 0.35, s * 0.25, -0.4, 0, Math.PI * 2); ctx.fill(); ctx.fillRect(s * 0.25, -s * 0.8, s * 0.12, s * 1.1); }
    else { ctx.beginPath(); ctx.ellipse(0, 0, s * 0.5, s * 0.25, 0, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }

  /** Play an effect to completion. W,H in device px; from in CSS px (converted with dpr). Resolves when done. */
  function play(ctx, W, H, dpr, effect, opts) {
    return new Promise((resolve) => {
      if (opts.signal && opts.signal.aborted) { resolve(); return; }
      const from = { x: ((opts.from && opts.from.x) || W / dpr / 2) * dpr, y: ((opts.from && opts.from.y) || H / dpr / 2) * dpr };
      const t0 = performance.now() / 1000; let pearls = null, splat = null, lastT = t0;
      const thr = planThrow(from, W, H, opts.dir, !!opts.local);
      const cupSize = opts.local ? Math.max(64 * dpr, Math.min(W, H) * 0.17) : Math.max(48, Math.min(W, H) * 0.07);
      const fall = [];
      if (effect !== 'bubbleTea') {
        const colors = effect === 'hearts' ? ['#ff6b9d', '#ff8fb4', '#ff4d7e'] : effect === 'notes' ? ['#6c8cff', '#9a7bff', '#4dd0e1'] : [opts.color || '#ffb7c5', '#ffd1dc', '#ff9eb5'];
        for (let i = 0; i < 70; i++) fall.push({ x: rand(0, W), y: rand(-H * 0.6, -20), vy: rand(H * 0.25, H * 0.5), vx: rand(-40, 40) * dpr, s: rand(10, 22) * dpr, rot: rand(0, 6.28), vr: rand(-2, 2), color: colors[i % colors.length] });
      }
      const total = effect === 'bubbleTea' ? 4.2 : 3.4;
      function frame() {
        if (opts.signal && opts.signal.aborted) { resolve(); return; }
        const t = performance.now() / 1000 - t0; const dt = Math.min(0.05, performance.now() / 1000 - lastT); lastT = performance.now() / 1000;
        ctx.clearRect(0, 0, W, H);
        if (effect === 'bubbleTea') {
          if (t < thr.hitAt) { const p = thr.at(t); drawCup(ctx, p.x, p.y, cupSize, p.rot, opts.cup); }
          else {
            if (!pearls) { pearls = planPearls(thr.hitPoint, 36); splat = { p: thr.hitPoint, t0: t }; if (opts.onHit) { try { opts.onHit(thr.hitPoint); } catch (_) {} } }   // 0.8.15: sound cue at the burst
            drawSplat(ctx, splat.p, cupSize * (opts.local ? 1.65 : 1.6), (opts.local ? 0.65 : 1) * Math.max(0, 1 - (t - splat.t0) / 2.4));
            for (const q of pearls) {
              q.life -= dt; if (q.life <= 0) continue;
              q.vy += 2200 * dt; q.x += q.vx * dt; q.y += q.vy * dt;
              if (q.y > H - q.r) { q.y = H - q.r; q.vy = -q.vy * q.bounce; q.vx *= 0.8; }
              if (q.x < q.r || q.x > W - q.r) q.vx = -q.vx;
              ctx.globalAlpha = Math.min(1, q.life); ctx.fillStyle = '#3b2a20'; ctx.beginPath(); ctx.arc(q.x, q.y, q.r * dpr, 0, Math.PI * 2); ctx.fill();
            }
            ctx.globalAlpha = 1;
          }
        } else {
          const fade = t > total - 0.6 ? Math.max(0, (total - t) / 0.6) : 1;
          for (const f of fall) { f.y += f.vy * dt; f.x += (f.vx + Math.sin(t * 3 + f.rot) * 30 * dpr) * dt; f.rot += f.vr * dt; ctx.globalAlpha = fade; shape(ctx, effect, f.x, f.y, f.s, f.rot, f.color); }
          ctx.globalAlpha = 1;
        }
        if (t < total) requestAnimationFrame(frame); else { ctx.clearRect(0, 0, W, H); resolve(); }
      }
      requestAnimationFrame(frame);
    });
  }

  /** Replay images extracted from an actual video, in their original frame order and positions. */
  function playVideoFrames(ctx, W, H, frames, fps, opts = {}) {
    if (!Array.isArray(frames) || !frames.length || frames.some(f => !f)) {
      return Promise.reject(new Error('Video effect frames are missing'));
    }
    if (!(fps > 0)) return Promise.reject(new Error('Video effect FPS is invalid'));
    return new Promise(resolve => {
      if (opts.signal && opts.signal.aborted) { resolve(); return; }
      const start = performance.now();
      const totalMs = frames.length * 1000 / fps;
      function frame(now) {
        if (opts.signal && opts.signal.aborted) { resolve(); return; }
        const elapsed = Math.max(0, now - start);
        if (elapsed >= totalMs) { ctx.clearRect(0, 0, W, H); resolve(); return; }
        const image = frames[Math.min(frames.length - 1, Math.floor(elapsed * fps / 1000))];
        const view = opts.viewport || { x: 0, y: 0, width: W, height: H };
        const s = Math.max(view.width / image.width, view.height / image.height);
        const dw = image.width * s, dh = image.height * s;
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(image, view.x + (view.width - dw) / 2, view.y + (view.height - dh) / 2, dw, dh);
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
  }

  /**
   * Concurrency policy for timed effects: `queue-one`. One effect plays at a time; while it plays, at most ONE
   * further request is kept (the newest wins) and starts after the current one finishes. More requests only count
   * for the milestone / mood — they never stack a second set of particles on the canvas. clear() drops everything
   * (pet switch, hide, quit). Pure: `run(effect, m)` is the host's async player; done() awaits it.
   */
  class Queue {
    constructor(run) { this.run = run; this.playing = null; this.pending = null; this.alive = 0; this.maxAlive = 0; }
    request(effect, m) {
      if (this.playing) { this.pending = { effect, m }; return 'queued'; }
      this._start(effect, m); return 'started';
    }
    _start(effect, m) {
      this.playing = { effect, m }; this.alive++; this.maxAlive = Math.max(this.maxAlive, this.alive);
      const done = () => {
        this.alive--; this.playing = null;
        const n = this.pending; this.pending = null;
        if (n) this._start(n.effect, n.m);
      };
      Promise.resolve().then(() => this.run(effect, m)).then(done, done);
    }
    clear() { this.pending = null; }
  }

  global.KapiFx = { play, playVideoFrames, planThrow, planPearls, Queue };
})(typeof window !== 'undefined' ? window : globalThis);
