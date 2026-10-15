// Kapi runtime glue: Tauri window, hit-testing, drag, look-follow polling, bubbles, tray, settings.
(async function () {
  'use strict';
  const TAURI = window.__TAURI__;
  const { invoke, convertFileSrc } = TAURI.core;
  const { getCurrentWindow, cursorPosition, LogicalPosition, LogicalSize, currentMonitor, monitorFromPoint, primaryMonitor, availableMonitors } = TAURI.window;
  const { listen, emit } = TAURI.event;
  const win = getCurrentWindow();

  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const fxCanvas = document.getElementById('fx');
  const fxCtx = fxCanvas.getContext('2d');
  const whipCanvas = document.getElementById('whip');
  const whipCtx = whipCanvas.getContext('2d');
  const bubble = document.getElementById('bubble');
  const toastEl = document.getElementById('toast');
  const pawEl = document.getElementById('paw');
  const careEl = document.getElementById('care');
  let care = null, careTimer = null, stageScale = 1;
  let T = I18N.pick();                       // UI strings; re-picked per pet from persona.language
  const t = () => T;
  let currentOutfit = 'default';
  let beh = null, winRect = null, monRect = null, cursorLogical = null, perchTimer = null, batteryTimer = null, rectTimer = null;
  let growth = null, catchGame = null, catchFaceTimer = null, findShow = null, lastInputSec = 0;   // 0.9.6: one handle for the hit reaction, so repeats replace instead of stack
  let rules = null, lastRuleMinute = '', lastAppKey = '';                  // 0.9.3 pet.json.rules   // 0.9.0 growth: wishes / finds / diary / sulk / catch game
  let milestones = null, garden = null, props = { cup: null, flowers: {} }, videoFx = {}, interState = null, fxAbort = null, fxRun = 0, fxQueue = null;
  // Built-in real-video effects shipped with the runtime (src/fx/<id>/000..N.webp): every pet has them; a package may
  // override one with its own effects.<id>. Loaded on first use, kept for the session.
  const BUILTIN_FX = { bubbleTea: { type: 'videoFrames', frames: 41, fps: 18, ext: 'webp', hitFrame: 22 } };   // hitFrame: where the cup bursts (sound cue)
  const builtinFxCache = {};
  function loadBuiltinFx(id) {
    if (builtinFxCache[id]) return builtinFxCache[id];
    const spec = BUILTIN_FX[id];
    builtinFxCache[id] = Promise.all(Array.from({ length: spec.frames }, (_, i) => new Promise((res) => {
      const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = `fx/${id}/${String(i).padStart(3, '0')}.${spec.ext}`;
    })));
    return builtinFxCache[id];
  }
  let ctrlHeld = false, whipPrev = null, whipOver = false, whipArmed = true, whipDistance = 0, whipDirection = 0, whipMarks = [];
  // 0.8.16: one pet per process. Another pet on the desktop is another Kapi folder running its own exe; the two only
  // meet through the peer file exchange (peer_pets) used for greetings. No second window, no summon, no release.
  const peers = {};   // folder key -> {id, name, rect, t}

  // 0.9.4: the monitor is resolved robustly. On Windows a transparent undecorated window can make currentMonitor()
  // return null; with monRect never set the behaviours' step() returned null forever — no idle life, no strolls, rule
  // walks refused ("the pet sits like a sticker" of the 团团 retro). Order: currentMonitor → monitorFromPoint (window
  // centre) → primaryMonitor → availableMonitors()[0] → window.screen. The monitor's workArea (taskbar excluded) is
  // used whenever the API gives it, so a stroll never ends under the taskbar.
  let monSource = '', monLoggedKey = '', monMissingLogged = false;
  function monToRect(mon, sf) {
    const L = (v) => (v && typeof v.toLogical === 'function') ? v.toLogical(sf) : v;
    const wa = mon.workArea && mon.workArea.position && mon.workArea.size ? mon.workArea : null;
    const p = L(wa ? wa.position : mon.position), s = L(wa ? wa.size : mon.size);
    if (!p || !s || !(s.width > 0) || !(s.height > 0)) return null;
    return { x: p.x, y: p.y, w: s.width, h: s.height, workArea: !!wa };
  }
  async function resolveMonitor(sf) {
    const attempts = [
      ['current', () => currentMonitor()],
      ['point', () => (monitorFromPoint && winRect) ? monitorFromPoint((winRect.x + winRect.w / 2) * sf, (winRect.y + winRect.h / 2) * sf) : null],
      ['primary', () => primaryMonitor()],
      ['available', async () => { const all = await availableMonitors(); return all && all[0]; }],
    ];
    for (const [name, get] of attempts) {
      try { const mon = await get(); const r = mon ? monToRect(mon, sf) : null; if (r) return { name: name + (r.workArea ? '/workArea' : ''), rect: r }; } catch (_) {}
    }
    try {                                                                                   // last resort: the webview's own idea of the screen (CSS px = logical)
      const sc = window.screen;
      if (sc && sc.availWidth > 0 && sc.availHeight > 0) return { name: 'screen', rect: { x: sc.availLeft || 0, y: sc.availTop || 0, w: sc.availWidth, h: sc.availHeight } };
    } catch (_) {}
    return null;
  }
  async function refreshRects() {
    try {
      const sf = await win.scaleFactor();
      const p = (await win.outerPosition()).toLogical(sf), sz = (await win.outerSize()).toLogical(sf);
      winRect = { x: p.x, y: p.y, w: sz.width, h: sz.height };
      const got = await resolveMonitor(sf);
      if (got) {
        monRect = got.rect; monSource = got.name;
        const key = `${got.name} ${Math.round(monRect.x)} ${Math.round(monRect.y)} ${Math.round(monRect.w)} ${Math.round(monRect.h)}`;
        if (key !== monLoggedKey) { monLoggedKey = key; appendLog('monitor ' + key); }
      } else if (!monMissingLogged) { monMissingLogged = true; appendLog('monitor missing'); }
    } catch (_) {}
  }
  const strokeTracker = new StrokeTracker({ minTravel: 20, graceSec: 1.2 });   // 0.9.6: hover stroking, 1.2 s off the pixels before the round ends
  let strokeGlow = null;                                                 // {t0, level} tiny sparkle near the head after a light / medium tier
  let typingGate = new KapiVoice.TypingGate();                           // 0.9.4: one real voice per typing cooldown (re-created per pet)
  let ruleSource = null;                                                 // 'typing' while a typing* rule runs its steps

  const BASE_PAD_TOP = 130, PAD_SIDE = 90;      // 90: room for the +-16 deg swing while dragged (0.8.13)
  let PAD_TOP = BASE_PAD_TOP;
  let careWanted = false, careLayoutTask = Promise.resolve();
  let settings = { scale: 1, activePetId: '', muted: false, alwaysOnTop: true, lookFollow: true };   // 0.9.4: lookFollow (per Kapi folder, like the rest)
  let settingsFile = '';
  let pets = [], pet = null, engine = null, scale = 1, dispW = 0, dispH = 0, hidden = false;
  let lastCursor = null, lastCursorMove = 0, dragging = false, dragStartCursor = null, dragStartWin = null, dragMoved = false, mouseDownAt = 0;
  let grabPoint = null, prevDragV = null;
  let prevCursorForV = null, prevT = 0, lastHitVisible = true, lastIgnoreAt = 0, bubbleTimer = null, bubbleSticky = false, dragV = { x: 0, y: 0, t: 0 };
  let reminderState = {};

  // ---------- helpers ----------
  const toast = (msg, ms = 2500) => { toastEl.textContent = msg; toastEl.style.display = 'block'; clearTimeout(toastEl._t); toastEl._t = setTimeout(() => toastEl.style.display = 'none', ms); };
  // Images are loaded as data: URLs (read by Rust). asset:// images would taint the canvas on Windows and break pixel hit-testing.
  const loadImage = async (path) => {
    let src; try { src = await invoke('read_file_b64', { path }); } catch (e) { try { src = convertFileSrc(path); } catch (_) { return null; } }
    return new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
  };
  let hitTestBroken = false;
  const join = (...p) => p.join(pet && pet.dir.includes('\\') ? '\\' : '/');

  async function loadSettings() {
    settingsFile = await invoke('settings_path');
    try { Object.assign(settings, JSON.parse(await invoke('read_text', { path: settingsFile }))); } catch (_) {}
  }
  async function saveSettings() { try { for (const k of ['token', 'apiBase', 'instanceId', 'url', 'connectedAt']) delete settings[k]; await invoke('write_text', { path: settingsFile, content: JSON.stringify(settings, null, 2) }); } catch (_) {} }

  // ---------- pet loading ----------
  async function loadPet(info) {
    KapiVoice.loadBank();                                              // real animal recordings index (0.8.16), no-op for a human pet
    const manifest = JSON.parse(await invoke('read_text', { path: join(info.dir, 'pet.json') }));
    let persona = {}; try { persona = JSON.parse(await invoke('read_text', { path: join(info.dir, 'persona.json') })); } catch (_) {}
    if (manifest.schema !== 2) throw new Error(I18N.pick(persona.language).needNewer);
    // outfit: state.outfit (user's choice in the wardrobe) > pet.json.outfits.current > default layers/
    let stateOutfit = null; try { stateOutfit = JSON.parse(await invoke('read_text', { path: join(info.dir, 'state.json') })).outfit; } catch (_) {}
    const items = (manifest.outfits && manifest.outfits.items) || {};
    const want = stateOutfit || (manifest.outfits && manifest.outfits.current) || 'default';
    const L = (want !== 'default' && items[want]) ? { ...items[want] } : { ...manifest.layers, look: 'look' };
    currentOutfit = (want !== 'default' && items[want]) ? want : 'default';
    // an outfit that carries its own 8 directions is followed with THOSE frames while worn, even if the default
    // outfit uses a 48-frame ring (the ring was filmed in the default clothes) — 0.8.9
    if (currentOutfit !== 'default' && L.look && manifest.lookFollow && manifest.lookFollow.mode === 'ring') {
      manifest.lookFollow = { ...manifest.lookFollow, mode: 'frames8', holdMs: 80, crossfadeMs: 55 };
    }
    const images = { base: await loadImage(join(info.dir, L.base)), blink: null, look: {}, actions: {} };
    if (L.blink) images.blink = await loadImage(join(info.dir, L.blink));
    images.expressions = {};
    for (const [name, rel] of Object.entries(L.expressions || {})) images.expressions[name] = await loadImage(join(info.dir, rel));
    if (manifest.lookFollow && manifest.lookFollow.mode === 'frames8') {
      for (const d of ['d000', 'd045', 'd090', 'd135', 'd180', 'd225', 'd270', 'd315']) images.look[d] = await loadImage(join(info.dir, L.look || 'look', d + '.png'));
    }
    if (manifest.lookFollow && manifest.lookFollow.mode === 'ring') {
      const n = manifest.lookFollow.ringFrames || 0, rd = (manifest.lookFollow.ringDir || 'look/ring').split('/');
      images.ring = [];
      for (let i = 0; i < n; i++) images.ring.push(await loadImage(join(info.dir, ...rd, String(i).padStart(3, '0') + '.' + (manifest.lookFollow.ext || 'png'))));
    }
    for (const [id, a] of Object.entries(manifest.actions)) {
      if (a.type !== 'frames') continue;
      images.actions[id] = [];
      for (let i = 0; i < a.frames; i++) images.actions[id].push(await loadImage(join(info.dir, a.dir, String(i).padStart(3, '0') + '.' + (a.ext || 'png'))));
    }
    // Start loading video-derived effect frames without holding up pet startup.
    videoFx = {};
    for (const [id, spec] of Object.entries(manifest.effects || {})) {
      if (spec.type !== 'videoFrames') continue;
      const parts = spec.dir.split('/');
      videoFx[id] = Promise.all(Array.from({ length: spec.frames }, (_, i) =>
        loadImage(join(info.dir, ...parts, String(i).padStart(3, '0') + '.' + (spec.ext || 'webp')))));
    }
    // props generated by the skill in the pet's own style (optional; procedural fallbacks otherwise)
    props = { cup: null, flowers: {} };
    const pr = manifest.props || {};
    if (pr.cup) props.cup = await loadImage(join(info.dir, pr.cup));
    for (const k of ['1', '2', '3']) if (pr['flower' + k]) props.flowers[k] = await loadImage(join(info.dir, pr['flower' + k]));
    pet = { ...info, manifest, persona };
    T = I18N.pick(persona.language);
    await loadVoiceIndex();
    typingGate = new KapiVoice.TypingGate(KapiVoice.typingCooldownSec(manifest));   // 0.9.4 pet.json.voice.cooldowns.typingSec (default 60)
    strokeTracker.end(); strokeGlow = null;
    engine = new PetEngine({ manifest, persona, images }, {
      onSay: (text, sticky) => say(text, sticky),
      onAction: () => {},
      onStroke: () => { if (milestones) milestones.record('stroke'); if (growth) growth.record('stroke'); },
      onLog: (line) => appendLog(line),
    });
    engine.setLookEnabled(settings.lookFollow !== false);                 // 0.9.4 settings.lookFollow (default on)
    await setupCare();
    setupInteractions();
    await applyScale();
    await refreshRects();
    beh = new Behaviors({
      getWin: () => winRect, getMonitor: () => monRect, getCursor: () => cursorLogical, engine,
      setWin: () => {}, say: (x, st, opts) => say(x, st, opts), expr: (n, ms) => engine.showExpression(n, ms),
      play: (id) => { if (pet.manifest.actions[id]) engine.play(id); }, line: (k) => care.host.line(k), t,
      react: (kind, vol, source) => reaction(kind, true, vol, source), sfx: (name, vol) => sound(name, vol),      // 0.8.15: every behaviour sounds; 0.9.4: typing-sourced ones are gated
      mood: () => (care ? care.s.mood : 70), busy: () => bubble.style.display === 'block' || careEl.style.display === 'block',   // 0.8.16 idle life
      busyWhy: () => bubble.style.display === 'block' ? 'bubble' : careEl.style.display === 'block' ? 'panel' : null,            // 0.9.4 idle-skipped <reason>
      event: (name, ctx) => fireRule(name, ctx),                                                   // 0.9.3 rules: typingFast / typingLong / lowBattery / greet
      log: (line) => appendLog(line),                                                             // 0.9.4 idle-scheduled / idle-skipped / walk-start / walk-end
    });
    settings.activePetId = info.id; await saveSettings();
    greet();
    setupReminders();
    setupTeachHints();
    if (!settings.hintShown) { setTimeout(() => say(T.hint, true), 2500); settings.hintShown = true; await saveSettings(); }
    await pendingFirstHint();
    typingPermissionHint();
  }

  // ---------- skills still waiting to be hatched (0.8.11) ----------
  // A pet may come home before it has learned to eat / drink / sleep (the user chose to take it home first). The runtime
  // covers those with procedural stand-ins, and the pet itself says, once per version and when the stand-in plays, that
  // it still has things to learn back in the assistant. Derived from the package: a care action that is not real frames.
  const PENDING_IDS = ['eat', 'drink', 'sleep'];
  function pendingSkills() {
    if (!pet) return [];
    const extra = Array.isArray(pet.manifest.pendingSkills) ? pet.manifest.pendingSkills.filter(x => typeof x === 'string') : [];
    return [...PENDING_IDS.filter(id => !(pet.manifest.actions[id] && pet.manifest.actions[id].type === 'frames')), ...extra];
  }
  function pendingLabel(id) { return (T.pending.labels || {})[id] || id; }
  function pendingLine(id) {
    const own = care && care.host.line(id ? 'pending' + id[0].toUpperCase() + id.slice(1) : 'pendingHint');
    if (own) return own;
    const list = pendingSkills().map(pendingLabel);
    return id ? T.pending.one(pendingLabel(id)) : T.pending.all(list);
  }
  async function pendingFirstHint() {
    const list = pendingSkills(); if (!list.length) return;
    const key = pet.id + '@' + pet.manifest.version;
    if ((settings.pendingHinted || []).includes(key)) return;
    settings.pendingHinted = [...(settings.pendingHinted || []), key].slice(-40); await saveSettings();
    setTimeout(() => { if (pet && pet.id + '@' + pet.manifest.version === key) say(pendingLine(null), true); }, settings.hintShown ? 9000 : 4500);
  }
  const pendingSaidAt = {};
  function pendingAfterCare(id) {
    if (!pendingSkills().includes(id)) return;
    const now = Date.now(); if (now - (pendingSaidAt[id] || 0) < 10 * 60000) return;
    pendingSaidAt[id] = now;
    setTimeout(() => say(pendingLine(id)), id === 'sleep' ? 2500 : 3500);
  }

  // ---------- interactions: milestones (click / stroke / flower -> pet-window effects) + typing garden ----------
  function setupInteractions() {
    const stateFile = join(pet.dir, 'state.json');
    const st = care ? care.s : {};                                   // milestones + garden live in the same state.json as care
    interState = st;
    const save = () => { if (care) care.host.save(care.s); else invoke('write_text', { path: stateFile, content: JSON.stringify(st) }).catch(() => {}); };
    const now = () => Date.now() / 1000;
    const lineOr = (key) => care.host.line(key) || (T.inter && T.inter[key]) || '';
    // effects are `queue-one`: one on the canvas at a time, at most one waiting (see effects.js Queue)
    if (fxQueue) fxQueue.clear();
    if (fxAbort) fxAbort.abort();
    fxQueue = new KapiFx.Queue((effect, m) => playEffect(effect, m));
    milestones = new Milestones(pet.manifest.milestones, { now, state: st, save, say: (k) => say(lineOr(k)), fire: (effect, m) => fxQueue.request(effect, m) });
    // the garden grows from typing, so its bud / bloom / pick lines are typing-sourced voices: bubble always, clip only past the typing gate (0.9.4)
    garden = new Garden(pet.manifest.garden, { now, state: st, save, say: (k) => say(lineOr(k), false, { source: 'typing' }), onPick: () => { milestones.record('flower'); if (growth) growth.record('flower'); },
      sfx: (name, vol) => sound(name, vol), react: (kind) => reaction(kind, true, undefined, 'typing') });
    // 0.9.0 growth: today's wishes, finds while away, the diary, sulking, chapters, catch-game records
    const G = T.growth;
    growth = new Growth(st, { now, save, manifest: pet.manifest, care, level: () => (care ? care.s.level : 1), t,
      say: (key, vars) => {
        const own = care.host.line(key === 'wishDone' ? 'wish' + vars.wish[0].toUpperCase() + vars.wish.slice(1) : key);
        const txt = own || (key === 'wishDone' ? G.wishDone[vars.wish] : key === 'findSay' ? G.findSay(vars.name) : G[key]);
        if (txt) say(Array.isArray(txt) ? txt[Math.floor(Math.random() * txt.length)] : txt, key === 'findSay');
        if (key === 'wishDone') fireRule('wishDone', vars); else if (key === 'sulkStart') fireRule('sulk');
      },
      react: (kind) => reaction(kind, true), sfx: (name, vol) => sound(name, vol), fire: (effect) => fxQueue.request(effect, { effect }) });
    rules = new KapiRules(pet.manifest.rules, {
      now, state: st, save, care: () => (care ? { mood: care.s.mood, level: care.s.level, sleeping: care.s.sleeping } : null), species: () => (pet.manifest.voice || {}).species || null,
      play: (id) => { if (pet.manifest.actions[id]) engine.play(id, PET_PRIORITY.user); }, say: (t, sticky) => say(t, sticky, ruleSource ? { source: ruleSource } : undefined), line: (k) => care.host.line(k),
      expr: (n, ms) => engine.showExpression(n, ms), effect: (id) => fxQueue.request(id, { effect: id }), sound: (n) => sound(n, 0.45), react: (k) => reaction(k, true, undefined, ruleSource),
      look: (d) => engine.lookAlong([d, 'base'], 1.5), walk: (w) => ruleWalk(w), hide: () => beh && beh.peek(), come: () => beh && beh.comeHere(),
      mood: (d) => { if (care) { care.s.mood = Math.max(0, Math.min(100, care.s.mood + d)); care.host.save(care.s); } }, toast: (t) => toast(t, 4000),
    });
    setTimeout(() => fireRule('start'), 3000);
    lastInputSec = now();
    const key = pet.id + '@' + pet.manifest.version;
    if (st.growth.seenVersion && st.growth.seenVersion !== key) growth.onPackageChanged();   // a newer package: did it learn something?
    st.growth.seenVersion = key; save();
  }
  /** Head anchor (window px): top-centre of the pet, where the flower sits; and hand anchor for the cup throw. */
  function headPoint() { return { x: PAD_SIDE + dispW / 2, y: PAD_TOP + dispH * 0.04 }; }
  function drawGardenOverlay() {
    if (!garden) return;
    const v = garden.view(); const hp = headPoint(); const size = dispH * 0.22;
    const flowerImg = (st) => props.flowers[String(st)] || null;
    const draw = (x, y, stage, k) => {
      const im = flowerImg(stage);
      const bob = Math.sin(performance.now() / 600) * 2;
      if (im) { const w = size * (stage === 1 ? 0.5 : stage === 2 ? 0.75 : 1) * (k || 1), h = w * im.height / im.width; ctx.drawImage(im, x - w / 2, y - h + bob, w, h); }
      else drawFlower(ctx, x, y - size * 0.5 + bob, size * (k || 1), stage, (pet.manifest.garden || {}).color);
    };
    if (v.pickAnim !== null) {                                       // the flower falls from the head to the ground beside the pet
      const e = v.pickAnim; const gx = PAD_SIDE + dispW * 0.92, gy = PAD_TOP + dispH;
      draw(hp.x + (gx - hp.x) * e, hp.y + (gy - hp.y) * (e * e), 3, 1 - e * 0.4);
    } else if (v.headStage > 0) draw(hp.x, hp.y, v.headStage);
    // the garden: picked flowers on the ground, right of the feet, small
    const n = v.ground.length;
    for (let i = 0; i < n; i++) draw(PAD_SIDE + dispW * (0.86 + i * 0.05), PAD_TOP + dispH, 3, 0.45);
    if (v.total > n) { ctx.font = `${Math.round(dispH * 0.06)}px sans-serif`; ctx.fillStyle = '#6a5'; ctx.textAlign = 'left'; ctx.fillText('+' + (v.total - n), PAD_SIDE + dispW * (0.86 + n * 0.05), PAD_TOP + dispH - dispH * 0.02); }
  }
  /** Play ONE effect in a separate canvas inside the pet window; no fullscreen window is created. Called by the
   *  queue only, so two effects never overlap; a pet switch / resize aborts the running one through fxAbort. */
  // dizzy stars (0.8.13): three little stars orbiting above the head while shaken hard and during the stagger after
  function drawDizzyOverlay() {
    if (!engine || !((engine.drag && engine.drag.dizzy) || engine.dizzyUntil > engine.now())) return;
    const hp = headPoint(); const t = performance.now() / 1000; const r = dispW * 0.22;
    ctx.save(); ctx.fillStyle = '#ffd54a'; ctx.strokeStyle = 'rgba(120,80,0,0.6)'; ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      const a = t * 4.2 + i * Math.PI * 2 / 3; const x = hp.x + Math.cos(a) * r, y = hp.y - 6 + Math.sin(a) * r * 0.35; const s = 6 + 2 * Math.sin(a * 2);
      ctx.beginPath();
      for (let k = 0; k < 10; k++) { const rr = k % 2 ? s * 0.45 : s; const an = -Math.PI / 2 + k * Math.PI / 5; ctx.lineTo(x + Math.cos(an) * rr, y + Math.sin(an) * rr); }
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
  async function playEffect(effect, m) {
    if (fxAbort) fxAbort.abort();
    const run = ++fxRun;
    const controller = new AbortController(); fxAbort = controller;
    try {
      const from = { x: PAD_SIDE + dispW * 0.58, y: PAD_TOP + dispH * 0.62 };
      const dir = 1;
      // any effect id declared in pet.json.effects as videoFrames plays its own frames; without frames the built-in
      // procedural scene plays — bubbleTea included: every pet throws tea (drawn cup, or the pet's own props/cup.png),
      // a real-video version in the package is an upgrade, never a precondition
      let spec = pet.manifest.effects && pet.manifest.effects[effect];
      let framesP = spec && spec.type === 'videoFrames' ? videoFx[effect] : null;
      if (!framesP && BUILTIN_FX[effect]) { spec = BUILTIN_FX[effect]; framesP = loadBuiltinFx(effect); }   // the runtime's own real-video tea
      const isVideo = !!framesP;
      const scene = effect === 'bubbleTea' ? 'throw' : 'fall';
      if (scene === 'throw') sound('whoosh', 0.45); else sound('chime', 0.35);                 // 0.8.15: every effect has its sound
      if (isVideo) { engine.play(pet.manifest.actions[m && m.action] ? m.action : (pet.manifest.actions.throw ? 'throw' : (pet.manifest.actions.wave ? 'wave' : 'nod'))); engine.flip = dir < 0; }
      else engine.showExpression('happy', 3000);
      let frames = null;
      if (isVideo) { try { frames = await framesP; } catch (_) { frames = null; } }
      if (frames && frames.length && !frames.some(f => !f)) {
        if (scene === 'throw') { const hf = spec.hitFrame != null ? spec.hitFrame : Math.floor(frames.length * 0.5); setTimeout(() => { if (run === fxRun && !controller.signal.aborted) sound('splat', 0.55); }, hf * 1000 / spec.fps); }
        const extraTop = (PAD_TOP - BASE_PAD_TOP) * (window.devicePixelRatio || 1);
        await KapiFx.playVideoFrames(fxCtx, fxCanvas.width, fxCanvas.height, frames, spec.fps,
          { signal: controller.signal, viewport: { x: 0, y: extraTop, width: fxCanvas.width, height: fxCanvas.height - extraTop } });
      } else {
        await KapiFx.play(fxCtx, fxCanvas.width, fxCanvas.height, window.devicePixelRatio || 1, effect,
          { from, dir, cup: props.cup, color: (pet.manifest.garden || {}).color, local: true, signal: controller.signal, onHit: () => sound('splat', 0.55) });
      }
    } catch (e) { toast(String(e).slice(0, 80), 3000); }
    finally { if (run === fxRun) { fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height); engine.flip = false; fxAbort = null; } }
  }

  // ---------- care system ----------
  async function setupCare() {
    const stateFile = join(pet.dir, 'state.json');
    let st = null; try { st = JSON.parse(await invoke('read_text', { path: stateFile })); } catch (_) {}
    care = new CareSystem(st, {
      say: (t, sticky) => say(t, sticky), expr: (n, ms) => engine.showExpression(n, ms),
      play: (id) => { if (!pet.manifest.actions[id] && (id === 'eat' || id === 'drink')) pet.manifest.actions[id] = { type: 'procedural', preset: id }; if (pet.manifest.actions[id]) engine.play(id); else engine.play('nod'); pendingAfterCare(id); },
      pending: (id) => pendingAfterCare(id),
      react: (kind, key, chance, fb) => react(kind, key, chance, fb), sfx: (name, vol) => sound(name, vol),
      onCare: (kind) => { if (growth) growth.record(kind === 'feed' ? 'feed' : kind === 'water' ? 'water' : kind === 'sleep' ? 'sleep' : 'stroke'); if (kind === 'sleep') fireRule('sleep'); },
      onLevelUp: (lv) => fireRule('levelUp', { level: lv }), onWake: () => fireRule('wake'),
      setSleeping: (on) => engine.setSleeping(on), setStageScale: async (k) => { stageScale = k; await applyScale(); }, toast: (m) => toast(m, 4000),
      save: (state) => invoke('write_text', { path: stateFile, content: JSON.stringify(state) }).catch(() => {}), t,
      line: (key) => { const L = (pet.persona.lines || {})[key]; return L && L.length ? L[Math.floor(Math.random() * L.length)] : null; },
    });
    stageScale = care.stageScale();
    if (care.s.sleeping) engine.setSleeping(true);
    clearInterval(careTimer);
    careTimer = setInterval(() => {
      const w = care.tick(); if (careEl.style.display === 'block') { care.renderPanel(careEl); queueCareLayout(true); }
      if (w.length && Math.random() < 0.35 && engine.state.action === 'idle' && !care.s.sleeping) {
        const key = w[Math.floor(Math.random() * w.length)];
        reaction(key === 'tired' ? 'sleep' : key === 'lonely' ? 'whine' : 'whine', true); fireRule(key);
        say(care.host.line(key) || T.care.fallback[key]);
        if (key === 'tired') engine.showExpression('sleepy', 2500); else if (key === 'lonely') engine.showExpression('sad', 2500); else engine.showExpression('sad', 1500);
      }
    }, 60000);
  }
  function queueCareLayout(open) {
    careWanted = open;
    careLayoutTask = careLayoutTask.then(() => careWanted === open ? layoutTop() : null)
      .catch((e) => { careEl.style.visibility = ''; console.warn('top layout:', e); });
    return careLayoutTask;
  }
  function openCare() { if (!care) return; if (beh) beh.stopWalk('interrupted'); care.renderPanel(careEl); careEl.style.visibility = 'hidden'; careEl.style.display = 'block'; return queueCareLayout(true); }
  function closeCare() { careEl.style.display = 'none'; careEl.style.visibility = ''; return queueCareLayout(false); }
  // ---- the space above the pet: one vertical stack (content top -> bubble), care card above all ----
  // contentOverhang: how far the drawn content (pet, flower on its head, props) reaches ABOVE the pad line, measured
  // from the stage canvas alpha (so a generated flower prop of any size counts), refreshed while an overlay is open.
  let contentOverhang = 0, overhangAt = 0, topBlocked = false;
  function measureOverhang() {
    const dpr = window.devicePixelRatio || 1;
    const rows = Math.min(canvas.height, Math.round((PAD_TOP + dispH * 0.5) * dpr));
    if (rows <= 0 || canvas.width <= 0) return;
    try {
      const data = ctx.getImageData(0, 0, canvas.width, rows).data;
      let top = -1;
      for (let y = 0; y < rows && top < 0; y += 2) {
        const row = y * canvas.width * 4;
        for (let x = 3; x < canvas.width * 4; x += 16) if (data[row + x] > 25) { top = y; break; }
      }
      contentOverhang = top < 0 ? 0 : Math.max(0, PAD_TOP - top / dpr);
    } catch (_) { contentOverhang = Math.max(contentOverhang, dispH * 0.26); }   // tainted canvas: assume a full-size flower
    overhangAt = performance.now();
  }
  function overlayItems() {
    const items = [];
    if (bubble.style.display === 'block') items.push({ id: 'bubble', h: bubble.offsetHeight + 7 });
    return items;
  }
  function requiredPad() {
    let need = BASE_PAD_TOP;
    if (careEl.style.display === 'block') need = Math.max(need, CareLayout.topPadding(careEl.getBoundingClientRect().bottom));
    const items = overlayItems();
    if (items.length) need = Math.max(need, CareLayout.stack(contentOverhang, items).needPad);
    return need;
  }
  async function layoutTop() {
    if (!pet) return;
    if (overlayItems().length) measureOverhang();
    const newPad = requiredPad();
    topBlocked = false;
    if (newPad !== PAD_TOP) {
      const sf = await win.scaleFactor();
      const oldPos = (await win.outerPosition()).toLogical(sf);
      const petTop = oldPos.y + PAD_TOP;
      const monitorTop = monRect ? monRect.y : -Infinity;                     // 0.9.4: the resolved monitor (work area), never a null currentMonitor()
      if (newPad > PAD_TOP && CareLayout.blocked(petTop, newPad, monitorTop) && careEl.style.display !== 'block') {
        topBlocked = true;                                   // no room above: overlays go beside / below instead (positionBubble)
      } else {
        PAD_TOP = newPad;
        await resizeStage();
        await win.setPosition(new LogicalPosition(Math.round(oldPos.x), CareLayout.windowTop(petTop, PAD_TOP, monitorTop)));
        await refreshRects();
      }
    }
    if (careWanted && careEl.style.display === 'block') careEl.style.visibility = '';
  }
  careEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-care]'); if (b) { care.do(b.dataset.care); care.renderPanel(careEl); queueCareLayout(true); return; }
    if (e.target.dataset.close) closeCare();
  });
  pawEl.addEventListener('click', () => careEl.style.display === 'block' ? closeCare() : openCare());

  async function applyScale() {
    if (fxAbort) fxAbort.abort();
    const m = pet.manifest; const [cw, ch] = m.render.canvas;
    scale = (m.render.displayHeight * (settings.scale || 1) * (stageScale || 1)) / ch;
    dispW = Math.round(cw * scale); dispH = Math.round(ch * scale);
    await resizeStage();
  }
  async function resizeStage() {
    const W = dispW + PAD_SIDE * 2, H = dispH + PAD_TOP;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    fxCanvas.width = W * dpr; fxCanvas.height = H * dpr; fxCanvas.style.width = W + 'px'; fxCanvas.style.height = H + 'px';
    whipCanvas.width = W * dpr; whipCanvas.height = H * dpr; whipCanvas.style.width = W + 'px'; whipCanvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    whipCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    await win.setSize(new LogicalSize(W, H));
  }

  // ---------- render loop ----------
  function render() {
    if (engine) {
      engine.update();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      engine.draw(ctx, scale, PAD_SIDE, PAD_TOP);
      drawGardenOverlay();
      if (catchGame) { stepCatchGame(); drawCatchGame(); }
      drawFindOverlay();
      drawDizzyOverlay();
      drawStrokeGlow();
      drawWhip();
      positionBubble();
    }
    requestAnimationFrame(render);
  }

  function petAlphaAt(x, y) { // x,y in CSS px inside window
    const dpr = window.devicePixelRatio || 1;
    if (!hitTestBroken) {
      try { return ctx.getImageData(Math.floor(x * dpr), Math.floor(y * dpr), 1, 1).data[3]; }
      catch (e) { hitTestBroken = true; toast('hit-test fallback: ' + String(e).slice(0, 60), 4000); }
    }
    // fallback: the pet's bounding box counts as solid, so interaction never dies
    return (x >= PAD_SIDE && x <= PAD_SIDE + dispW && y >= PAD_TOP && y <= PAD_TOP + dispH) ? 255 : 0;
  }

  // ---------- 30Hz poll: cursor -> hit test (pass-through) + look-follow + drag ----------
  // 0.8.12: the whip is drawn as a real lash — a tapered leather cord trailing the cursor with inertia (the last
  // ~350 ms of cursor positions), a stubby handle at the cursor, a sag when the hand is still, and a white snap at
  // the hit point. The old version only drew the strike streaks, which read as "brown scribbles".
  let whipTrail = [], whipFlash = null;
  function drawWhip() {
    const now = performance.now();
    whipMarks = whipMarks.filter(m => now - m.at < 220);
    whipTrail = whipTrail.filter(q => now - q.t < 350);
    whipCtx.clearRect(0, 0, whipCanvas.width, whipCanvas.height);
    if (ctrlHeld && whipTrail.length) {
      const pts = whipTrail.slice().reverse();                      // newest first = handle end
      const head = pts[0];
      // still hand: let the lash hang (gravity) instead of vanishing
      let path = pts;
      const moved = pts.length > 1 ? Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) : 0;
      if (moved < 12) {
        const sway = Math.sin(now / 260) * 6;
        path = [head, { x: head.x + 10 + sway, y: head.y + 22 }, { x: head.x + 14 + sway * 1.5, y: head.y + 48 }, { x: head.x + 10 + sway * 2, y: head.y + 72 }];
      } else {
        // stretch a short trail into a proper lash length (~90 px) along its own direction
        const tail = pts[pts.length - 1]; const len = Math.hypot(head.x - tail.x, head.y - tail.y);
        if (len < 90) { const ux = (tail.x - head.x) / (len || 1), uy = (tail.y - head.y) / (len || 1); path = pts.concat([{ x: tail.x + ux * (90 - len), y: tail.y + uy * (90 - len) + 8 }]); }
      }
      // smooth polyline through midpoints, drawn in segments with a tapering width (thick at the handle, hair-thin tip)
      const segs = [];
      for (let i = 0; i < path.length - 1; i++) {
        const p0 = path[i], p1 = path[i + 1];
        const m0 = i === 0 ? p0 : { x: (path[i - 1].x + p0.x) / 2, y: (path[i - 1].y + p0.y) / 2 };
        const m1 = i === path.length - 2 ? p1 : { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
        segs.push({ m0, c: p0, m1 });
      }
      const n = segs.length;
      whipCtx.lineCap = 'round'; whipCtx.lineJoin = 'round';
      segs.forEach((sg, i) => {
        const k = i / Math.max(1, n - 1);
        const w = 5.5 * (1 - k) + 0.8;
        whipCtx.strokeStyle = 'rgba(52,30,22,0.95)'; whipCtx.lineWidth = w;
        whipCtx.beginPath(); whipCtx.moveTo(sg.m0.x, sg.m0.y); whipCtx.quadraticCurveTo(sg.c.x, sg.c.y, sg.m1.x, sg.m1.y); whipCtx.stroke();
        if (w > 1.6) { whipCtx.strokeStyle = 'rgba(190,130,80,0.55)'; whipCtx.lineWidth = Math.max(0.6, w * 0.35); whipCtx.stroke(); }
      });
      // handle: a short thick grip at the cursor, pointing away from the lash
      const dirx = head.x - path[1].x, diry = head.y - path[1].y; const dl = Math.hypot(dirx, diry) || 1;
      whipCtx.strokeStyle = '#3a2418'; whipCtx.lineWidth = 8; whipCtx.beginPath(); whipCtx.moveTo(head.x, head.y); whipCtx.lineTo(head.x + dirx / dl * 14, head.y + diry / dl * 14); whipCtx.stroke();
      whipCtx.strokeStyle = '#b77b49'; whipCtx.lineWidth = 3; whipCtx.stroke();
    }
    for (const m of whipMarks) {                                    // welts where it landed
      const fade = 1 - (now - m.at) / 220;
      whipCtx.lineCap = 'round'; whipCtx.strokeStyle = `rgba(220,80,70,${fade * 0.7})`; whipCtx.lineWidth = 3 * fade + 1;
      whipCtx.beginPath(); whipCtx.moveTo(m.x0, m.y0); whipCtx.lineTo(m.x1, m.y1); whipCtx.stroke();
    }
    if (whipFlash && now - whipFlash.at < 160) {                   // the snap
      const f = 1 - (now - whipFlash.at) / 160; const r = 6 + 16 * (1 - f);
      whipCtx.strokeStyle = `rgba(255,255,255,${f})`; whipCtx.lineWidth = 2;
      for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 + 0.3; whipCtx.beginPath(); whipCtx.moveTo(whipFlash.x + Math.cos(a) * r * 0.4, whipFlash.y + Math.sin(a) * r * 0.4); whipCtx.lineTo(whipFlash.x + Math.cos(a) * r, whipFlash.y + Math.sin(a) * r); whipCtx.stroke(); }
    } else if (whipFlash) whipFlash = null;
  }
  function updateWhip(x, y, overPet) {
    if (!ctrlHeld || dragging) { whipPrev = null; whipOver = false; whipArmed = true; whipDistance = 0; whipTrail = []; return; }
    whipTrail.push({ x, y, t: performance.now() }); if (whipTrail.length > 14) whipTrail.shift();
    const prev = whipPrev; whipPrev = { x, y };
    if (!overPet) { whipOver = false; whipArmed = true; whipDistance = 0; return; }
    if (!prev) { whipOver = true; return; }
    const dx = x - prev.x, dy = y - prev.y, distance = Math.hypot(dx, dy);
    if (distance < 2) return;
    const direction = Math.sign(Math.abs(dx) > Math.abs(dy) ? dx : dy);
    if (whipDirection && direction !== whipDirection) { whipArmed = true; whipDistance = 0; }
    whipDirection = direction;
    whipDistance += distance;
    whipMarks.push({ x0: prev.x, y0: prev.y, x1: x, y1: y, at: performance.now() });
    if (whipArmed && whipDistance >= 22) {
      whipArmed = false; whipDistance = 0;
      engine.userInput(); engine.play(pet.manifest.actions.whipReact ? 'whipReact' : 'shake', PET_PRIORITY.user);
      engine.showExpression('surprised', 900);
      // sound: the whip crack (procedural) and the pet's own "ouch" (recorded whipReact clip when the pack has one,
      // else a short babble in the pet's timbre) — both on every valid hit, both silent when muted
      if (!settings.muted) KapiVoice.whipCrack(0.6);
      react('hit', 'whipReact', REACT_CHANCE.hit, (T.inter && T.inter.whipReact) || '!'); if (growth) growth.record('whip');
      whipFlash = { x, y, at: performance.now() };
    }
    whipOver = true;
  }
  // Poll diagnostics (0.8.12): the v4/v5 "after summoning a second pet the first one stops following the mouse and
  // taking clicks, while typing effects still fire" means THIS loop stopped completing — everything else lives in
  // other timers. Every stage is isolated and counted, so one failing IPC call (pass-through, cursor, position) can
  // no longer silently kill look-follow for the rest of the session; a watchdog forces the window clickable when the
  // loop has not completed for 3 s; the tray「诊断」item shows and saves what failed.
  const pollDiag = { ok: 0, lastOkAt: 0, fails: {}, lastErr: '', toasted: false };
  let pawShownUntil = 0; const nowSec = () => performance.now() / 1000;
  function pollFail(stage, e) {
    pollDiag.fails[stage] = (pollDiag.fails[stage] || 0) + 1; pollDiag.lastErr = stage + ': ' + (e && e.message ? e.message : String(e));
    if (!pollDiag.toasted && pollDiag.fails[stage] >= 30) { pollDiag.toasted = true; toast('鼠标跟随出错（' + stage + '）：' + pollDiag.lastErr.slice(0, 120), 6000); saveDebugLog(); }
  }
  async function appendLog(line) {
    try {
      const path = settingsFile.replace(/settings[^/\\]*\.json$/, 'kapi-debug.log');
      let prev = ''; try { prev = await invoke('read_text', { path }); } catch (_) {}
      const lines = (prev ? prev.split('\n') : []).filter(Boolean).slice(-120); lines.push(new Date().toISOString() + ' ' + line);
      await invoke('write_text', { path, content: lines.join('\n') + '\n' });
    } catch (_) {}
  }
  async function saveDebugLog() {
    try {
      let local = null, alpha = null;
      try { if (cursorLogical && winRect) { local = { x: cursorLogical.x - winRect.x, y: cursorLogical.y - winRect.y }; alpha = petAlphaAt(local.x, local.y); } } catch (_) {}
      const line = JSON.stringify({ at: new Date().toISOString(), label: win.label, pet: pet && pet.id, engine: !!engine, hidden, dragging, cursor: cursorLogical, local, alpha, win: winRect,
                                    ignoreCursorEvents: lastHitVisible === null ? null : !lastHitVisible, diag: pollDiag, peers: Object.keys(peers) });
      const path = settingsFile.replace(/settings[^/\\]*\.json$/, 'kapi-debug.log');   // settings-<hash>.json since 0.8.16
      let prev = ''; try { prev = await invoke('read_text', { path }); } catch (_) {}
      const lines = (prev ? prev.split('\n') : []).filter(Boolean).slice(-80); lines.push(line);
      await invoke('write_text', { path, content: lines.join('\n') + '\n' });
      return path;
    } catch (_) { return ''; }
  }
  async function poll() {
    if (!engine || hidden) { if (hidden) endStroke('hidden'); return; }   // 0.9.6: no samples while hidden -> the round must not hang on
    let sf, cp, wp;
    try { sf = await win.scaleFactor(); cp = (await cursorPosition()).toLogical(sf); wp = (await win.outerPosition()).toLogical(sf); }
    catch (e) { pollFail('cursor', e); return; }
    const lx = cp.x - wp.x, ly = cp.y - wp.y;
    const t = performance.now() / 1000;
    cursorLogical = cp; if (winRect) { winRect.x = wp.x; winRect.y = wp.y; }
    if (!lastCursor || lastCursor.x !== cp.x || lastCursor.y !== cp.y) { lastCursorMove = t; engine.userInput && (engine.lastInput = t); }
    lastCursor = cp;

    if (dragging) {
      try {
        const nx = dragStartWin.x + (cp.x - dragStartCursor.x), ny = dragStartWin.y + (cp.y - dragStartCursor.y);
        if (!dragMoved) {
          // 0.9.6: the button means one thing only — pick it up. Petting is a hover stroke (see the hit-test branch
          // below), so nothing has to be told apart here any more and the threshold is back to the simple, reliable
          // 0.9.3 one. 0.9.4 arbitrated between "stroking" and "lifting" inside the press, and at this poll rate the
          // first sample was already past every stroke-friendly threshold: the pet got picked up, never petted.
          const ddx = cp.x - dragStartCursor.x, ddy = cp.y - dragStartCursor.y;
          if (Math.hypot(ddx, ddy) > 10) { dragMoved = true; appendLog('drag-start'); }
        }
        if (dragMoved) {
          if (!engine.drag.active) { engine.dragStart(grabPoint); prevDragV = null; }
          await win.setPosition(new LogicalPosition(nx, ny));
          if (prevCursorForV) {
            const dtv = Math.max(0.016, t - prevT); dragV = { x: (cp.x - prevCursorForV.x) / dtv, y: (cp.y - prevCursorForV.y) / dtv, t };
            const ax = prevDragV ? (dragV.x - prevDragV.x) / dtv : 0, ay = prevDragV ? (dragV.y - prevDragV.y) / dtv : 0; prevDragV = dragV;
            engine.dragMove(dragV.x, dragV.y, ax / Math.max(1e-6, scale), ay / Math.max(1e-6, scale));   // canvas px / s^2
          }
        }
        prevCursorForV = cp; prevT = t;
      } catch (e) { pollFail('drag', e); }
      return;
    }
    // look-follow FIRST: vector from head point (top 25% of pet) to cursor — never behind an IPC call that may fail
    const headX = PAD_SIDE + dispW / 2, headY = PAD_TOP + dispH * 0.25;
    if (engine.lookEnabled !== false) { try { engine.setLookVector(lx - headX, ly - headY); } catch (e) { pollFail('look', e); } }   // 0.9.4: off = no angle polling at all
    // hit test against drawn pixels (pet body + bubble)
    let visible = true;
    try {
      const inWin = lx >= 0 && ly >= 0 && lx < canvas.clientWidth && ly < canvas.clientHeight;
      const overUi = inWin && isOver(bubble, lx, ly);
      const overPet = inWin && petAlphaAt(lx, ly) > 25;
      canvas.style.cursor = ctrlHeld ? 'crosshair' : '';          // the lash itself is drawn on the whip canvas (0.8.12)
      updateWhip(lx, ly, overPet);
      engine.hover = overPet;
      // the 🐾 button stays for a moment after the cursor leaves the pet (the way to it crosses transparent pixels),
      // and stays while the cursor is on it — otherwise it vanished mid-way and could never be reached (0.8.12)
      const overPaw = isOver(pawEl, lx, ly);
      if (overPet || overUi || overPaw || careEl.style.display === 'block') pawShownUntil = nowSec() + 0.8;
      pawEl.style.display = nowSec() < pawShownUntil ? 'flex' : 'none';
      // Petting (0.9.6, as before 0.9.4): no button at all — the bare cursor sweeping back and forth across opaque pet
      // pixels is the stroke. Every hover sample feeds the tracker; `over` false keeps the round alive for graceSec so
      // a turn that clips a transparent corner still counts. Ctrl belongs to the whip and sleep must not be tickled.
      // Catch the light is excluded too: chasing the dot sweeps the cursor across the pet exactly like a stroke, which
      // would hand out hearts and growth for playing and fight the game's own hit reaction for the face.
      const asleep = !!(care && care.s.sleeping);
      if (!dragging && !ctrlHeld && !asleep && !catchGame) {
        if (overPet && !strokeTracker.active) { strokeTracker.press(lx, t); logStrokeStart(); }
        if (strokeTracker.active) {
          const before = strokeTracker.count;
          const tier = strokeTracker.move(lx, t, overPet, false);
          if (tier) { appendLog(`stroke-tier ${tier} count=${strokeTracker.count}`); strokeTier(tier); }
          else if (!strokeTracker.active && before) appendLog(`stroke-end away count=${before}`);   // > graceSec off the opaque pixels
        }
      } else endStroke(ctrlHeld ? 'ctrl' : catchGame ? 'game' : 'sleep');   // a held button already ended it in mousedown
      visible = overPet || overUi || (careEl.style.display === 'block' && isOver(careEl, lx, ly)) || isOver(pawEl, lx, ly);
    } catch (e) { pollFail('hit', e); }
    // Pass-through is re-asserted every 1.5 s even when unchanged: the OS-side flag and our memory of it can drift
    // (seen after a second pet window was opened — pets kept animating but no window took clicks). Each window only
    // ever sets ITS OWN flag from ITS OWN pixels.
    const nowMs = performance.now();
    if (visible !== lastHitVisible || nowMs - lastIgnoreAt > 1500) {
      lastHitVisible = visible; lastIgnoreAt = nowMs;
      try { await win.setIgnoreCursorEvents(!visible); } catch (e) { pollFail('passthrough', e); lastHitVisible = null; }
    }
    pollDiag.ok++; pollDiag.lastOkAt = nowMs;
  }
  // watchdog: if the loop has not completed for 3 s while the window is shown, make it clickable (safe default) and note it
  // 0.9.5 (Mac P0: 没有宠物时窗口吞掉所有点击，只能强制退出): poll() and the watchdog below both bail out on !engine, and the
  // boot path's restore call used to sit in the else branch — so an empty, invisible, always-on-top window stayed
  // click-opaque forever and swallowed every click under it (the Finder window behind it included). This guard is
  // independent of the pet: no engine -> the window must be click-through, no matter how we got there.
  setInterval(async () => {
    if (engine || hidden) return;
    try { await win.setIgnoreCursorEvents(true); } catch (_) {}
  }, 1500);
  setInterval(async () => {
    if (!engine || hidden) return;
    if (pollDiag.lastOkAt && performance.now() - pollDiag.lastOkAt > 3000) {
      pollDiag.fails.watchdog = (pollDiag.fails.watchdog || 0) + 1; lastHitVisible = null; lastIgnoreAt = 0;
      try { await win.setIgnoreCursorEvents(false); } catch (_) {}
      if (pollDiag.fails.watchdog === 1) saveDebugLog();
    }
  }, 1500);
  function isOver(el, x, y) { if (el.style.display === 'none' || !el.offsetParent) return false; const r = el.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }
  setInterval(poll, 33);
  let lastStep = performance.now();
  setInterval(async () => {
    if (!beh || dragging) { lastStep = performance.now(); return; }          // a missing rect is beh.step's business: it returns null and logs idle-skipped norect
    const now = performance.now(); const dt = Math.min(0.1, (now - lastStep) / 1000); lastStep = now;
    const r = beh.step(dt); if (!r) { engine.extraRot = 0; if (engine.walking) { engine.setWalking(false); engine.flip = false; } return; }
    const walking = !!r.walking && (beh.mode === 'walk' || beh.follow);                    // 0.9.2: real walk cycle while strolling (not while flying / peeking)
    engine.flip = walking ? engine.walkFlip(!!r.flip) : !!r.flip; engine.extraRot = r.rot || 0;   // 0.9.4: honours actions.walk.facing
    engine.setWalking(walking);
    winRect.x = r.x; winRect.y = r.y;
    try { await win.setPosition(new LogicalPosition(Math.round(r.x), Math.round(r.y))); }
    catch (e) {                                                                            // the window would not move: never keep the legs going on the spot
      if (beh.mode === 'walk') { beh.stopWalk('failed'); appendLog('walk setPosition failed: ' + (e && e.message ? e.message : e)); }
      engine.setWalking(false); engine.flip = false; return;
    }
    if (r.arrived === 'walk' || r.landed) { engine.flip = false; engine.setWalking(false); }
    if (r.landed) fireRule('landed');
  }, 33);
  setInterval(refreshRects, 2000);

  // ---------- mouse ----------
  canvas.addEventListener('mousedown', async (e) => {
    if (!engine || e.button !== 0) return;
    if (catchGame && catchHit(e.clientX, e.clientY)) return;              // 0.9.0: a click on the light scores, never starts a drag
    if (petAlphaAt(e.clientX, e.clientY) <= 25) return;
    if (beh) beh.stopWalk('interrupted');                                  // a hand on it ends any stroll at once (0.9.4)
    if (engine.walking) { engine.setWalking(false); engine.flip = false; }
    const sf = await win.scaleFactor();
    dragStartCursor = (await cursorPosition()).toLogical(sf); dragStartWin = (await win.outerPosition()).toLogical(sf);
    dragging = true; dragMoved = false; mouseDownAt = performance.now(); prevCursorForV = null;
    grabPoint = { x: (e.clientX - PAD_SIDE) / Math.max(1e-6, scale), y: (e.clientY - PAD_TOP) / Math.max(1e-6, scale) };
    endStroke('press');                                                    // 0.9.6: a button down is never a stroke, it is a grab
  });
  // 0.9.6 stroking is hover-only (see poll()): 3 reversals = a light touch, 10 = a visible reaction, 15 = the heart +
  // the `pet` growth event. The care system's 2-minute `pet` cooldown still rules the reward: inside it the heart is
  // only visual (no growth, no voice).
  // Log throttling, same idea as 0.9.4's `idle-skipped`: the cursor crosses the pet constantly on its way elsewhere, and
  // appendLog rewrites the whole 120-line file per call. A round that never counted a reversal is just the cursor
  // passing by, so only its (throttled) start is worth a line — otherwise the lines that matter get evicted.
  let strokeStartLoggedAt = 0;
  function logStrokeStart() {
    const now = performance.now();
    if (now - strokeStartLoggedAt < 2000) return;
    strokeStartLoggedAt = now; appendLog('stroke-start');
  }
  function endStroke(why) {
    if (!strokeTracker.active) return;
    const n = strokeTracker.end();
    if (n) appendLog(`stroke-end ${why} count=${n}`);
  }
  function strokeTier(tier) {
    if (!engine || !care) return;
    engine.userInput();
    const now = performance.now();
    if (tier === 'light') { engine.showExpression('shy', 700); strokeGlow = { t0: now, level: 1 }; return; }
    if (tier === 'medium') { engine.showExpression('shy', 900); setTimeout(() => engine.showExpression('happy', 1500), 900); strokeGlow = { t0: now, level: 2 }; return; }
    strokeGlow = { t0: now, level: 3 };
    if (care.can('pet')) { if (engine.stroke()) care.do('pet', { silent: true }); }   // shy → happy, line / voice (chance), milestone heart effect, growth + mood + wish
    else {
      engine.showExpression('shy', 1000); setTimeout(() => engine.showExpression('happy', 1500), 1000);
      const m = (pet.manifest.milestones || []).find(x => x.event === 'stroke');
      if (fxQueue) fxQueue.request((m && m.effect) || 'hearts', { effect: (m && m.effect) || 'hearts' });   // the visual heart, nothing counted twice
    }
  }
  function drawStrokeGlow() {
    if (!strokeGlow) return; const age = (performance.now() - strokeGlow.t0) / 1000; const dur = 0.7 + strokeGlow.level * 0.15;
    if (age > dur) { strokeGlow = null; return; }
    const hp = headPoint(); const n = strokeGlow.level * 2; const fade = 1 - age / dur;
    ctx.save(); ctx.globalAlpha = fade * 0.9; ctx.fillStyle = strokeGlow.level >= 3 ? '#ff8fb4' : '#ffe27a';
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + strokeGlow.t0 / 700; const r = dispW * (0.18 + 0.08 * strokeGlow.level) * (0.6 + age / dur * 0.6);
      const x = hp.x + Math.cos(a) * r, y = hp.y + dispH * 0.12 + Math.sin(a) * r * 0.45; const s = 2.5 + strokeGlow.level * 0.8;
      ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.35, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s * 0.35, y); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
  window.addEventListener('mouseup', async (e) => {
    if (!dragging) return;                                                  // 0.9.6: the stroke round ended at mousedown; the hover poll starts a fresh one
    dragging = false;
    if (dragMoved) {
      engine.dragEnd(); await refreshRects();
      const fresh = performance.now() / 1000 - dragV.t < 0.15;
      if (beh && fresh && beh.throwWith(dragV.x, dragV.y)) { /* physics takes over */ }
      else if (beh && beh.checkEdgeAfterDrag()) { /* cling then climb back */ }
      else await keepOnScreen();
    }
    else if (performance.now() - mouseDownAt < 400) { appendLog('click');   // short press, never became a drag (0.9.6 log)
      if (beh && beh.mode === 'peek') beh.unpeek(); else if (care && care.s.sleeping) care.wake(false); else if (growth && growth.sulking()) { engine.showExpression('angry', 1500); const L = T.growth.sulkIgnore; say(L[Math.floor(Math.random() * L.length)]); growth.record('click'); }
      else { engine.click((e.clientY - PAD_TOP) / Math.max(1, dispH)); if (milestones) milestones.record('click'); if (growth) growth.record('click'); fireRule('click'); } }
  });
  // no double-click action (0.8.12): quick repeated clicks used to pop the care panel by accident; the panel opens only
  // from the 🐾 button and the right-click menu
  canvas.addEventListener('contextmenu', async (e) => { e.preventDefault(); if (petAlphaAt(e.clientX, e.clientY) > 25) await showMenu(); });

  async function keepOnScreen() {
    try {
      const sf = await win.scaleFactor(); if (!monRect) await refreshRects(); const m = monRect; if (!m) return;
      const wp = (await win.outerPosition()).toLogical(sf), ws = (await win.outerSize()).toLogical(sf);
      const x = Math.min(Math.max(wp.x, m.x - ws.width + 40), m.x + m.w - 40), y = Math.min(Math.max(wp.y, m.y - PAD_TOP), m.y + m.h - 40);
      if (x !== wp.x || y !== wp.y) await win.setPosition(new LogicalPosition(x, y));
    } catch (_) {}
  }

  // ---------- bubble ----------
  function say(text, sticky, opts) {
    if (!text) return; clearTimeout(bubbleTimer);
    bubble.textContent = text; bubble.style.display = 'block'; bubbleSticky = !!sticky; bubble.classList.toggle('sticky', bubbleSticky);
    queueCareLayout(careEl.style.display === 'block');
    if (!sticky) bubbleTimer = setTimeout(hideBubble, Math.min(8000, 1500 + text.length * 120));
    speak(text, opts);
  }
  function hideBubble() { bubble.style.display = 'none'; bubbleSticky = false; queueCareLayout(careEl.style.display === 'block'); }
  bubble.addEventListener('click', () => { if (bubbleSticky) hideBubble(); });
  function positionBubble() {
    const cx = PAD_SIDE + dispW / 2;
    bubble.style.left = cx + 'px';
    const items = overlayItems();
    if (!items.length) return;
    if (performance.now() - overhangAt > 150) { const before = requiredPad(); measureOverhang(); if (requiredPad() !== before) queueCareLayout(careEl.style.display === 'block'); }
    const st = CareLayout.stack(contentOverhang, items).tops;
    if ('bubble' in st) bubble.style.top = Math.max(CareLayout.EDGE, PAD_TOP + st.bubble) + 'px';
  }
  let voiceIndex = {}, currentAudio = null;
  async function loadVoiceIndex() {
    voiceIndex = {};
    try { voiceIndex = JSON.parse(await invoke('read_text', { path: join(pet.dir, 'voice', 'index.json') })); } catch (_) {}
  }
  let speakSeq = 0, lastSpeakAt = 0;
  let currentBabble = null;
  function stopVoice() {
    if (currentAudio) { try { currentAudio.pause(); currentAudio.currentTime = 0; } catch (_) {} currentAudio = null; }
    if (currentBabble) { try { currentBabble.stop(); } catch (_) {} currentBabble = null; }
  }
  // One voice kind per pet (pet.json.voice.kind): 'tts' plays the pre-rendered clip and stays SILENT for lines without one
  // (chat replies), 'babble' synthesises every line, 'none' is silent. The system speech voice is gone on purpose: it
  // sounded different on every machine and mixed a second voice into the same pet.
  // opts.force: skip the 700 ms rapid-fire throttle (a whip hit must sound on every valid hit);
  // opts.hit: a tts pet without a recorded clip for this line gets a short babble "ouch" in its own timbre instead of silence.
  async function speak(text, opts) {
    opts = opts || {};
    if (settings.muted || !text) return;
    const now = performance.now();
    if (!opts.force && now - lastSpeakAt < 700) return;   // rapid-fire lines (stroking, multi-click): keep the bubble, skip the audio
    if (opts.source === 'typing' && !typingGate.allow(now / 1000)) return;   // 0.9.4: typing-sourced voice in cooldown — the bubble already shows
    lastSpeakAt = now;
    const seq = ++speakSeq;
    stopVoice();                                     // never two voices at once
    const kind = KapiVoice.voiceKind(pet.manifest, voiceIndex);
    if (kind === 'none') return;
    const v = pet.manifest.voice || {};
    if (kind === 'babble') {
      if (v.species) {                                                                                                       // a real animal: its own recorded call (0.8.16), synth only as fallback
        const real = KapiVoice.playAnimal(v.species, opts.hit ? 'hit' : 'talk', { text, seed: seq, volume: opts.hit ? 0.6 : 0.5 });
        if (real) { currentBabble = real; return; }
      }
      const plan = v.species ? KapiVoice.planAnimal(v.species, opts.hit ? 'hit' : 'talk', { text, hz: v.baseHz, seed: seq })          // a real animal meows / barks its line (0.8.14)
                 : opts.hit ? KapiVoice.planHit({ preset: v.preset || 'bright', hz: v.baseHz ? v.baseHz * 1.45 : undefined, seed: seq })
                            : KapiVoice.planBabble(text, { preset: v.preset || 'bright', hz: v.baseHz, rate: v.rate });
      currentBabble = KapiVoice.renderBabble(plan, opts.hit ? 0.55 : 0.45); return;
    }
    const rel = voiceIndex[text];
    if (!rel) {                                      // tts pet, no clip for this line: a wordless sound in its own timbre, never silence (0.8.15)
      if (opts.hit) currentBabble = KapiVoice.renderBabble(KapiVoice.planHit({ preset: v.preset || 'female', seed: seq }), 0.55);
      else currentBabble = KapiVoice.renderBabble(KapiVoice.planReaction(opts.kind || 'click', { preset: v.preset || 'female', hz: v.baseHz, seed: seq }), 0.4);
      return;
    }
    try {
      const src = await invoke('read_file_b64', { path: join(pet.dir, rel) });
      if (seq !== speakSeq) return;                  // a newer line arrived while loading
      stopVoice(); currentAudio = new Audio(src); currentAudio.volume = 0.9; await currentAudio.play();
    } catch (_) {}
  }
  // ---------- 0.8.12: every touch sounds at once, words only sometimes ----------
  // A wordless reaction in the pet's own timbre plays on EVERY physical interaction (click / stroke / drag / drop /
  // whip / feed / drink / sleep): instant, no clip to load, never throttled away. A spoken line (bubble + recorded
  // clip) follows only with probability `chance` — a pet that talks on every poke is a jukebox, one that hums on
  // every poke and sometimes says something is alive. Babble pets (animals) babble the line itself when chosen.
  const REACT_CHANCE = { click: 0.35, clickBody: 0.35, clickMany: 1, stroke: 0.25, dragStart: 0.3, dragEnd: 0.45, hit: 0.3 };
  const REACT_KIND = { click: 'click', clickBody: 'click', clickMany: 'angry', stroke: 'stroke', dragStart: 'drag', dragEnd: 'drop', hit: 'hit' };
  let lastReactAt = 0, reactSeq = 0;
  function reaction(kind, force, volume, source) {
    if (settings.muted || !pet) return;
    const now = performance.now();
    if (!force && now - lastReactAt < 160) return;
    lastReactAt = now;
    if (currentAudio && !currentAudio.paused && !currentAudio.ended) return;    // a spoken line is playing: don't talk over it
    if (source === 'typing' && !typingGate.allow(now / 1000)) return;          // 0.9.4: the per-nod "mrp" and the typing startle share the typing gate
    const k = KapiVoice.voiceKind(pet.manifest, voiceIndex); if (k === 'none') return;
    const v = pet.manifest.voice || {};
    if (currentBabble) { try { currentBabble.stop(); } catch (_) {} }
    if (v.species) { const real = KapiVoice.playAnimal(v.species, kind, { seed: ++reactSeq, volume }); if (real) { currentBabble = real; return; } }   // recorded call first (0.8.16)
    const plan = v.species ? KapiVoice.planAnimal(v.species, kind, { hz: v.baseHz, seed: ++reactSeq })
                           : KapiVoice.planReaction(kind, { preset: v.preset || (k === 'babble' ? 'bright' : 'female'), hz: v.baseHz, seed: ++reactSeq });
    currentBabble = KapiVoice.renderBabble(plan, volume != null ? volume : kind === 'hit' ? 0.55 : 0.42);
  }
  /** Scene sound (thud / whoosh / splat / pop / bloom / pluck / chime / fanfare / knock): not the pet's voice, so it
   *  plays even for voice.kind = none and alongside a line; only the mute switch silences it. */
  function sound(name, volume) { if (settings.muted || !pet) return; try { KapiVoice.sfx(name, volume); } catch (_) {} }
  function react(event, lineKey, chance, fallbackText) {
    if (event === 'clickMany') fireRule('clickMany', { clicks: engine && engine.clickTimes ? engine.clickTimes.length : 4 });
    else if (event === 'dragStart' || event === 'dragEnd' || event === 'stroke') fireRule(event);
    const kind = REACT_KIND[event] || event;
    const p = chance == null ? (REACT_CHANCE[event] == null ? 0.35 : REACT_CHANCE[event]) : chance;
    const line = lineKey ? (care && care.host.line(lineKey)) || fallbackText || null : null;
    if (line && Math.random() < p) { say(line, false, { force: kind === 'hit', hit: kind === 'hit', kind }); return; }
    reaction(kind, kind === 'hit');
  }

  // ---------- 0.9.1: typing reactions need the Accessibility permission on macOS; never block the pet on it ----------
  async function enableTyping() {
    try { const ok = await invoke('request_input_permission'); toast(ok ? T.perm.on : T.perm.howTo, ok ? 3000 : 12000); } catch (e) { toast(String(e), 4000); }
  }
  async function typingPermissionHint() {
    try {
      const st = await invoke('input_watcher_state');
      if (!st || !st.macos || st.active || settings.typingHintShown) return;
      settings.typingHintShown = true; await saveSettings();
      setTimeout(() => toast(T.perm.hint, 10000), 6000);
    } catch (_) {}
  }
  listen('input-watcher', (e) => { const p = e.payload || {}; if (p.active) toast(T.perm.on, 3000); });

  // ---------- 0.9.3: pet.json.rules — the package's own "when X, do Y" ----------
  function fireRule(event, ctx) {
    // a typing / typingFast / typingLong rule's say / react steps are typing-sourced voices (0.9.4): same gate as the rest
    const prev = ruleSource; ruleSource = /^typing/.test(event) ? 'typing' : null;
    try { if (rules) return rules.fire(event, ctx || {}); } catch (_) {} finally { ruleSource = prev; }
    return [];
  }
  function ruleWalk(where) {
    if (!beh || !winRect || !monRect) return;
    const m = monRect, w = winRect;
    if (where === 'cursor') beh.comeHere();
    else if (where === 'left') beh.walkTo(m.x + 8, w.y);
    else if (where === 'right') beh.walkTo(m.x + m.w - w.w - 8, w.y);
    else if (where === 'edge') beh.peek();
    else beh.wander();
  }
  // time / hourly / idle / app: one slow timer
  setInterval(() => {
    if (!rules || !engine) return;
    const d = new Date(); const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (hhmm !== lastRuleMinute) { lastRuleMinute = hhmm; fireRule('time'); if (d.getMinutes() === 0) fireRule('hourly'); fireRule('idle', { minutes: Math.floor((performance.now() / 1000 - (engine.lastInput || 0)) / 60) }); }
  }, 20000);

  // ---------- 0.9.0: the notebook window, finds, the catch game ----------
  // 0.9.3: the notebook window exists from start-up (hidden); opening it is show + "which pet". Everything that
  // protects the pet runs INDEPENDENTLY of the command's promise: the 1.5 s restore and the 8 s timeout are
  // scheduled before the invoke, so a stuck IPC can no longer take the pet's mouse with it. Log points:
  // notebook-click → (native: window-shown) → dom-ready → window-loaded | load-error | timeout → interaction-restored.
  let notebookWait = null;
  async function restoreInteraction(why) {
    lastHitVisible = null; lastIgnoreAt = 0;
    try { await win.setIgnoreCursorEvents(false); } catch (_) {}
    appendLog('interaction-restored ' + why);
  }
  function notebookSettled(ok, why) {
    if (!notebookWait) return; const w = notebookWait; notebookWait = null; clearTimeout(w.timeout);
    if (!ok) { toast(T.notebookFail ? T.notebookFail(why) : `小本子没打开：${why}`, 6000); invoke('close_panel_window').catch(() => {}); }
  }
  async function openNotebook() {
    if (!pet) return toast(T.noPet, 6000);
    appendLog('notebook-click'); if (beh) beh.stopWalk('interrupted');
    if (notebookWait) { appendLog('notebook-click ignored (pending)'); return; }
    const restoreTimer = setTimeout(() => restoreInteraction('1.5s watchdog'), 1500);
    notebookWait = { timeout: setTimeout(() => { appendLog('timeout notebook (no dom-ready/loaded in 8 s)'); notebookSettled(false, 'timeout'); restoreInteraction('timeout'); }, 8000) };
    try {
      await invoke('open_panel_window', { petDir: pet.dir, lang: pet.persona.language || 'zh-CN' });
      appendLog('open_panel_window returned');
    } catch (e) {
      appendLog('load-error open_panel_window: ' + e); notebookSettled(false, String(e)); clearTimeout(restoreTimer); restoreInteraction('open failed');
    } finally {
      if (growth) growth.record('panel');
    }
  }
  listen('notebook-ready', (e) => { appendLog('dom-ready notebook ' + JSON.stringify(e.payload || {})); });
  listen('notebook-loaded', (e) => {
    const p = e.payload || {};
    if (p.ok) { appendLog('window-loaded notebook ' + (p.dir || '')); notebookSettled(true, ''); }
    else { appendLog('load-error notebook: ' + (p.error || '?')); notebookSettled(false, p.error || 'load failed'); }
  });
  listen('aux-window', (e) => { const p = e.payload || {}; if (!p.ok) toast(`${p.label}: ${p.error || 'failed'}`, 6000); appendLog(`aux-window ${p.label} ok=${p.ok} ${p.error || ''}`); });
  /** It brings the find to you: the emoji floats up from its paws and stays 6 s, with its line. */
  function showFind(f) {
    const G = T.growth; findShow = { emoji: f.emoji, t0: performance.now(), page: !!f.page };
    const name = (G.find[f.id] || f.id) + (f.new ? G.findNew : '');
    engine.showExpression('happy', 3000); engine.play('jump', PET_PRIORITY.user); sound('chime', 0.35);
    say(G.findSay(name), true);
    if (f.page) setTimeout(() => { say(G.findPage, true); sound('fanfare', 0.45); }, 6500);
  }
  function drawFindOverlay() {
    if (!findShow) return; const age = (performance.now() - findShow.t0) / 1000; if (age > 6) { findShow = null; return; }
    const hp = headPoint(); const y = PAD_TOP + dispH * 0.62 - Math.min(1, age / 0.6) * dispH * 0.25 + Math.sin(age * 3) * 3;
    const x = PAD_SIDE + dispW * 0.72; const a = age > 5.2 ? (6 - age) / 0.8 : 1;
    ctx.save(); ctx.globalAlpha = a; ctx.font = `${Math.round(Math.max(22, dispW * 0.16))}px system-ui, "Apple Color Emoji", "Segoe UI Emoji"`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(findShow.emoji, x, y); ctx.restore();
  }
  // Catch the light (0.9.4): a bright dot wanders inside the window for pet.json.catchLight.durationSec (default 10 s,
  // 5-60); every click on it scores, the pet lunges with its species' move (catchLightConfig). One duration drives the
  // countdown, the settlement, the wish and the restart; the score target scales with it (10 s -> 8 points).
  // The dot is drawn on the stage canvas so the hit test (which decides click-through) counts it as solid.
  function catchCfg() { return catchLightConfig(pet.manifest); }
  function startCatchGame() {
    if (!engine || catchGame || (care && care.s.sleeping)) return false;
    const G = T.growth; const cfg = catchCfg();
    if (beh) beh.stopWalk('interrupted');
    catchFaceCancel();
    catchGame = { round: new CatchRound(cfg, performance.now() / 1000), cfg, x: PAD_SIDE + dispW * 0.5, y: PAD_TOP + dispH * 0.5, tx: 0, ty: 0, nextMove: 0, hitAt: 0, r: Math.max(14, dispW * 0.07) };
    pickDot(); say(G.game.start(cfg.durationSec)); sound('pop', 0.4); engine.showExpression('surprised', 1500);
    appendLog(`catch-start ${cfg.durationSec}s target ${cfg.target} action ${cfg.action} (${cfg.actionSource}, ${cfg.species})`);
    if (milestones) milestones.record('game');
    return true;
  }
  function pickDot() {
    const g = catchGame; g.tx = PAD_SIDE + 20 + Math.random() * (dispW - 40); g.ty = PAD_TOP + 20 + Math.random() * (dispH * 0.95 - 40); g.nextMove = performance.now() + 700 + Math.random() * 900;
  }
  function stepCatchGame() {
    const g = catchGame; if (!g) return; const now = performance.now();
    if (g.round.tick(now / 1000)) { endCatchGame(); return; }
    if (now > g.nextMove) pickDot();
    const k = 1 - Math.exp(-0.12); g.x += (g.tx - g.x) * k; g.y += (g.ty - g.y) * k;
    // the pet keeps its eyes on the dot
    try { engine.setLookVector(g.x - (PAD_SIDE + dispW / 2), g.y - (PAD_TOP + dispH * 0.25)); } catch (_) {}
  }
  function drawCatchGame() {
    const g = catchGame; if (!g) return; const now = performance.now();
    const pulse = 1 + 0.12 * Math.sin(now / 90); const r = g.r * pulse; const hit = now - g.hitAt < 220;
    ctx.save();
    const grd = ctx.createRadialGradient(g.x, g.y, 0, g.x, g.y, r * 1.8); grd.addColorStop(0, hit ? 'rgba(255,255,255,1)' : 'rgba(255,240,150,0.95)'); grd.addColorStop(0.5, 'rgba(255,200,60,0.6)'); grd.addColorStop(1, 'rgba(255,200,60,0)');
    ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(g.x, g.y, r * 1.8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = hit ? '#fff' : '#ffe27a'; ctx.beginPath(); ctx.arc(g.x, g.y, r * 0.55, 0, Math.PI * 2); ctx.fill();
    // score + time, top-right
    ctx.font = '600 13px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(40,38,36,0.85)';
    const label = `${g.round.score}  ·  ${Math.ceil(g.round.remaining(now / 1000))}s`; const w = ctx.measureText(label).width + 14; const bx = PAD_SIDE + dispW - 4;
    ctx.fillStyle = 'rgba(255,252,247,0.92)'; ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(bx - w, PAD_TOP + 4, w, 20, 10); else ctx.rect(bx - w, PAD_TOP + 4, w, 20); ctx.fill();
    ctx.fillStyle = '#2c2b29'; ctx.fillText(label, bx - 7, PAD_TOP + 18);
    ctx.restore();
  }
  function catchHit(x, y) {
    const g = catchGame; if (!g) return false;
    if (Math.hypot(x - g.x, y - g.y) > g.r * 1.6) { appendLog('catch-miss'); return false; }   // a click next to the dot: no score, no face (0.9.6)
    if (!g.round.hit()) return true;
    g.hitAt = performance.now(); pickDot(); sound('pop', 0.35); reaction('happy', true, 0.3);
    engine.play(pet.manifest.actions[g.cfg.action] ? g.cfg.action : 'jump', PET_PRIORITY.user);
    catchFace();                                                           // 0.9.6: a hit is also a face, not just a score
    appendLog(`catch-hit score=${g.round.score}`);
    return true;
  }
  // 0.9.6: the lunge alone read as "nothing happened" — a hit now shows surprise, then delight. Rapid hits REPLACE the
  // running reaction instead of queueing (one handle, cleared first), so a good streak never strobes the face.
  function catchFace() {
    clearTimeout(catchFaceTimer);
    catchFaceTimer = setTimeout(() => {
      engine.showExpression('surprised', 450);
      catchFaceTimer = setTimeout(() => { catchFaceTimer = null; engine.showExpression('happy', 900); }, 450);
    }, 100);
  }
  function catchFaceCancel() { clearTimeout(catchFaceTimer); catchFaceTimer = null; }
  function endCatchGame() {
    const g = catchGame; catchGame = null; if (!g) return; const G = T.growth; const score = g.round.score, cfg = g.cfg;
    const best = growth ? (growth.st.growth.best.catch || 0) : 0;
    if (growth) growth.record('game', score);                                  // one settlement per round: catchGame is null from here on
    // one closing face on top of the usual settlement line; the per-hit reaction is dropped so it cannot overwrite it,
    // and every expression carries its own duration, so the pet is back to its pre-game face when it expires (0.9.6)
    catchFaceCancel();
    const won = score >= cfg.target;
    say(G.game.over(score, best), false); sound(score >= best && score > 0 ? 'fanfare' : 'chime', 0.4);
    engine.showExpression(won ? 'happy' : (Math.random() < 0.5 ? 'sleepy' : 'shy'), 2500);
    appendLog(`catch-end score=${score} ${won ? 'win' : 'ok'} ${score}/${cfg.target} in ${cfg.durationSec}s`);
    // "I want to learn …" only where the move fits the character: cats a pounce, birds a peck, people a tap; others just settle
    if (score >= cfg.target && cfg.learnKey && growth && !growth.st.growth.catchAsked) { growth.st.growth.catchAsked = cfg.learnKey; const line = G.game[cfg.learnKey]; if (line) setTimeout(() => say(line, true), 4000); }
  }

  function greet() {
    const h = new Date().getHours(); const k = h < 12 ? 'greetingMorning' : h >= 21 ? 'greetingEvening' : null;
    if (k && (pet.persona.lines || {})[k]) setTimeout(() => engine.sayFrom(k), 1200);
  }

  // ---------- occasional "you can keep teaching me" hint (rare, idle only, never while sleeping / talking) ----------
  let teachTimer = null;
  function setupTeachHints() {
    clearInterval(teachTimer);
    teachTimer = setInterval(() => {
      if (!engine || hidden || engine.state.action !== 'idle' || (care && care.s.sleeping) || bubble.style.display === 'block') return;
      if (performance.now() / 1000 - (engine.lastInput || 0) < 120) return;        // only when the user has been quiet for a while
      if (Math.random() > 0.35) return;
      if (pendingSkills().length) { say(pendingLine(null)); return; }
      const own = care.host.line('teachHint');
      const pool = T.teach.hints || [];
      say(own || pool[Math.floor(Math.random() * pool.length)]);
    }, 25 * 60000);
  }

  // ---------- reminders ----------
  function setupReminders() {
    clearInterval(reminderState.timer); reminderState = { timer: null, last: {} };
    const rs = pet.persona.reminders || []; if (!rs.length) return;
    reminderState.timer = setInterval(() => {
      const now = new Date(); const h = now.getHours(); const t = now.getTime();
      for (const r of rs) {
        const [a, b] = r.activeHours || [0, 24]; if (h < a || h >= b) continue;
        let due = false;
        if (r.everyMin) due = !reminderState.last[r.id] || t - reminderState.last[r.id] >= r.everyMin * 60000;
        if (r.at) { const [hh, mm] = r.at.split(':').map(Number); due = now.getHours() === hh && now.getMinutes() === mm && (!reminderState.last[r.id] || t - reminderState.last[r.id] > 60000); }
        if (!due) continue;
        reminderState.last[r.id] = t;
        if (r.action && pet.manifest.actions[r.action]) engine.play(r.action, PET_PRIORITY.user); else engine.play('nod', PET_PRIORITY.user);
        say(r.say || T.reminder, true);
      }
    }, 15000);
    for (const r of rs) if (r.everyMin) reminderState.last[r.id] = Date.now();
  }

  // ---------- menus / tray ----------
  async function showMenu() {
    const { Menu, MenuItem, PredefinedMenuItem, Submenu, CheckMenuItem } = window.__TAURI__.menu;
    const frameActions = Object.entries(pet.manifest.actions).filter(([, a]) => a.type === 'frames').map(([id]) => id);
    const actionItems = await Promise.all(frameActions.map(id => MenuItem.new({ text: id, action: () => requestPlay(id, 'menu') })));   // a cycle (walk) = a real stroll
    const scaleItems = await Promise.all([0.5, 0.75, 1, 1.5, 2].map(s => CheckMenuItem.new({ text: Math.round(s * 100) + '%', checked: Math.abs(settings.scale - s) < 0.01, action: async () => { settings.scale = s; await saveSettings(); await applyScale(); } })));
    const items = [
      await MenuItem.new({ text: T.menu.care(pet.name), action: openCare }),
      await MenuItem.new({ text: T.growth.menu, action: openNotebook }),
      await MenuItem.new({ text: T.growth.play, action: startCatchGame }),
      await Submenu.new({ text: T.menu.actions, items: actionItems.length ? actionItems : [await MenuItem.new({ text: T.teach.empty, action: teachExport })] }),
      await Submenu.new({ text: T.menu.size, items: scaleItems }),
      await CheckMenuItem.new({ text: T.menu.mute, checked: settings.muted, action: async () => { settings.muted = !settings.muted; await saveSettings(); } }),
      await CheckMenuItem.new({ text: T.menu.onTop, checked: settings.alwaysOnTop, action: async () => { settings.alwaysOnTop = !settings.alwaysOnTop; await win.setAlwaysOnTop(settings.alwaysOnTop); await saveSettings(); } }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await CheckMenuItem.new({ text: beh && beh.follow ? T.menu2.unfollow : T.menu2.follow, checked: !!(beh && beh.follow), action: () => beh && beh.setFollow(!beh.follow) }),
      await MenuItem.new({ text: T.menu2.come, action: () => beh && beh.comeHere() }),
      await MenuItem.new({ text: T.menu2.hide, action: () => beh && beh.peek() }),
      ...(pet.manifest.features && pet.manifest.features.perchOnWindow ? [await CheckMenuItem.new({ text: T.menu2.perch, checked: !!(beh && beh.mode === 'perch'), action: () => beh && beh.setPerch(beh.mode !== 'perch') })] : []),   // 0.9.2: off unless the pack opts in
      ...(hasLookAssets() ? [await CheckMenuItem.new({ text: settings.lookFollow !== false ? T.menu2.lookOn : T.menu2.lookOff, checked: settings.lookFollow !== false, action: () => setLookFollow(settings.lookFollow === false) })] : []),   // 0.9.4
      ...(await wardrobeItems()),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await MenuItem.new({ text: T.menu.import, action: importPet }),
      ...((pets || []).length > 1 ? [await MenuItem.new({ text: T.menu.switch, action: switchPet })] : []),   // 0.9.5: one folder = one pet, so hide it unless this copy really has several
      await MenuItem.new({ text: T.teach.menu, action: teachExport }),
      await MenuItem.new({ text: T.teach.guide, action: openGuide }),
      await MenuItem.new({ text: T.menu.export, action: exportPet }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await MenuItem.new({ text: T.menu.hide, action: toggleHidden }),
      await MenuItem.new({ text: T.menu.quit, action: () => win.close() }),
    ];
    const menu = await Menu.new({ items });
    await menu.popup();
  }
  async function wardrobeItems() {
    const { CheckMenuItem, Submenu } = window.__TAURI__.menu;
    const items = (pet.manifest.outfits && pet.manifest.outfits.items) || {};
    const names = Object.keys(items); if (!names.length) return [];
    const label = (id) => (pet.manifest.wardrobe || []).find(w => w.id === id)?.name || id;
    const entries = await Promise.all(['default', ...names].map(id => CheckMenuItem.new({ text: id === 'default' ? T.wardrobe.default : label(id), checked: currentOutfit === id,
      action: async () => { care.s.outfit = id === 'default' ? null : id; await care.host.save(care.s); await loadPet(pet); } })));
    return [await Submenu.new({ text: T.wardrobe.menu, items: entries })];
  }
  async function importPet(path) {
    try {
      if (!path) path = await window.__TAURI__.dialog.open({ multiple: false, filters: [{ name: 'Kapi pet package', extensions: ['petpack', 'capapet', 'zip'] }] });
      if (!path) return;
      let localState = null;
      if (pet && care) localState = { ...care.s };
      const info = await invoke('import_pet', { path });
      // keep live stats from the running pet; only the ticket ledger (and wardrobe choice) comes from the package
      if (localState && info.id === pet.id) {
        let pkgState = null; try { pkgState = JSON.parse(await invoke('read_text', { path: join(info.dir, 'state.json') })); } catch (_) {}
        const merged = { ...localState };
        if (pkgState) { const tmp = new CareSystem(merged, care.host); tmp.mergeLedger(pkgState); Object.assign(merged, tmp.s); if (pkgState.outfit !== undefined) merged.outfit = pkgState.outfit; }
        await invoke('write_text', { path: join(info.dir, 'state.json'), content: JSON.stringify(merged) });
      }
      const updated = pet && info.id === pet.id && Number(info.version) > Number(pet.manifest.version);
      toast(T.imported(info.name, info.version));
      pets = await invoke('list_pets'); await loadPet(info);
      if (updated) setTimeout(() => say(care.host.line('learnedNew') || T.teach.learned, true), 1800);
    } catch (e) { toast(T.importFail + e, 5000); }
  }
  async function switchPet() {
    pets = await invoke('list_pets'); if (pets.length < 2) return toast(T.onlyOne);
    const i = pets.findIndex(p => p.id === pet.id); await loadPet(pets[(i + 1) % pets.length]); toast(T.switched(pet.name));
  }
  async function teachExport() {
    if (!pet) return toast(T.noPet, 6000);
    try {
      const desktop = await window.__TAURI__.path.desktopDir();
      const file = `${pet.id}-v${pet.manifest.version}.petpack`;
      const out = join(desktop.replace(/[\\/]$/, ''), file);
      await invoke('export_pet', { dir: pet.dir, outPath: out });
      say(T.teach.done(file), true);
      try { await window.__TAURI__.opener.revealItemInDir(out); } catch (_) {}
    } catch (e) { toast(T.exportFail + e, 5000); }
  }
  async function openGuide() {
    for (const n of ['说明.txt', 'GUIDE.txt']) {
      try { await invoke('read_text', { path: join(pet.dir, n) }); await window.__TAURI__.opener.openPath(join(pet.dir, n)); return; } catch (_) {}
    }
    toast(T.teach.guideMissing);
  }
  async function exportPet() {
    if (!pet) return toast(T.noPet, 6000);                                   // tray export with no pet used to throw silently
    const out = await window.__TAURI__.dialog.save({ defaultPath: `${pet.id}-v${pet.manifest.version}.petpack` }); if (!out) return;
    try { await invoke('export_pet', { dir: pet.dir, outPath: out }); toast(T.exported); } catch (e) { toast(T.exportFail + e, 5000); }
  }
  async function toggleHidden() { hidden = !hidden; if (hidden) { if (fxQueue) fxQueue.clear(); if (fxAbort) fxAbort.abort(); await win.hide(); } else { await win.show(); } }
  // (the old "设置" window is gone in 0.8.12: its only control, display size, lives in the right-click 大小 submenu)
  listen('tray', async (e) => {
    const id = e.payload;
    if (id === 'toggle') toggleHidden(); else if (id === 'notebook') openNotebook(); else if (id === 'typing') enableTyping(); else if (id === 'import') importPet(); else if (id === 'switch') switchPet(); else if (id === 'export') exportPet();
    else if (id === 'diagnose') { const path = await saveDebugLog(); toast(`${pet ? `${pet.name} ${pet.id} v${pet.manifest.version}${pet.manifest.build ? '/b' + pet.manifest.build : ''} ← ${pet.dir}` : '无宠物'} · poll ok ${pollDiag.ok} · 失败 ${JSON.stringify(pollDiag.fails)} · ${pollDiag.lastErr || '无错误'} · 穿透=${lastHitVisible === null ? '?' : !lastHitVisible} · 日志 ${path}`, 9000); }
    else if (id === 'recover') { lastHitVisible = true; lastIgnoreAt = 0; try { await win.setIgnoreCursorEvents(false); } catch (_) {} hidden = false; try { await win.show(); } catch (_) {} }
  });
  // ---------- 0.9.4 look-follow switch + the notebook's command protocol ----------
  function hasLookAssets() {
    if (!pet || !engine) return false; const lf = pet.manifest.lookFollow || {};
    return (lf.mode === 'frames8' && !!(engine.img.look && Object.values(engine.img.look).some(Boolean))) || (lf.mode === 'ring' && !!(engine.img.ring && engine.img.ring.length));
  }
  async function setLookFollow(on) {
    settings.lookFollow = on !== false; await saveSettings();
    if (engine) engine.setLookEnabled(settings.lookFollow);                 // off: base frame, no direction frames; on: the package config as it was
    appendLog('look-follow ' + (settings.lookFollow ? 'on' : 'off'));
  }
  /** What the notebook may ask the pet to do. Returns {ok, reason}. reason: unknown | busy | sleeping | noWalk | cooldown | invalid */
  function playBusy() {
    if (!engine) return 'unknown';
    if (care && care.s.sleeping) return 'sleeping';
    if (beh && beh.mode === 'walk') return 'busy';
    if (engine.state.action !== 'idle' && engine.state.prio >= PET_PRIORITY.user) return 'busy';   // a user-priority move is running: one at a time
    return null;
  }
  function requestPlay(id, from) {
    if (!pet || !engine) return { ok: false, reason: 'unknown' };
    const a = pet.manifest.actions[id];
    const performable = PET_PERFORMABLE;                                    // shared with panel.html (engine.js owns the list)
    const valid = a && (a.type === 'frames' || (a.type === 'procedural' && performable.includes(a.preset)));
    if (!valid) return { ok: false, reason: 'unknown' };
    const busy = playBusy(); if (busy && !(busy === 'sleeping' && id === 'sleep')) return { ok: false, reason: busy };   // "sleep" while asleep = the wake button
    if (id === 'eat' || id === 'drink' || id === 'sleep') {                  // care moves go through the care flow: props, cooldowns, xp, wishes
      const kind = id === 'eat' ? 'feed' : id === 'drink' ? 'water' : 'sleep';
      if (kind !== 'sleep' && !care.can(kind)) return { ok: false, reason: 'cooldown' };
      const ok = care.do(kind); if (careEl.style.display === 'block') { care.renderPanel(careEl); queueCareLayout(true); }
      return { ok: !!ok, reason: ok ? '' : 'cooldown' };
    }
    if (a.cycle) {                                                          // walk = a real stroll through the movement state machine, never frames on the spot
      if (!beh || !winRect || !monRect) return { ok: false, reason: 'noWalk' };
      if (!engine.hasWalkCycle()) return { ok: false, reason: 'noWalk' };
      return { ok: !!beh.wander(), reason: '' };
    }
    engine.userInput();
    return { ok: !!engine.play(id, PET_PRIORITY.user), reason: '' };
  }
  function panelAck(cmd, action, r) { try { emit('panel-ack', { cmd, action: action || '', ok: !!r.ok, reason: r.ok ? '' : (r.reason || 'rejected') }); } catch (_) {} }
  // panel-cmd payloads: {cmd:'play', action} | {cmd:'expr', name} | {cmd:'voice'} | {cmd:'lookFollow', on} | {cmd:'game'} | {cmd:'care'}
  // every one is answered with panel-ack {cmd, action, ok, reason}; anything else is rejected with reason 'rejected'
  listen('panel-cmd', async (e) => {
    const p = e.payload || {}; const c = p.cmd;
    if (!pet || !engine) { panelAck(c, p.action, { ok: false, reason: 'unknown' }); return; }
    if (c === 'game') { panelAck(c, '', { ok: startCatchGame(), reason: 'busy' }); return; }
    if (c === 'care') { openCare(); panelAck(c, '', { ok: true }); return; }
    if (c === 'play') { const id = typeof p.action === 'string' ? p.action : ''; const r = requestPlay(id, 'panel'); appendLog(`panel play ${id} -> ${r.ok ? 'ok' : r.reason}`); if (!r.ok && T.panelCmd && T.panelCmd[r.reason]) toast(T.panelCmd[r.reason], 3000); panelAck(c, id, r); return; }
    if (c === 'expr') {
      const name = typeof p.name === 'string' ? p.name : ''; const ok = !!(engine.img.expressions && engine.img.expressions[name]);
      if (ok) engine.showExpression(name, 2500); panelAck(c, name, { ok, reason: 'unknown' }); return;
    }
    if (c === 'voice') { reaction('click', true); panelAck(c, '', { ok: true }); return; }   // mute + cooldown still apply inside reaction()
    if (c === 'lookFollow') { if (!hasLookAssets()) { panelAck(c, '', { ok: false, reason: 'unknown' }); return; } await setLookFollow(p.on !== false); panelAck(c, settings.lookFollow ? 'on' : 'off', { ok: true }); return; }
    panelAck(c, p.action, { ok: false, reason: 'rejected' });
  });
  listen('modifier-state', (e) => { ctrlHeld = !!(e.payload && e.payload.ctrl); if (ctrlHeld) endStroke('ctrl'); if (!ctrlHeld) { whipPrev = null; whipMarks = []; whipTrail = []; whipFlash = null; drawWhip(); } });
  // 0.8.16: the user clicking around the desktop (not on the pet): a glance that way, a startle on a click burst
  listen('mouse-press', async (e) => {
    if (!engine || !beh || hidden) return; const p = e.payload || {};
    try { const sf = await win.scaleFactor(); const x = p.x / sf, y = p.y / sf; if (winRect && x >= winRect.x && x <= winRect.x + winRect.w && y >= winRect.y && y <= winRect.y + winRect.h) return; const dc = beh.onDesktopClick(p.button, x, y); if (dc) fireRule('desktopClick', { kind: dc }); } catch (_) {}
  });
  listen('user-input', (e) => {
    if (!engine) return; const p = e.payload || {}; engine.lastInput = performance.now() / 1000;
    if (beh) beh.onTyping(p.keys || 0); if (p.keys && garden) garden.onTypingSecond(p.keys);
    if (growth) {                                                          // 0.9.0: typing counts toward a wish; coming back after a while may bring a find
      const nowS = Date.now() / 1000; const gap = nowS - (lastInputSec || nowS); lastInputSec = nowS;
      if (p.keys) growth.record('type', p.keys); else growth.record('input');
      if (p.keys) fireRule('typing', { keys: p.keys });
      if (gap >= GROWTH_DEFS.FIND_MIN_ABSENT) { const f = growth.onReturn(gap); if (f) showFind(f); }
    }
  });
  // (the typing sound itself comes from Behaviors.onTyping -> host.react('typing'): one soft note per nod, never while sleeping)
  // peers (0.8.16): publish our rect, read the other Kapi processes' rects; greet when one walks into us
  rectTimer = setInterval(async () => {
    if (!pet || !winRect) return;
    try {
      const list = await invoke('peer_pets', { id: pet.id, name: pet.name, rect: winRect });
      const seen = {};
      for (const p of list) { seen[p.key] = 1; peers[p.key] = p; if (beh) beh.onOtherPet(p.key, p.rect, p.name); }
      for (const k of Object.keys(peers)) if (!seen[k]) delete peers[k];
    } catch (_) {}
  }, 1000);
  batteryTimer = setInterval(async () => { if (!beh) return; try { beh.onBattery(await invoke('battery_status')); } catch (_) {} }, 60000);
  // Foreground-window tracking. The pet itself becomes the foreground window the moment the user right-clicks it, so
  // "sit on the window" must use the last *other* window the user was in (remembered here at all times), not the
  // window that is active when the menu item fires. While perched the pet is forced on top so it stays visible on
  // maximised windows; the user's own always-on-top setting is restored on unperch.
  let lastForeign = null, perchTopForced = false;
  perchTimer = setInterval(async () => {
    if (!beh) return;
    try {
      const r = await invoke('active_window');
      if (r && r.w > 0 && !/^kapi$/i.test((r.app || '').replace(/\.exe$/i, '')) && !/^kapi(\s|$)/i.test(r.title || '')) {
        const sf = await win.scaleFactor(); lastForeign = { x: r.x / sf, y: r.y / sf, w: r.w / sf, h: r.h / sf, at: Date.now() };
        const appKey = String(r.app || '').toLowerCase();                   // 0.9.3: rules see the foreground app when it changes
        if (appKey && appKey !== lastAppKey) { lastAppKey = appKey; fireRule('app', { app: r.app, title: r.title }); }
      }
      const perching = beh.mode === 'perch';
      if (perching && !perchTopForced) { perchTopForced = true; await win.setAlwaysOnTop(true); }
      if (!perching && perchTopForced) { perchTopForced = false; await win.setAlwaysOnTop(!!settings.alwaysOnTop); }
      if (!perching) return;
      if (lastForeign) beh.perchOn(lastForeign, PAD_TOP + dispH, winRect ? winRect.w : dispW + PAD_SIDE * 2);
      else beh.perchNoWindow();
    } catch (_) { if (beh.mode === 'perch') beh.perchNoWindow(); }
  }, 1000);
  listen('settings-changed', async () => { await loadSettings(); await win.setAlwaysOnTop(!!settings.alwaysOnTop); if (pet) await applyScale(); });
  // files dragged over / onto the pet (0.8.16): a .petpack is imported; anything else is "a gift" it sniffs at
  let giftAt = 0;
  win.onDragDropEvent(async (e) => {
    const p = e.payload || {};
    if (p.type === 'enter' && engine && !engine.sleeping) { engine.showExpression('surprised', 1500); if (performance.now() - giftAt > 8000) { giftAt = performance.now(); reaction('surprise', true, 0.35); } return; }
    if (p.type !== 'drop' || !p.paths?.length) return;
    if (/\.petpack$/i.test(p.paths[0])) { await importPet(p.paths[0]); return; }
    if (!engine) return;
    fireRule('fileDrop', { ext: String(p.paths[0]).split('.').pop(), path: p.paths[0] });
    engine.showExpression('happy', 2500); engine.play('jump', PET_PRIORITY.user); if (milestones) milestones.record('gift'); if (growth) growth.record('gift');
    react('happy', 'gift', 0.8, T.beh.gift);
  });

  // ---------- boot ----------
  try { await win.setIgnoreCursorEvents(false); } catch (_) {}      // known starting state for the pet window
  await loadSettings();
  await win.setAlwaysOnTop(!!settings.alwaysOnTop);
  pets = await invoke('list_pets');
  let launch = null; try { launch = await invoke('launch_info'); } catch (_) {}
  if (!pets.length) {
    try { await win.setIgnoreCursorEvents(true); } catch (_) {}            // 0.9.5: first thing, before anything can go wrong
    try { await appendLog(`start: NO PET. exeDir=${launch ? launch.exeDir : '?'} translocated=${launch ? launch.translocated : '?'} roots=${launch ? launch.roots.join(' | ') : '?'}`); } catch (_) {}
    toast(T.noPet, 8000);
    // a transparent toast on an invisible window is not an error message: say it in a real dialog, with the way out
    setTimeout(() => {
      const extra = launch && launch.translocated ? '\n\n' + T.noPetMoved : '';
      try { window.__TAURI__.dialog.message(T.noPetHelp + extra, { title: 'Kapi', kind: 'warning' }); } catch (_) {}
    }, 700);
  }
  else {
    // A first-delivery bundle names its pet (bundle.json next to the exe). The first start from that bundle makes
    // that pet the active one — once per bundleId — so a user who had an older pet does not keep seeing it; after
    // that the user's own choice (switch / import) stands.
    let bundlePick = null;
    try {
      const b = await invoke('bundle_info');
      if (b && b.bundleId && b.defaultPetId && !(settings.seenBundles || []).includes(b.bundleId)) {
        bundlePick = pets.find(p => p.id === b.defaultPetId) || null;
        settings.seenBundles = [...(settings.seenBundles || []), b.bundleId].slice(-20);
        if (bundlePick) settings.activePetId = bundlePick.id;
        await saveSettings();
        // 0.9.2: the folder's own copy may be OLDER than one already installed (list_pets keeps the highest version per
        // id) — say so, instead of letting the user think the "new" folder did nothing
        if (bundlePick && b.version && Number(b.version) < Number(bundlePick.version)) toast(T.src.olderBundle(b.version, bundlePick.version), 9000);
      }
    } catch (_) {}
    const chosen = bundlePick || pets.find(p => p.id === settings.activePetId) || pets[0];
    try { await loadPet(chosen); } catch (e) { toast(String(e), 6000); }
    try { await appendLog(`start ${chosen.id} v${chosen.version} from ${chosen.dir}${launch && launch.translocated ? ' [TRANSLOCATED]' : ''}; candidates: ${pets.map(p => `${p.id}@v${p.version}:${p.dir}`).join(' | ')}`); } catch (_) {}
    if (!engine) { try { await win.setIgnoreCursorEvents(true); } catch (_) {} }   // a window with no pet must never block clicks
  }
  render();
})();
