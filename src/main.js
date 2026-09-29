// Kapi runtime glue: Tauri window, hit-testing, drag, look-follow polling, bubbles, chat, tray, settings.
(async function () {
  'use strict';
  const TAURI = window.__TAURI__;
  const { invoke, convertFileSrc } = TAURI.core;
  const { getCurrentWindow, cursorPosition, LogicalPosition, LogicalSize, currentMonitor } = TAURI.window;
  const { listen } = TAURI.event;
  const win = getCurrentWindow();

  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const bubble = document.getElementById('bubble');
  const chat = document.getElementById('chat');
  const chatInput = document.getElementById('chatInput');
  const toastEl = document.getElementById('toast');
  const pawEl = document.getElementById('paw');
  const careEl = document.getElementById('care');
  let care = null, careTimer = null, stageScale = 1;
  let T = I18N.pick();                       // UI strings; re-picked per pet from persona.language
  const t = () => T;
  let currentOutfit = 'default';
  let beh = null, winRect = null, monRect = null, cursorLogical = null, perchTimer = null, batteryTimer = null, rectTimer = null;
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

  const PAD_TOP = 130, PAD_SIDE = 60;
  let settings = { instanceId: '', url: '', scale: 1, activePetId: '', muted: false, alwaysOnTop: true };
  let settingsFile = '';
  let pets = [], pet = null, engine = null, scale = 1, dispW = 0, dispH = 0, hidden = false;
  let lastCursor = null, lastCursorMove = 0, dragging = false, dragStartCursor = null, dragStartWin = null, dragMoved = false, mouseDownAt = 0;
  let prevCursorForV = null, prevT = 0, lastHitVisible = true, bubbleTimer = null, bubbleSticky = false, dragV = { x: 0, y: 0, t: 0 };
  let chatHistory = [], reminderState = {};

  // ---------- helpers ----------
  const toast = (msg, ms = 2500) => { toastEl.textContent = msg; toastEl.style.display = 'block'; clearTimeout(toastEl._t); toastEl._t = setTimeout(() => toastEl.style.display = 'none', ms); };
  const loadImage = (path) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = convertFileSrc(path); });
  const join = (...p) => p.join(pet && pet.dir.includes('\\') ? '\\' : '/');

  async function loadSettings() {
    settingsFile = await invoke('settings_path');
    try { Object.assign(settings, JSON.parse(await invoke('read_text', { path: settingsFile }))); } catch (_) {}
  }
  async function saveSettings() { try { delete settings.token; delete settings.apiBase; await invoke('write_text', { path: settingsFile, content: JSON.stringify(settings, null, 2) }); } catch (_) {} }

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
    const images = { base: await loadImage(join(info.dir, L.base)), blink: null, look: {}, actions: {} };
    if (L.blink) images.blink = await loadImage(join(info.dir, L.blink));
    images.expressions = {};
    for (const [name, rel] of Object.entries(L.expressions || {})) images.expressions[name] = await loadImage(join(info.dir, rel));
    if (manifest.lookFollow && manifest.lookFollow.mode === 'frames8') {
      for (const d of ['d000', 'd045', 'd090', 'd135', 'd180', 'd225', 'd270', 'd315']) images.look[d] = await loadImage(join(info.dir, L.look || 'look', d + '.png'));
    }
    for (const [id, a] of Object.entries(manifest.actions)) {
      if (a.type !== 'frames') continue;
      images.actions[id] = [];
      for (let i = 0; i < a.frames; i++) images.actions[id].push(await loadImage(join(info.dir, a.dir, String(i).padStart(3, '0') + '.png')));
    }
    pet = { ...info, manifest, persona };
    T = I18N.pick(persona.language); chatInput.placeholder = T.chatPlaceholder;
    engine = new PetEngine({ manifest, persona, images }, {
      onSay: (text, sticky) => say(text, sticky),
      onAction: () => {},
    });
    await setupCare();
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
    if (!settings.hintShown) { setTimeout(() => say(T.hint, true), 2500); settings.hintShown = true; await saveSettings(); }
  }

  // ---------- care system ----------
  async function setupCare() {
    const stateFile = join(pet.dir, 'state.json');
    let st = null; try { st = JSON.parse(await invoke('read_text', { path: stateFile })); } catch (_) {}
    care = new CareSystem(st, {
      say: (t, sticky) => say(t, sticky), expr: (n, ms) => engine.showExpression(n, ms), play: (id) => { if (pet.manifest.actions[id]) engine.play(id); else engine.play('nod'); },
      setSleeping: (on) => engine.setSleeping(on), setStageScale: async (k) => { stageScale = k; await applyScale(); }, toast: (m) => toast(m, 4000),
      save: (state) => invoke('write_text', { path: stateFile, content: JSON.stringify(state) }).catch(() => {}), t,
      line: (key) => { const L = (pet.persona.lines || {})[key]; return L && L.length ? L[Math.floor(Math.random() * L.length)] : null; },
    });
    stageScale = care.stageScale();
    if (care.s.sleeping) engine.setSleeping(true);
    clearInterval(careTimer);
    careTimer = setInterval(() => {
      const w = care.tick(); if (careEl.style.display === 'block') care.renderPanel(careEl);
      if (w.length && Math.random() < 0.35 && engine.state.action === 'idle' && !care.s.sleeping) {
        const key = w[Math.floor(Math.random() * w.length)];
        say(care.host.line(key) || T.care.fallback[key]);
        if (key === 'tired') engine.showExpression('sleepy', 2500); else if (key === 'lonely') engine.showExpression('sad', 2500); else engine.showExpression('sad', 1500);
      }
    }, 60000);
  }
  function openCare() { care.renderPanel(careEl); careEl.style.display = 'block'; }
  function closeCare() { careEl.style.display = 'none'; }
  careEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-care]'); if (b) { care.do(b.dataset.care); care.renderPanel(careEl); return; }
    if (e.target.dataset.close) closeCare();
  });
  pawEl.addEventListener('click', () => careEl.style.display === 'block' ? closeCare() : openCare());

  async function applyScale() {
    const m = pet.manifest; const [cw, ch] = m.render.canvas;
    scale = (m.render.displayHeight * (settings.scale || 1) * (stageScale || 1)) / ch;
    dispW = Math.round(cw * scale); dispH = Math.round(ch * scale);
    const W = dispW + PAD_SIDE * 2, H = dispH + PAD_TOP;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    await win.setSize(new LogicalSize(W, H));
  }

  // ---------- render loop ----------
  function render() {
    if (engine) {
      engine.update();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      engine.draw(ctx, scale, PAD_SIDE, PAD_TOP);
      positionBubble();
    }
    requestAnimationFrame(render);
  }

  function petAlphaAt(x, y) { // x,y in CSS px inside window
    const dpr = window.devicePixelRatio || 1;
    try { return ctx.getImageData(Math.floor(x * dpr), Math.floor(y * dpr), 1, 1).data[3]; } catch (_) { return 0; }
  }

  // ---------- 30Hz poll: cursor -> hit test (pass-through) + look-follow + drag ----------
  async function poll() {
    if (!engine || hidden) return;
    try {
      const sf = await win.scaleFactor();
      const cp = (await cursorPosition()).toLogical(sf);
      const wp = (await win.outerPosition()).toLogical(sf);
      const lx = cp.x - wp.x, ly = cp.y - wp.y;
      const t = performance.now() / 1000;
      cursorLogical = cp; if (winRect) { winRect.x = wp.x; winRect.y = wp.y; }
      if (!lastCursor || lastCursor.x !== cp.x || lastCursor.y !== cp.y) { lastCursorMove = t; engine.userInput && (engine.lastInput = t); }
      lastCursor = cp;

      if (dragging) {
        const nx = dragStartWin.x + (cp.x - dragStartCursor.x), ny = dragStartWin.y + (cp.y - dragStartCursor.y);
        if (Math.hypot(cp.x - dragStartCursor.x, cp.y - dragStartCursor.y) > 4) dragMoved = true;
        if (dragMoved) {
          await win.setPosition(new LogicalPosition(nx, ny));
          if (prevCursorForV) { const dtv = Math.max(0.016, t - prevT); dragV = { x: (cp.x - prevCursorForV.x) / dtv, y: (cp.y - prevCursorForV.y) / dtv, t }; engine.dragMove(dragV.x); }
        }
        prevCursorForV = cp; prevT = t;
        return;
      }
      // hit test against drawn pixels (pet body + bubble + chat)
      const inWin = lx >= 0 && ly >= 0 && lx < canvas.clientWidth && ly < canvas.clientHeight;
  const overUi = inWin && (isOver(bubble, lx, ly) || isOver(chat, lx, ly));
      const overPet = inWin && petAlphaAt(lx, ly) > 25;
      engine.hover = overPet;
      pawEl.style.display = (overPet || overUi || careEl.style.display === 'block') ? 'flex' : 'none';
      const overHead = overPet && ly < PAD_TOP + dispH * 0.45;
      if (overHead) {                                  // stroke = 3+ horizontal direction reversals within 1.5s
        if (t - stroke.lastT > 1.5) stroke.xs = []; stroke.lastT = t; stroke.xs.push(lx);
        if (stroke.xs.length > 30) stroke.xs.shift();
        let rev = 0; for (let i = 2; i < stroke.xs.length; i++) { const a = stroke.xs[i - 1] - stroke.xs[i - 2], b = stroke.xs[i] - stroke.xs[i - 1]; if (a * b < 0 && Math.abs(a) > 2 && Math.abs(b) > 2) rev++; }
        if (rev >= 3) { stroke.xs = []; if (engine.stroke()) care.do('pet'); }
      } else stroke.xs = [];
      const visible = overPet || overUi || (careEl.style.display === 'block' && isOver(careEl, lx, ly)) || isOver(pawEl, lx, ly);
      if (visible !== lastHitVisible) { lastHitVisible = visible; await win.setIgnoreCursorEvents(!visible); }
      // look-follow: vector from head point (top 25% of pet) to cursor
      const headX = PAD_SIDE + dispW / 2, headY = PAD_TOP + dispH * 0.25;
      engine.setLookVector(lx - headX, ly - headY);
    } catch (e) { /* window may be closing */ }
  }
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
    setTimeout(() => { if (dragging && dragMoved) engine.dragStart(); }, 120);
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
    else if (performance.now() - mouseDownAt < 400) { if (beh && beh.mode === 'peek') beh.unpeek(); else if (care && care.s.sleeping) care.wake(false); else engine.click((e.clientY - PAD_TOP) / Math.max(1, dispH)); }
  });
  canvas.addEventListener('dblclick', (e) => { if (petAlphaAt(e.clientX, e.clientY) > 25) openChat(); });
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
  function say(text, sticky) {
    if (!text) return; clearTimeout(bubbleTimer);
    bubble.textContent = text; bubble.style.display = 'block'; bubbleSticky = !!sticky; bubble.classList.toggle('sticky', bubbleSticky);
    if (!sticky) bubbleTimer = setTimeout(hideBubble, Math.min(8000, 1500 + text.length * 120));
    speak(text);
  }
  function hideBubble() { bubble.style.display = 'none'; bubbleSticky = false; }
  bubble.addEventListener('click', () => { if (bubbleSticky) hideBubble(); });
  function positionBubble() {
    const cx = PAD_SIDE + dispW / 2;
    bubble.style.left = cx + 'px'; bubble.style.top = Math.max(4, PAD_TOP - bubble.offsetHeight - 14) + 'px';
    chat.style.top = Math.max(4, PAD_TOP - 48) + 'px';
  }
  function speak(text) {
    if (settings.muted || !('speechSynthesis' in window)) return;
    try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = (pet.persona.language || 'zh-CN'); u.rate = 1.05; speechSynthesis.speak(u); } catch (_) {}
  }
  function greet() {
    const h = new Date().getHours(); const k = h < 12 ? 'greetingMorning' : h >= 21 ? 'greetingEvening' : null;
    if (k && (pet.persona.lines || {})[k]) setTimeout(() => engine.sayFrom(k), 1200);
  }

  // ---------- chat ----------
  function openChat() { chat.style.display = 'block'; chatInput.value = ''; chatInput.focus(); win.setFocus(); }
  function closeChat() { chat.style.display = 'none'; }
  chatInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') return closeChat();
    if (e.key !== 'Enter' || !chatInput.value.trim()) return;
    const msg = chatInput.value.trim(); chatInput.value = ''; closeChat();
    await sendChat(msg);
  });
  // ---------- chat via Capafy relay (see docs/连接方案) ----------
  const chatQ = []; let chatInflight = null;
  async function sendChat(message) {
    if (!settings.instanceId) { say(T.chatErr.notConnected, true); return; }
    if (chatInflight) { chatQ.push(message); return; }
    const token = await invoke('secret_get', { key: 'capafy_token' }).catch(() => null);
    if (!token) { say(T.chatErr.authExpired, true); return; }
    const requestId = Math.random().toString(36).slice(2, 10);
    const content = Connect.buildContent(message, { localTime: new Date().toTimeString().slice(0, 5), lastAction: engine.state.action,
      actions: Object.keys(pet.manifest.actions).filter(a => pet.manifest.actions[a].type === 'frames'), expressions: Object.keys((pet.manifest.layers.expressions) || {}) });
    chatInflight = { requestId, text: '', seqs: new Map(), timer: null };
    engine.chatWait(); say('…');
    chatInflight.timer = setTimeout(() => finishChat(requestId, 'timeout'), 90000);
    invoke('relay_send', { instanceId: settings.instanceId, token, content, requestId }).catch(() => finishChat(requestId, 'error', 0));
  }
  function renderPartial() {
    const c = chatInflight; if (!c) return;
    const ordered = [...c.seqs.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]).join('');
    const partial = Connect.parseTags(ordered || c.text, [], []).text;
    if (partial) { bubble.textContent = partial; bubble.style.display = 'block'; }
  }
  function finishChat(requestId, kind, status, errBody) {
    const c = chatInflight; if (!c || c.requestId !== requestId) return;
    clearTimeout(c.timer); chatInflight = null;
    if (kind === 'error') { say(T.chatErr[Connect.errorKey(status, errBody)] || T.chatErr.offline, true); engine.stopChat(); }
    else if (kind === 'timeout') { say(T.chatErr.timeout); engine.stopChat(); }
    else {
      const ordered = [...c.seqs.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]).join('') || c.text;
      const known = Object.keys(pet.manifest.actions), exprs = Object.keys(pet.manifest.layers.expressions || {});
      const r = Connect.parseTags(ordered, known, exprs);
      chatHistory.push({ role: 'user', content: '' }, { role: 'assistant', content: r.text });
      engine.chatReply(); say(r.text || '……');
      if (r.expr) engine.showExpression(r.expr, Math.min(8000, 1500 + r.text.length * 120));
      if (r.action) engine.play(r.action, PET_PRIORITY.chat);
      setTimeout(() => engine.stopChat(), Math.min(8000, 1500 + r.text.length * 120));
    }
    if (chatQ.length) setTimeout(() => sendChat(chatQ.shift()), 800);
  }
  listen('petchat', (e) => {
    const p = e.payload; if (!chatInflight || p.request_id !== chatInflight.requestId) return;
    if (p.kind === 'message') { if (p.seq >= 0) chatInflight.seqs.set(p.seq, p.content); else chatInflight.text += p.content; renderPartial(); }
    else if (p.kind === 'done') finishChat(p.request_id, 'done');
    else if (p.kind === 'timeout') finishChat(p.request_id, 'timeout');
    else if (p.kind === 'error') finishChat(p.request_id, 'error', p.status, p.content);
  });

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
      await MenuItem.new({ text: T.menu.talk(pet.name), action: openChat }),
      ...(actionItems.length ? [await Submenu.new({ text: T.menu.actions, items: actionItems })] : []),
      await Submenu.new({ text: T.menu.size, items: scaleItems }),
      await CheckMenuItem.new({ text: T.menu.mute, checked: settings.muted, action: async () => { settings.muted = !settings.muted; await saveSettings(); } }),
      await CheckMenuItem.new({ text: T.menu.onTop, checked: settings.alwaysOnTop, action: async () => { settings.alwaysOnTop = !settings.alwaysOnTop; await win.setAlwaysOnTop(settings.alwaysOnTop); await saveSettings(); } }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
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
      await MenuItem.new({ text: T.menu.settings, action: openSettings }),
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
    const items = await Promise.all(others.map(p => MenuItem.new({ text: p.name, action: () => invoke('open_pet_window', { id: p.id }).catch(e => toast(String(e))) })));
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
      toast(T.imported(info.name, info.version));
      pets = await invoke('list_pets'); await loadPet(info);
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
  async function toggleHidden() { hidden = !hidden; if (hidden) await win.hide(); else { await win.show(); } }
  async function openSettings() {
    const { WebviewWindow } = window.__TAURI__.webviewWindow;
    const existing = await WebviewWindow.getByLabel('settings'); if (existing) { await existing.setFocus(); return; }
    const w = new WebviewWindow('settings', { url: 'settings.html?lang=' + encodeURIComponent(pet.persona.language || ''), title: T.settings.title, width: 460, height: 620, resizable: true });
    w.once('tauri://error', (e) => toast('打不开设置：' + JSON.stringify(e.payload)));
  }
  listen('tray', async (e) => {
    const id = e.payload;
    if (id === 'toggle') toggleHidden(); else if (id === 'import') importPet(); else if (id === 'switch') switchPet(); else if (id === 'export') exportPet(); else if (id === 'settings') openSettings();
  });
  listen('user-input', (e) => { if (!engine) return; const p = e.payload || {}; engine.lastInput = performance.now() / 1000; if (p.keys && beh) beh.onTyping(p.keys); });
  listen('pet-rect', (e) => { const p = e.payload; if (!p || p.label === win.label || !beh) return; otherPets[p.label] = p; beh.onOtherPet(p.id, p.rect, p.name); });
  rectTimer = setInterval(() => { if (pet && winRect) window.__TAURI__.event.emit('pet-rect', { label: win.label, id: pet.id, name: pet.name, rect: winRect }); }, 800);
  batteryTimer = setInterval(async () => { if (!beh) return; try { beh.onBattery(await invoke('battery_status')); } catch (_) {} }, 60000);
  perchTimer = setInterval(async () => {
    if (!beh || beh.mode !== 'perch') return;
    try {
      const r = await invoke('active_window'); if (!r || /Kapi/i.test(r.title || '') || /kapi/i.test(r.app || '')) return;
      const sf = await win.scaleFactor(); const rect = { x: r.x / sf, y: r.y / sf, w: r.w / sf, h: r.h / sf };
      beh.perchOn(rect, PAD_TOP + dispH, winRect ? winRect.w : dispW + PAD_SIDE * 2);
    } catch (_) {}
  }, 1500);
  listen('settings-changed', async () => { await loadSettings(); await win.setAlwaysOnTop(!!settings.alwaysOnTop); if (pet) await applyScale(); });
  win.onDragDropEvent(async (e) => { if (e.payload.type === 'drop' && e.payload.paths?.length) await importPet(e.payload.paths[0]); });

  // ---------- boot ----------
  await loadSettings();
  await win.setAlwaysOnTop(!!settings.alwaysOnTop);
  pets = await invoke('list_pets');
  if (!pets.length) { toast(T.noPet, 8000); }
  else {
    const chosen = (wantedPetId && pets.find(p => p.id === wantedPetId)) || pets.find(p => p.id === settings.activePetId) || pets[0];
    try { await loadPet(chosen); } catch (e) { toast(String(e), 6000); }
    if (!isMain) { await refreshRects(); if (monRect && winRect) await win.setPosition(new LogicalPosition(monRect.x + monRect.w * 0.3 + Math.random() * 200, winRect.y)); }
  }
  render();
})();
