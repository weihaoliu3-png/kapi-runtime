// Kapi care system: hunger / thirst / energy / mood, daily streaks, XP, levels, unlock tickets.
// Pure logic + tiny DOM panel. Persistence is delegated to the host (load/save callbacks).
(function (global) {
  'use strict';

  const HOUR = 3600 * 1000;
  const DECAY_PER_HOUR = { hunger: 100 / 20, thirst: 100 / 12, energy: 100 / 20 }; // while Kapi is running: full -> empty in 20h / 12h / 20h
  const OFFLINE_FACTOR = 0.25;   // when the app was closed, stats drop at a quarter speed…
  const OFFLINE_FLOOR = 15;      // …and never below this, so it is never "dying" when you come back
  const SLEEP_REGEN_PER_HOUR = 100 / 6;
  const LEVEL_XP = [0, 60, 150, 280, 450, 680, 980, 1350, 1800, 2400, 3200];   // xp needed to reach level i
  const REWARDS = {                                                             // level -> reward description
    2: { type: 'lines', label: '新台词包：撒娇' },
    3: { type: 'ticket', label: '服装券 ×1（回去跟助手说"用服装券换一套衣服"）' },
    4: { type: 'lines', label: '新台词包：碎碎念' },
    5: { type: 'ticket', label: '服装券 ×1' },
    6: { type: 'stage', label: '成长阶段：少年期（体型 +10%）' },
    7: { type: 'ticket', label: '服装券 ×1' },
    8: { type: 'lines', label: '新台词包：老朋友' },
    9: { type: 'ticket', label: '节日皮肤券 ×1' },
    10: { type: 'stage', label: '成长阶段：成年期（体型 +20%）' },
  };
  const STAGE_SCALE = { 1: 1.0, 6: 1.1, 10: 1.2 };
  const TITLE_KEYS = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'];   // localized in i18n care.titles
  const rid = () => Math.random().toString(36).slice(2, 8);
  const CARE = {
    feed:  { hunger: +35, mood: +5,  xp: 10, cooldownMin: 90,  emoji: '🍙', label: '喂食', say: 'fed',    expr: 'happy' },
    water: { thirst: +40, mood: +3,  xp: 8,  cooldownMin: 45,  emoji: '💧', label: '喝水', say: 'watered', expr: 'happy' },
    pet:   { mood: +12,   xp: 6,     cooldownMin: 2, emoji: '🤚', label: '抚摸', say: 'pet',    expr: 'happy' },
    sleep: { xp: 12, emoji: '🌙', label: '睡觉', say: 'sleep' },
  };

  class CareSystem {
    constructor(state, host) {
      this.host = host; // {say(text, sticky), expr(name, ms), play(id), setSleeping(bool), setStageScale(k), toast(msg), save(state)}
      const now = Date.now();
      this.s = Object.assign({ hunger: 70, thirst: 70, energy: 80, mood: 70, xp: 0, level: 1, streak: 0, lastCareDay: '', lastTick: now,
        lastCare: {}, sleeping: false, sleepSince: 0, tickets: { outfit: 0, holiday: 0 }, ticketLog: [], unlocked: [], stage: 1, outfit: null }, state || {});
      this.catchUp();
    }
    // ---- time ----
    catchUp() { const now = Date.now(); const gap = now - this.s.lastTick; this._advance(gap, gap > 5 * 60000); this.s.lastTick = now; }
    _advance(ms, offline) {
      let h = Math.max(0, ms) / HOUR; const st = this.s;
      if (offline) h *= OFFLINE_FACTOR;
      const floor = offline ? OFFLINE_FLOOR : 0;
      const before = { hunger: st.hunger, thirst: st.thirst, energy: st.energy };
      if (st.sleeping) { st.energy = Math.min(100, st.energy + SLEEP_REGEN_PER_HOUR * h); st.hunger = Math.max(0, st.hunger - DECAY_PER_HOUR.hunger * h * 0.5); st.thirst = Math.max(0, st.thirst - DECAY_PER_HOUR.thirst * h * 0.5); }
      else { for (const k of ['hunger', 'thirst', 'energy']) st[k] = Math.max(0, st[k] - DECAY_PER_HOUR[k] * h); }
      if (offline) for (const k of ['hunger', 'thirst', 'energy']) st[k] = Math.max(st[k], Math.min(before[k], floor));
      const target = (st.hunger + st.thirst + st.energy) / 3;
      st.mood += (target - st.mood) * Math.min(1, h * 0.25);
      st.mood = Math.max(0, Math.min(100, st.mood));
    }
    tick() { this.catchUp(); if (this.s.sleeping && this.s.energy >= 100) this.wake(true); this.host.save(this.s); return this.warnings(); }
    warnings() {
      const st = this.s, w = [];
      if (st.hunger < 25) w.push('hungry'); if (st.thirst < 25) w.push('thirsty'); if (st.energy < 20 && !st.sleeping) w.push('tired'); if (st.mood < 30) w.push('lonely');
      return w;
    }
    // ---- actions ----
    can(kind) { const c = CARE[kind]; const last = this.s.lastCare[kind] || 0; return !c.cooldownMin || Date.now() - last >= c.cooldownMin * 60000; }
    do(kind) {
      const c = CARE[kind]; const st = this.s;
      if (kind === 'sleep') return st.sleeping ? this.wake(false) : this.sleep();
      const T = this.host.t().care;
      if (!this.can(kind)) { const m = Math.ceil((c.cooldownMin * 60000 - (Date.now() - st.lastCare[kind])) / 60000); this.host.say(kind === 'pet' ? T.enough : T.cooldown(T[kind], m)); return false; }
      if (st.sleeping) this.wake(false);
      for (const k of ['hunger', 'thirst', 'mood']) if (c[k]) st[k] = Math.min(100, st[k] + c[k]);
      st.lastCare[kind] = Date.now();
      this._gainXp(c.xp, kind);
      if (c.expr) this.host.expr(c.expr, 2000);
      this.host.play(kind === 'feed' ? 'happy' : 'nod');
      this.host.say(this.host.line(c.say) || T.fallback[c.say]);
      this.host.save(st); return true;
    }
    sleep() { const st = this.s; const T = this.host.t().care; st.sleeping = true; st.sleepSince = Date.now(); this.host.setSleeping(true); this.host.say(this.host.line('sleep') || T.fallback.sleep); this._gainXp(CARE.sleep.xp, 'sleep'); this.host.save(st); return true; }
    wake(natural) { const st = this.s; const T = this.host.t().care; if (!st.sleeping) return false; st.sleeping = false; this.host.setSleeping(false); this.host.say(natural ? (this.host.line('wakeUp') || T.fallback.wakeUp) : (this.host.line('wokenUp') || T.fallback.wokenUp)); this.host.save(st); return true; }
    _gainXp(n, kind) {
      const st = this.s; const day = new Date().toISOString().slice(0, 10);
      if (st.lastCareDay !== day) {
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        st.streak = st.lastCareDay === yesterday ? st.streak + 1 : 1; st.lastCareDay = day; n += 30 + Math.min(20, st.streak * 2);
        this.host.toast(this.host.t().care.firstToday(30 + Math.min(20, st.streak * 2), st.streak));
      }
      st.xp += n;
      while (st.level < LEVEL_XP.length - 1 && st.xp >= LEVEL_XP[st.level + 1]) { st.level += 1; this._levelUp(st.level); }
    }
    _levelUp(lv) {
      const st = this.s; const r = REWARDS[lv]; const T = this.host.t().care;
      let msg = T.levelUp(lv);
      if (r) {
        msg += T.got + (T.rewards[lv] || r.label); st.unlocked.push({ level: lv, ...r, at: Date.now() });
        if (r.type === 'ticket') {
          const type = lv === 9 ? 'holiday' : 'outfit';
          st.tickets[type] = (st.tickets[type] || 0) + 1;
          st.ticketLog.push({ id: `${type === 'holiday' ? 'HT' : 'OT'}-${lv}-${rid()}`, type, level: lv, issuedAt: Date.now(), usedAt: null, note: '' });
        }
        if (r.type === 'stage') { st.stage = lv; this.host.setStageScale(STAGE_SCALE[lv] || 1); }
      }
      this.host.say(msg, true); this.host.play('happy'); this.host.expr('happy', 3000);
    }
    /** Merge a ticket ledger coming from an imported package: tickets marked used there become used here. Live stats stay local. */
    mergeLedger(imported) {
      if (!imported || !Array.isArray(imported.ticketLog)) return 0;
      let changed = 0; const st = this.s;
      for (const t of imported.ticketLog) {
        const mine = st.ticketLog.find(x => x.id === t.id);
        if (!mine) { st.ticketLog.push({ ...t }); if (!t.usedAt) st.tickets[t.type] = (st.tickets[t.type] || 0) + 1; changed++; continue; }
        if (t.usedAt && !mine.usedAt) { mine.usedAt = t.usedAt; mine.note = t.note; mine.outfit = t.outfit; st.tickets[t.type] = Math.max(0, (st.tickets[t.type] || 0) - 1); changed++; }
      }
      if (changed) this.host.save(st);
      return changed;
    }
    title() { const T = this.host.t().care; return (T.titles || [])[Math.min(this.s.level, 10) - 1] || ''; }
    stageScale() { let k = 1; for (const [lv, sc] of Object.entries(STAGE_SCALE)) if (this.s.level >= +lv) k = sc; return k; }
    summary() { const st = this.s; return { ...st, nextXp: LEVEL_XP[Math.min(st.level + 1, LEVEL_XP.length - 1)] }; }
    // ---- panel ----
    renderPanel(el) {
      const st = this.summary(); const T = this.host.t().care;
      const bar = (label, v) => `<div class="row"><span>${label}</span><div class="bar"><i style="width:${Math.round(v)}%" class="${v < 25 ? 'low' : ''}"></i></div><b>${Math.round(v)}</b></div>`;
      const btn = (k) => { const c = CARE[k]; const ok = k === 'sleep' || this.can(k); const label = k === 'sleep' && st.sleeping ? T.wake : T[k]; return `<button data-care="${k}" ${ok ? '' : 'disabled'} title="${ok ? '' : T.cooling}">${c.emoji} ${label}</button>`; };
      el.innerHTML = `
        <div class="hd">Lv.${st.level} ${this.title()} <small>${st.xp}/${st.nextXp} ${T.xp} · ${T.streak(st.streak)}</small><span class="x" data-close="1">${T.close}</span></div>
        ${bar(T.hunger, st.hunger)}${bar(T.thirst, st.thirst)}${bar(T.energy, st.energy)}${bar(T.mood, st.mood)}
        <div class="btns">${btn('feed')}${btn('water')}${btn('pet')}${btn('sleep')}</div>
        ${st.tickets.outfit || st.tickets.holiday ? `<div class="tk">${T.tickets(st.tickets.outfit, st.tickets.holiday)}</div>` : ''}`;
    }
  }

  global.CareSystem = CareSystem;
  global.CARE_DEFS = CARE;
})(typeof window !== 'undefined' ? window : globalThis);
