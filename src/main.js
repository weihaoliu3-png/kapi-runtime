// Kapi runtime glue: Tauri window, hit-testing, drag, look-follow polling, bubbles, tray, settings.
(async function () {
  'use strict';
  const TAURI = window.__TAURI__;
  const { invoke, convertFileSrc } = TAURI.core;
  const { getCurrentWindow, cursorPosition, LogicalPosition, LogicalSize, currentMonitor } = TAURI.window;
  const { listen } = TAURI.event;
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
  let milestones = null, garden = null, props = { cup: null, flowers: {} }, videoFx = {}, interState = null, fxAbort = null, fxRun = 0, fxQueue = null;
  // Built-in real-video effects shipped with the runtime (src/fx/<id>/000..N.webp): every pet has them; a package may
  // override one with its own effects.<id>. Loaded on first use, kept for the session.
  const BUILTIN_FX = { bubbleTea: { type: 'videoFrames', frames: 41, fps: 18, ext: 'webp' } };
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
  const isMain = win.label === 'pet';
  const wantedPetId = new URLSearchParams(location.search).get('pet');
  const otherPets = {};   // label -> {id, name, rect, t}

  async function refreshRects() {
    try {
      const sf = await win.scaleFactor();
      const p = (await win.outerPosition()).toLogical(sf), sz = (await win.outerSize()).toLogical(sf);
      winRect = { x: p.x, y: p.y, w: sz.width, h: sz.height };
      const mon = await currentMonitor();
      if (mon) { const mp = mon.position.toLogical(sf), ms = mon.size.toLogical(sf); monRect = { x: mp.x, y: mp.y, w: ms.width, h: ms.height }; }
    } catch (_) {}
  }
  const stroke = { xs: [], lastT: 0 };

  const BASE_PAD_TOP = 130, PAD_SIDE = 90;      // 90: room for the +-16 deg swing while dragged (0.8.13)
  let PAD_TOP = BASE_PAD_TOP;
  let careWanted = false, careLayoutTask = Promise.resolve();
  let settings = { scale: 1, activePetId: '', muted: false, alwaysOnTop: true };
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
      manifest.lookFollow = { ...manifest.lookFollow, mode: 'frames8', holdMs: 150, crossfadeMs: 260 };
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
    engine = new PetEngine({ manifest, persona, images }, {
      onSay: (text, sticky) => say(text, sticky),
      onAction: () => {},
      onStroke: () => { if (milestones) milestones.record('stroke'); },
    });
    await setupCare();
    setupInteractions();
    await applyScale();
    await refreshRects();
    beh = new Behaviors({
      getWin: () => winRect, getMonitor: () => monRect, getCursor: () => cursorLogical, engine,
      setWin: () => {}, say: (x, st) => say(x, st), expr: (n, ms) => engine.showExpression(n, ms),
      play: (id) => { if (pet.manifest.actions[id]) engine.play(id); }, line: (k) => care.host.line(k), t,
    });
    if (isMain) { settings.activePetId = info.id; await saveSettings(); }
    greet();
    setupReminders();
    setupTeachHints();
    if (!settings.hintShown) { setTimeout(() => say(T.hint, true), 2500); settings.hintShown = true; await saveSettings(); }
    await pendingFirstHint();
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
    garden = new Garden(pet.manifest.garden, { now, state: st, save, say: (k) => say(lineOr(k)), onPick: () => milestones.record('flower') });
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
      if (isVideo) { engine.play(pet.manifest.actions[m && m.action] ? m.action : (pet.manifest.actions.throw ? 'throw' : (pet.manifest.actions.wave ? 'wave' : 'nod'))); engine.flip = dir < 0; }
      else engine.showExpression('happy', 3000);
      let frames = null;
      if (isVideo) { try { frames = await framesP; } catch (_) { frames = null; } }
      if (frames && frames.length && !frames.some(f => !f)) {
        const extraTop = (PAD_TOP - BASE_PAD_TOP) * (window.devicePixelRatio || 1);
        await KapiFx.playVideoFrames(fxCtx, fxCanvas.width, fxCanvas.height, frames, spec.fps,
          { signal: controller.signal, viewport: { x: 0, y: extraTop, width: fxCanvas.width, height: fxCanvas.height - extraTop } });
      } else {
        await KapiFx.play(fxCtx, fxCanvas.width, fxCanvas.height, window.devicePixelRatio || 1, effect,
          { from, dir, cup: props.cup, color: (pet.manifest.garden || {}).color, local: true, signal: controller.signal });
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
      react: (kind, key, chance, fb) => react(kind, key, chance, fb),
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
  function openCare() { if (!care) return; care.renderPanel(careEl); careEl.style.visibility = 'hidden'; careEl.style.display = 'block'; return queueCareLayout(true); }
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
      const mon = await currentMonitor();
      const monitorTop = mon ? mon.position.toLogical(sf).y : -Infinity;
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
      drawDizzyOverlay();
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
      react('hit', 'whipReact', REACT_CHANCE.hit, (T.inter && T.inter.whipReact) || '!');
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
  async function saveDebugLog() {
    try {
      let local = null, alpha = null;
      try { if (cursorLogical && winRect) { local = { x: cursorLogical.x - winRect.x, y: cursorLogical.y - winRect.y }; alpha = petAlphaAt(local.x, local.y); } } catch (_) {}
      const line = JSON.stringify({ at: new Date().toISOString(), label: win.label, pet: pet && pet.id, engine: !!engine, hidden, dragging, cursor: cursorLogical, local, alpha, win: winRect,
                                    ignoreCursorEvents: lastHitVisible === null ? null : !lastHitVisible, diag: pollDiag, otherPets: Object.keys(otherPets) });
      const path = settingsFile.replace(/settings\.json$/, 'kapi-debug.log');
      let prev = ''; try { prev = await invoke('read_text', { path }); } catch (_) {}
      const lines = (prev ? prev.split('\n') : []).filter(Boolean).slice(-80); lines.push(line);
      await invoke('write_text', { path, content: lines.join('\n') + '\n' });
      return path;
    } catch (_) { return ''; }
  }
  async function poll() {
    if (!engine || hidden) return;
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
        if (Math.hypot(cp.x - dragStartCursor.x, cp.y - dragStartCursor.y) > 4) dragMoved = true;
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
    try { engine.setLookVector(lx - headX, ly - headY); } catch (e) { pollFail('look', e); }
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
      // Petting works anywhere on visible pet pixels, not only on the head.
      if (overPet && !ctrlHeld) {                       // stroke = 3+ horizontal direction reversals within 1.5s
        if (t - stroke.lastT > 1.5) stroke.xs = []; stroke.lastT = t; stroke.xs.push(lx);
        if (stroke.xs.length > 30) stroke.xs.shift();
        let rev = 0; for (let i = 2; i < stroke.xs.length; i++) { const a = stroke.xs[i - 1] - stroke.xs[i - 2], b = stroke.xs[i] - stroke.xs[i - 1]; if (a * b < 0 && Math.abs(a) > 2 && Math.abs(b) > 2) rev++; }
        if (rev >= 3) { stroke.xs = []; if (engine.stroke()) care.do('pet', { silent: true }); }
      } else stroke.xs = [];
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
    if (!beh || !winRect || dragging) { lastStep = performance.now(); return; }
    const now = performance.now(); const dt = Math.min(0.1, (now - lastStep) / 1000); lastStep = now;
    const r = beh.step(dt); if (!r) { engine.extraRot = 0; return; }
    engine.flip = !!r.flip; engine.extraRot = r.rot || 0;
    winRect.x = r.x; winRect.y = r.y;
    try { await win.setPosition(new LogicalPosition(Math.round(r.x), Math.round(r.y))); } catch (_) {}
    if (r.arrived === 'walk' || r.landed) engine.flip = false;
  }, 33);
  setInterval(refreshRects, 2000);

  // ---------- mouse ----------
  canvas.addEventListener('mousedown', async (e) => {
    if (!engine || e.button !== 0) return;
    if (petAlphaAt(e.clientX, e.clientY) <= 25) return;
    const sf = await win.scaleFactor();
    dragStartCursor = (await cursorPosition()).toLogical(sf); dragStartWin = (await win.outerPosition()).toLogical(sf);
    dragging = true; dragMoved = false; mouseDownAt = performance.now(); prevCursorForV = null;
    grabPoint = { x: (e.clientX - PAD_SIDE) / Math.max(1e-6, scale), y: (e.clientY - PAD_TOP) / Math.max(1e-6, scale) };
  });
  window.addEventListener('mouseup', async (e) => {
    if (!dragging) return;
    dragging = false;
    if (dragMoved) {
      engine.dragEnd(); await refreshRects();
      const fresh = performance.now() / 1000 - dragV.t < 0.15;
      if (beh && fresh && beh.throwWith(dragV.x, dragV.y)) { /* physics takes over */ }
      else if (beh && beh.checkEdgeAfterDrag()) { /* cling then climb back */ }
      else await keepOnScreen();
    }
    else if (performance.now() - mouseDownAt < 400) { if (beh && beh.mode === 'peek') beh.unpeek(); else if (care && care.s.sleeping) care.wake(false); else { engine.click((e.clientY - PAD_TOP) / Math.max(1, dispH)); if (milestones) milestones.record('click'); } }
  });
  // no double-click action (0.8.12): quick repeated clicks used to pop the care panel by accident; the panel opens only
  // from the 🐾 button and the right-click menu
  canvas.addEventListener('contextmenu', async (e) => { e.preventDefault(); if (petAlphaAt(e.clientX, e.clientY) > 25) await showMenu(); });

  async function keepOnScreen() {
    try {
      const sf = await win.scaleFactor(); const mon = await currentMonitor(); if (!mon) return;
      const wp = (await win.outerPosition()).toLogical(sf), ws = (await win.outerSize()).toLogical(sf);
      const mp = mon.position.toLogical ? mon.position.toLogical(sf) : mon.position, ms = mon.size.toLogical ? mon.size.toLogical(sf) : mon.size;
      const x = Math.min(Math.max(wp.x, mp.x - ws.width + 40), mp.x + ms.width - 40), y = Math.min(Math.max(wp.y, mp.y - PAD_TOP), mp.y + ms.height - 40);
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
    lastSpeakAt = now;
    const seq = ++speakSeq;
    stopVoice();                                     // never two voices at once
    const kind = KapiVoice.voiceKind(pet.manifest, voiceIndex);
    if (kind === 'none') return;
    const v = pet.manifest.voice || {};
    if (kind === 'babble') {
      const plan = opts.hit ? KapiVoice.planHit({ preset: v.preset || 'bright', hz: v.baseHz ? v.baseHz * 1.45 : undefined, seed: seq })
                            : KapiVoice.planBabble(text, { preset: v.preset || 'bright', hz: v.baseHz, rate: v.rate });
      currentBabble = KapiVoice.renderBabble(plan, opts.hit ? 0.55 : 0.45); return;
    }
    const rel = voiceIndex[text];
    if (!rel) {                                      // tts pet, no clip for this line: bubble only — except a hit, which gets the babble ouch
      if (opts.hit) currentBabble = KapiVoice.renderBabble(KapiVoice.planHit({ preset: v.preset || 'female', seed: seq }), 0.55);
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
  function reaction(kind, force) {
    if (settings.muted || !pet) return;
    const now = performance.now();
    if (!force && now - lastReactAt < 160) return;
    lastReactAt = now;
    if (currentAudio && !currentAudio.paused && !currentAudio.ended) return;    // a spoken line is playing: don't talk over it
    const k = KapiVoice.voiceKind(pet.manifest, voiceIndex); if (k === 'none') return;
    const v = pet.manifest.voice || {};
    if (currentBabble) { try { currentBabble.stop(); } catch (_) {} }
    currentBabble = KapiVoice.renderBabble(KapiVoice.planReaction(kind, { preset: v.preset || (k === 'babble' ? 'bright' : 'female'), hz: v.baseHz, seed: ++reactSeq }), kind === 'hit' ? 0.55 : 0.42);
  }
  function react(event, lineKey, chance, fallbackText) {
    const kind = REACT_KIND[event] || event;
    const p = chance == null ? (REACT_CHANCE[event] == null ? 0.35 : REACT_CHANCE[event]) : chance;
    const line = lineKey ? (care && care.host.line(lineKey)) || fallbackText || null : null;
    if (line && Math.random() < p) { say(line, false, { force: kind === 'hit', hit: kind === 'hit' }); return; }
    reaction(kind, kind === 'hit');
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
    const actionItems = await Promise.all(frameActions.map(id => MenuItem.new({ text: id, action: () => engine.play(id) })));
    const scaleItems = await Promise.all([0.5, 0.75, 1, 1.5, 2].map(s => CheckMenuItem.new({ text: Math.round(s * 100) + '%', checked: Math.abs(settings.scale - s) < 0.01, action: async () => { settings.scale = s; await saveSettings(); await applyScale(); } })));
    const items = [
      await MenuItem.new({ text: T.menu.care(pet.name), action: openCare }),
      await Submenu.new({ text: T.menu.actions, items: actionItems.length ? actionItems : [await MenuItem.new({ text: T.teach.empty, action: teachExport })] }),
      await Submenu.new({ text: T.menu.size, items: scaleItems }),
      await CheckMenuItem.new({ text: T.menu.mute, checked: settings.muted, action: async () => { settings.muted = !settings.muted; await saveSettings(); } }),
      await CheckMenuItem.new({ text: T.menu.onTop, checked: settings.alwaysOnTop, action: async () => { settings.alwaysOnTop = !settings.alwaysOnTop; await win.setAlwaysOnTop(settings.alwaysOnTop); await saveSettings(); } }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await CheckMenuItem.new({ text: beh && beh.follow ? T.menu2.unfollow : T.menu2.follow, checked: !!(beh && beh.follow), action: () => beh && beh.setFollow(!beh.follow) }),
      await MenuItem.new({ text: T.menu2.come, action: () => beh && beh.comeHere() }),
      await MenuItem.new({ text: T.menu2.hide, action: () => beh && beh.peek() }),
      await CheckMenuItem.new({ text: T.menu2.perch, checked: !!(beh && beh.mode === 'perch'), action: () => beh && beh.setPerch(beh.mode !== 'perch') }),
      ...(await summonItems()),
      ...(await wardrobeItems()),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await MenuItem.new({ text: T.menu.import, action: importPet }),
      await MenuItem.new({ text: T.menu.switch, action: switchPet }),
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
  async function summonItems() {
    const { MenuItem, Submenu } = window.__TAURI__.menu;
    pets = await invoke('list_pets');
    const others = pets.filter(p => p.id !== pet.id && !Object.values(otherPets).some(o => o.id === p.id));
    const items = await Promise.all(others.map(p => MenuItem.new({ text: p.name, action: () => { const r = winRect, m = monRect; let x = null, y = null;
          if (r) { x = r.x + r.w + 24; y = r.y; if (m && x + r.w > m.x + m.w) x = Math.max(m.x, r.x - r.w - 24); }   // beside the caller, never on top of it
          invoke('open_pet_window', { id: p.id, x, y }).catch(e => toast(String(e))); } })));
    const out = [];
    if (items.length) out.push(await Submenu.new({ text: T.menu2.summon, items }));
    if (!isMain) out.push(await MenuItem.new({ text: T.menu2.release, action: () => win.close() }));
    return out;
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
    const out = await window.__TAURI__.dialog.save({ defaultPath: `${pet.id}-v${pet.manifest.version}.petpack` }); if (!out) return;
    try { await invoke('export_pet', { dir: pet.dir, outPath: out }); toast(T.exported); } catch (e) { toast(T.exportFail + e, 5000); }
  }
  async function toggleHidden() { hidden = !hidden; if (hidden) { if (fxQueue) fxQueue.clear(); if (fxAbort) fxAbort.abort(); await win.hide(); } else { await win.show(); } }
  // (the old "设置" window is gone in 0.8.12: its only control, display size, lives in the right-click 大小 submenu)
  listen('tray', async (e) => {
    const id = e.payload;
    if (id === 'toggle') toggleHidden(); else if (id === 'import') importPet(); else if (id === 'switch') switchPet(); else if (id === 'export') exportPet();
    else if (id === 'diagnose') { const path = await saveDebugLog(); toast(`${win.label} ${pet ? pet.id : ''} · poll ok ${pollDiag.ok} · 失败 ${JSON.stringify(pollDiag.fails)} · ${pollDiag.lastErr || '无错误'} · 穿透=${lastHitVisible === null ? '?' : !lastHitVisible} · 日志 ${path}`, 9000); }
    else if (id === 'recover') { lastHitVisible = true; lastIgnoreAt = 0; try { await win.setIgnoreCursorEvents(false); } catch (_) {} hidden = false; try { await win.show(); } catch (_) {} }
  });
  listen('modifier-state', (e) => { ctrlHeld = !!(e.payload && e.payload.ctrl); if (!ctrlHeld) { whipPrev = null; whipMarks = []; whipTrail = []; whipFlash = null; drawWhip(); } });
  listen('user-input', (e) => { if (!engine) return; const p = e.payload || {}; engine.lastInput = performance.now() / 1000; if (beh) beh.onTyping(p.keys || 0); if (p.keys && garden) garden.onTypingSecond(p.keys); });
  listen('pet-rect', (e) => { const p = e.payload; if (!p || p.label === win.label || !beh) return; if (!otherPets[p.label]) lastIgnoreAt = 0; otherPets[p.label] = p; beh.onOtherPet(p.id, p.rect, p.name); });
  rectTimer = setInterval(() => { if (pet && winRect) window.__TAURI__.event.emit('pet-rect', { label: win.label, id: pet.id, name: pet.name, rect: winRect }); }, 800);
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
  win.onDragDropEvent(async (e) => { if (e.payload.type === 'drop' && e.payload.paths?.length) await importPet(e.payload.paths[0]); });

  // ---------- boot ----------
  try { await win.setIgnoreCursorEvents(false); } catch (_) {}      // known starting state for every pet window (main and summoned)
  await loadSettings();
  await win.setAlwaysOnTop(!!settings.alwaysOnTop);
  pets = await invoke('list_pets');
  if (!pets.length) { toast(T.noPet, 8000); }
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
      }
    } catch (_) {}
    const chosen = (wantedPetId && pets.find(p => p.id === wantedPetId)) || bundlePick || pets.find(p => p.id === settings.activePetId) || pets[0];
    try { await loadPet(chosen); } catch (e) { toast(String(e), 6000); }
    if (!engine) { try { await win.setIgnoreCursorEvents(true); } catch (_) {} }   // a window with no pet must never block clicks for the others
    if (!isMain) {
      await refreshRects();
      const q = new URLSearchParams(location.search); const qx = parseFloat(q.get('x')), qy = parseFloat(q.get('y'));
      if (Number.isFinite(qx) && Number.isFinite(qy)) await win.setPosition(new LogicalPosition(qx, qy));
      else if (monRect && winRect) await win.setPosition(new LogicalPosition(monRect.x + monRect.w * 0.3 + Math.random() * 200, winRect.y));
      await refreshRects();
    }
  }
  render();
})();
