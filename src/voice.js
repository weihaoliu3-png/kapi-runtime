// Kapi voice (v0.7): one voice kind per pet, never mixed.
//   kind = 'tts'    : pre-rendered mp3 per fixed line (voice/index.json); lines without a clip are bubble-only (silent).
//   kind = 'babble' : "Animalese"-style synthetic syllables for EVERY line (fixed lines and chat replies alike),
//                     generated with WebAudio from the text's length and the persona's pitch — no files, no network.
//   kind = 'none'   : silent.
// Pure planning (planBabble) is separated from rendering (renderBabble) so it can be unit-tested without an AudioContext.
(function (global) {
  'use strict';

  // base pitch per preset (Hz) and syllable rate (syllables / second)
  const PRESETS = { soft: { hz: 330, rate: 9, jitter: 0.08, vowel: 0.55 }, bright: { hz: 440, rate: 12, jitter: 0.14, vowel: 0.45 }, low: { hz: 240, rate: 8, jitter: 0.06, vowel: 0.65 },
                    // human timbres (tts pets: voice.preset female|male) — used for the wordless reactions of 0.8.12
                    female: { hz: 300, rate: 10, jitter: 0.10, vowel: 0.5 }, male: { hz: 165, rate: 9, jitter: 0.08, vowel: 0.6 } };

  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { let s = seed || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

  /** Count "syllables" in text: CJK chars = 1 each, latin words ≈ 1 per 3 letters, punctuation = a pause. */
  function syllableUnits(text) {
    const units = [];
    const re = /[぀-ヿ㐀-鿿가-힯]|[A-Za-zÀ-ɏ']+|[0-9]+|[,，、.。!！?？;；:：…—-]+|\s+/g;
    let m;
    while ((m = re.exec(text))) {
      const t = m[0];
      if (/^\s+$/.test(t)) continue;
      if (/^[,，、.。!！?？;；:：…—-]+$/.test(t)) { units.push({ pause: /[.。!！?？…]/.test(t) ? 2 : 1 }); continue; }
      if (/^[0-9]+$/.test(t)) { for (let i = 0; i < t.length; i++) units.push({ syl: true }); continue; }
      if (t.length === 1 && /[぀-ヿ㐀-鿿가-힯]/.test(t)) { units.push({ syl: true }); continue; }
      const n = Math.max(1, Math.round(t.length / 3));
      for (let i = 0; i < n; i++) units.push({ syl: true });
    }
    return units;
  }

  /**
   * Plan a babble: returns { notes: [{t, dur, hz, vowel, gain}], total } in seconds.
   * Deterministic for the same text + preset (seeded by the text), so a line always sounds the same.
   * A question mark lifts the last syllables; an exclamation makes them louder/shorter; long lines are compressed to <= maxSec.
   */
  function planBabble(text, opts) {
    const alias = { female: 'bright', male: 'low' };
    const pr = (opts && opts.preset) || 'bright';
    const o = Object.assign({}, PRESETS[alias[pr] || pr] || PRESETS.bright, opts || {});
    const units = syllableUnits(String(text || ''));
    const r = rng(hash(String(text || '')) || 7);
    const question = /[?？]\s*$/.test(text), excl = /[!！]\s*$/.test(text);
    let maxSec = o.maxSec || 1.8;
    let rate = o.rate;
    const syls = units.filter(u => u.syl).length;
    if (syls / rate > maxSec) rate = syls / maxSec;                   // compress long lines instead of cutting them
    const dur = 1 / rate;
    const notes = []; let t = 0; let i = 0;
    for (const u of units) {
      if (u.pause) { t += dur * 0.8 * u.pause; continue; }
      const frac = syls > 1 ? i / (syls - 1) : 0;
      let semis = (r() - 0.5) * 2 * o.jitter * 12;                     // random wobble
      semis += Math.sin(i * 1.7) * 1.2;                                 // sing-song contour
      if (question && frac > 0.6) semis += (frac - 0.6) * 12;          // rise at the end of a question
      if (excl) semis += 1.5;
      const hz = o.hz * Math.pow(2, semis / 12);
      notes.push({ t, dur: dur * (excl ? 0.75 : 0.85), hz, vowel: Math.min(1, Math.max(0, o.vowel + (r() - 0.5) * 0.4)), gain: excl ? 0.9 : 0.75 });
      t += dur; i++;
    }
    return { notes, total: t, rate };
  }

  /** Render a plan with WebAudio. Returns a handle { stop() }. One context is reused. */
  let ctx = null;
  function renderBabble(plan, volume) {
    if (!global.AudioContext && !global.webkitAudioContext) return { stop() {} };
    ctx = ctx || new (global.AudioContext || global.webkitAudioContext)();
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (_) {} }
    const t0 = ctx.currentTime + 0.02;
    const master = ctx.createGain(); master.gain.value = volume == null ? 0.5 : volume; master.connect(ctx.destination);
    const nodes = [];
    for (const n of plan.notes) {
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0 + n.t);
      g.gain.exponentialRampToValueAtTime(n.gain, t0 + n.t + (n.attack || 0.012));
      if (n.hold) g.gain.setValueAtTime(n.gain, t0 + n.t + n.dur * n.hold);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.t + n.dur);
      let tail = g;
      if (n.am) {                                                                            // amplitude modulation (a purr)
        const am = ctx.createGain(); am.gain.value = 0.55; const lfo = ctx.createOscillator(); lfo.frequency.value = n.am; const lg = ctx.createGain(); lg.gain.value = 0.45;
        lfo.connect(lg); lg.connect(am.gain); lfo.start(t0 + n.t); lfo.stop(t0 + n.t + n.dur + 0.02); g.connect(am); am.connect(master); tail = g; nodes.push(lfo);
      } else g.connect(master);
      if (n.noise) {                                                                          // bandpassed noise burst (bark body, hiss, chomp)
        const len = n.dur + 0.05; const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * len), ctx.sampleRate); const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource(); src.buffer = buf;
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.setValueAtTime(n.noise, t0 + n.t); bp.Q.value = n.q || 1.2;
        if (n.noiseTo) bp.frequency.exponentialRampToValueAtTime(n.noiseTo, t0 + n.t + n.dur);
        src.connect(bp); bp.connect(tail); src.start(t0 + n.t); src.stop(t0 + n.t + n.dur + 0.02); nodes.push(src);
      }
      if (n.hz) {
        const osc = ctx.createOscillator(); osc.type = n.wave || 'sawtooth';
        osc.frequency.setValueAtTime(n.hz, t0 + n.t);
        if (n.glideMid) osc.frequency.exponentialRampToValueAtTime(n.glideMid, t0 + n.t + n.dur * 0.45);
        osc.frequency.exponentialRampToValueAtTime(n.glideTo || n.hz * 0.92, t0 + n.t + n.dur);   // default: slight fall inside each syllable
        if (n.vib) { const lfo = ctx.createOscillator(); lfo.frequency.value = n.vibHz || 6; const vg = ctx.createGain(); vg.gain.value = n.hz * n.vib; lfo.connect(vg); vg.connect(osc.frequency); lfo.start(t0 + n.t); lfo.stop(t0 + n.t + n.dur + 0.02); nodes.push(lfo); }
        const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.setValueAtTime(n.bp || (500 + (n.vowel == null ? 0.5 : n.vowel) * 1500), t0 + n.t); f.Q.value = n.q == null ? 2.2 : n.q;   // vowel colour
        if (n.bpTo) f.frequency.exponentialRampToValueAtTime(n.bpTo, t0 + n.t + n.dur);
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = n.lp || 3800;
        osc.connect(f); f.connect(lp); lp.connect(tail);
        osc.start(t0 + n.t); osc.stop(t0 + n.t + n.dur + 0.02);
        nodes.push(osc);
      }
    }
    return { stop() { for (const o of nodes) { try { o.stop(); } catch (_) {} } try { master.disconnect(); } catch (_) {} } };
  }

  /** A short "ouch" in the pet's own babble timbre: 2-3 quick high syllables with a falling tail. Same preset -> same
   *  character voice as its babble lines; used when a tts pet has no recorded whipReact clip, and for babble pets. */
  function planHit(opts) {
    const alias = { female: 'bright', male: 'low' };
    const pr = (opts && opts.preset) || 'bright';
    const base = PRESETS[alias[pr] || pr] || PRESETS.bright;
    const seed = (opts && opts.seed) || 0;
    const hz = (opts && opts.hz) || base.hz * 1.45;
    const n = 2 + (seed % 2);
    const dur = 0.075;
    const notes = [];
    for (let i = 0; i < n; i++) {
      const fall = i === n - 1 ? -5 : 3 - i * 2;                           // up, then a drop on the last syllable
      notes.push({ t: i * dur * 1.15, dur: dur * (i === n - 1 ? 1.6 : 1), hz: hz * Math.pow(2, fall / 12), vowel: 0.75 - i * 0.2, gain: 0.95 });
    }
    return { notes, total: n * dur * 1.15 + dur * 0.6, rate: 1 / dur };
  }

  /** Wordless reactions (0.8.12): the instant sound every touch gets, in the pet's own timbre, before / instead of a
   *  spoken line. Each kind is a tiny melody; `seed` varies it a little so it never sounds like a sample on repeat.
   *  kinds: click (hm?), stroke (mm~), drag (wobble), drop (oof), hit (ouch), feed (nom nom), drink (glug), sleep (yawn),
   *  happy (giggle), angry (hmph). Returns a plan for renderBabble. */
  function planReaction(kind, opts) {
    const alias = { female: 'female', male: 'male' };
    const pr = (opts && opts.preset) || 'bright';
    const base = PRESETS[alias[pr] || pr] || PRESETS.bright;
    const seed = (opts && opts.seed) || 0; const r = rng(seed * 7919 + 13);
    const hz = (opts && opts.hz) || base.hz; const v = base.vowel;
    const st = (semis, t, dur, vowel, gain) => ({ t, dur, hz: hz * Math.pow(2, semis / 12), vowel, gain });
    const j = () => (r() - 0.5) * 1.5;
    let notes = [];
    switch (kind) {
      case 'click':  notes = [st(2 + j(), 0, 0.09, v, 0.8), st(7 + j(), 0.1, 0.11, v + 0.1, 0.7)]; break;                         // "hm?" rising
      case 'stroke': notes = [st(-1 + j(), 0, 0.16, v + 0.2, 0.55), st(3 + j(), 0.17, 0.2, v + 0.25, 0.6), st(6 + j(), 0.38, 0.22, v + 0.2, 0.5)]; break;   // "mm~" soft rise
      case 'drag':   notes = [st(4 + j(), 0, 0.08, v, 0.8), st(-2 + j(), 0.09, 0.08, v, 0.75), st(5 + j(), 0.18, 0.08, v, 0.8), st(-1 + j(), 0.27, 0.1, v, 0.7)]; break;  // wobble
      case 'drop':   notes = [st(3 + j(), 0, 0.07, v - 0.1, 0.95), st(-6 + j(), 0.08, 0.18, v + 0.1, 0.7)]; break;                  // "oof" falling
      case 'feed':   notes = [st(0 + j(), 0, 0.09, v - 0.2, 0.8), st(-1 + j(), 0.12, 0.09, v - 0.2, 0.8), st(1 + j(), 0.24, 0.1, v - 0.1, 0.75)]; break;  // "nom nom"
      case 'drink':  notes = [st(-4 + j(), 0, 0.14, v + 0.1, 0.8), st(-7 + j(), 0.15, 0.1, v + 0.2, 0.6)]; break;                  // "glug"
      case 'sleep':  notes = [st(2 + j(), 0, 0.22, v + 0.3, 0.6), st(0 + j(), 0.23, 0.2, v + 0.3, 0.5), st(-5 + j(), 0.44, 0.3, v + 0.2, 0.4)]; break;   // yawn
      case 'happy':  notes = [st(8 + j(), 0, 0.07, v, 0.8), st(11 + j(), 0.08, 0.07, v, 0.8), st(8 + j(), 0.16, 0.07, v, 0.8), st(12 + j(), 0.24, 0.09, v, 0.75)]; break; // giggle
      case 'angry':  notes = [st(-3 + j(), 0, 0.12, v - 0.2, 0.9), st(-8 + j(), 0.13, 0.14, v - 0.1, 0.8)]; break;                 // "hmph"
      case 'typing': notes = [st(1 + j(), 0, 0.07, v + 0.1, 0.5)]; break;                                                        // tiny "hm" (0.8.15: keeps time with the keys)
      case 'whine':  notes = [st(4 + j(), 0, 0.18, v + 0.2, 0.7), st(2 + j(), 0.2, 0.16, v + 0.2, 0.6), st(-3 + j(), 0.38, 0.26, v + 0.1, 0.55)]; break;  // "mmm~" hungry / thirsty
      case 'surprise': notes = [st(6 + j(), 0, 0.06, v, 0.85), st(13 + j(), 0.07, 0.14, v + 0.1, 0.8)]; break;                     // "eh?!" jump
      case 'greet':  notes = [st(5 + j(), 0, 0.1, v, 0.8), st(9 + j(), 0.11, 0.1, v + 0.1, 0.8), st(7 + j(), 0.22, 0.14, v, 0.7)]; break;   // "hi~"
      case 'wake':   notes = [st(-2 + j(), 0, 0.2, v + 0.3, 0.5), st(4 + j(), 0.22, 0.22, v + 0.2, 0.65)]; break;                 // stretch
      case 'hit':    return planHit(Object.assign({}, opts, { preset: alias[pr] ? (pr === 'female' ? 'bright' : 'low') : pr }));
      default:       notes = [st(j(), 0, 0.1, v, 0.7)];
    }
    const total = notes.reduce((m, n) => Math.max(m, n.t + n.dur), 0) + 0.05;
    return { notes, total, rate: 10 };
  }

  // ---------------------------------------------------------------- species voices (0.8.14)
  // A real animal (pet.json.voice.species) does not babble: it meows / barks / chirps / squeaks. Everything is
  // synthesised from the same small vocabulary of notes (tone with glide + vibrato, bandpassed noise, AM purr), so a
  // cat always sounds like THIS cat (its baseHz) and a line in the bubble becomes a few meows sized by the text.
  const SPECIES = {
    cat:    { hz: 560 }, kitten: { hz: 760 },
    dog:    { hz: 230 }, 'dog-small': { hz: 380 }, 'dog-large': { hz: 150 },
    bird:   { hz: 2800 }, rodent: { hz: 3200 }, rabbit: { hz: 1800 },
  };
  function speciesBase(species) { return SPECIES[species] || SPECIES.cat; }

  function catPlan(kind, hz, r, n) {
    const meow = (t, dur, g, up) => ({ t, dur, hz: hz * (up ? 0.85 : 1.05), glideMid: hz * (up ? 1.35 : 1.3), glideTo: hz * (up ? 1.15 : 0.7), wave: 'sawtooth', vib: 0.03, vibHz: 7, bp: 900, bpTo: up ? 2100 : 700, q: 1.6, gain: g, hold: 0.5 });
    switch (kind) {
      case 'click':  return [meow(0, 0.32 + r() * 0.1, 0.8, true)];                                  // "mew?"
      case 'stroke': return [{ t: 0, dur: 0.9, hz: hz * 0.22, wave: 'triangle', am: 24, bp: 300, q: 1, gain: 0.5, hold: 0.7, attack: 0.08 }];  // purr
      case 'happy':  return [meow(0, 0.45, 0.8, false), meow(0.5, 0.3, 0.7, true)];
      case 'talk':   return Array.from({ length: n }, (_, i) => meow(i * 0.5, 0.36 + r() * 0.14, 0.75, i % 2 === 1));
      case 'angry':  return [{ t: 0, dur: 0.45, noise: 2800, noiseTo: 1800, q: 0.8, gain: 0.5, hold: 0.6 }];                        // hiss
      case 'hit':    return [{ t: 0, dur: 0.5, hz: hz * 1.4, glideMid: hz * 1.8, glideTo: hz * 0.6, wave: 'sawtooth', vib: 0.06, vibHz: 9, bp: 1400, bpTo: 600, q: 1.4, gain: 0.95 }];   // yowl
      case 'drag':   return [meow(0, 0.4, 0.75, true), meow(0.45, 0.2, 0.6, true)];                  // "mraow?!"
      case 'drop':   return [{ t: 0, dur: 0.18, hz: hz * 0.7, glideTo: hz * 0.5, wave: 'square', bp: 600, q: 2, gain: 0.7 }];
      case 'feed':   return [0, 0.16, 0.32].map(t => ({ t, dur: 0.09, noise: 900, q: 1.5, gain: 0.5 }));                           // nom nom
      case 'drink':  return [0, 0.14, 0.28, 0.42].map(t => ({ t, dur: 0.05, noise: 2200, q: 2, gain: 0.45 }));                      // lap lap
      case 'sleep':  return [{ t: 0, dur: 0.8, hz: hz * 0.9, glideTo: hz * 0.55, wave: 'triangle', vib: 0.02, bp: 700, bpTo: 400, q: 1.5, gain: 0.5, hold: 0.3 }];   // "mrrr…"
      case 'typing': return [{ t: 0, dur: 0.12, hz: hz * 0.6, glideTo: hz * 0.8, wave: 'triangle', bp: 500, q: 1.5, gain: 0.4 }];   // short "mrp" trill
      case 'whine':  return [meow(0, 0.55, 0.7, true), meow(0.6, 0.4, 0.6, true)];                   // long pleading meow
      case 'surprise': return [{ t: 0, dur: 0.14, hz: hz * 1.3, glideTo: hz * 1.6, wave: 'square', bp: 1200, q: 2, gain: 0.7 }];   // "mrr?!" chirp
      case 'greet':  return [meow(0, 0.3, 0.75, true), { t: 0.35, dur: 0.5, hz: hz * 0.22, wave: 'triangle', am: 24, bp: 300, q: 1, gain: 0.4, hold: 0.7, attack: 0.05 }];
      case 'wake':   return [{ t: 0, dur: 0.5, hz: hz * 0.8, glideMid: hz * 1.1, glideTo: hz * 0.9, wave: 'triangle', vib: 0.03, bp: 600, q: 1.4, gain: 0.5, hold: 0.4 }];   // stretchy "mrraw"
      default:       return [meow(0, 0.3, 0.7, false)];
    }
  }
  function dogPlan(kind, hz, r, n) {
    const bark = (t, g) => [{ t, dur: 0.07, noise: 700, noiseTo: 450, q: 1.0, gain: g, attack: 0.004 }, { t: t + 0.01, dur: 0.11, hz: hz * 1.2, glideTo: hz * 0.75, wave: 'square', bp: 650, q: 1.2, lp: 2500, gain: g * 0.9, attack: 0.006 }];
    switch (kind) {
      case 'click':  return bark(0, 0.85);
      case 'happy':  return [...bark(0, 0.85), ...bark(0.22 + r() * 0.05, 0.8)];
      case 'talk':   return Array.from({ length: n }, (_, i) => bark(i * (0.24 + r() * 0.06), 0.8)).flat();
      case 'stroke': return [{ t: 0, dur: 0.55, hz: hz * 1.6, glideMid: hz * 2.4, glideTo: hz * 2.1, wave: 'triangle', vib: 0.04, vibHz: 5, bp: 1200, q: 1.8, gain: 0.5, hold: 0.4 }];   // happy whine
      case 'angry':  return [{ t: 0, dur: 0.6, hz: hz * 0.4, wave: 'sawtooth', vib: 0.08, vibHz: 18, bp: 300, q: 1, lp: 1200, gain: 0.6, hold: 0.7 }, { t: 0, dur: 0.6, noise: 350, q: 0.7, gain: 0.3, hold: 0.7 }];   // growl
      case 'hit':    return [{ t: 0, dur: 0.22, hz: hz * 3.2, glideMid: hz * 4.6, glideTo: hz * 2.2, wave: 'sawtooth', bp: 1800, q: 1.4, gain: 0.95, attack: 0.005 }];   // yelp
      case 'drag':   return [{ t: 0, dur: 0.5, hz: hz * 1.5, glideMid: hz * 2.6, glideTo: hz * 1.4, wave: 'triangle', vib: 0.05, vibHz: 7, bp: 1100, q: 1.8, gain: 0.55 }];   // whine
      case 'drop':   return [{ t: 0, dur: 0.16, hz: hz * 0.6, glideTo: hz * 0.45, wave: 'square', bp: 400, q: 1.5, gain: 0.7 }];
      case 'feed':   return [0, 0.15, 0.3].map(t => ({ t, dur: 0.1, noise: 600, q: 1.2, gain: 0.55 }));
      case 'drink':  return [0, 0.13, 0.26, 0.39, 0.52].map(t => ({ t, dur: 0.05, noise: 1800, q: 2, gain: 0.45 }));
      case 'sleep':  return [{ t: 0, dur: 0.7, noise: 500, noiseTo: 250, q: 0.6, gain: 0.35, hold: 0.3, attack: 0.1 }];                // sigh
      case 'typing': return [{ t: 0, dur: 0.12, noise: 900, noiseTo: 600, q: 0.8, gain: 0.35 }];                                        // soft huff
      case 'whine':  return [{ t: 0, dur: 0.8, hz: hz * 1.7, glideMid: hz * 2.5, glideTo: hz * 1.9, wave: 'triangle', vib: 0.05, vibHz: 6, bp: 1200, q: 1.8, gain: 0.55, hold: 0.5 }];   // begging whine
      case 'surprise': return [{ t: 0, dur: 0.15, hz: hz * 2.6, glideTo: hz * 2, wave: 'sawtooth', bp: 1500, q: 1.4, gain: 0.7 }];   // short yip
      case 'greet':  return [...bark(0, 0.8), ...bark(0.2, 0.75), { t: 0.45, dur: 0.4, hz: hz * 1.6, glideTo: hz * 2, wave: 'triangle', vib: 0.04, bp: 1200, q: 1.8, gain: 0.45 }];
      case 'wake':   return [{ t: 0, dur: 0.6, hz: hz * 1.2, glideMid: hz * 1.9, glideTo: hz * 1.4, wave: 'triangle', vib: 0.05, vibHz: 5, bp: 900, q: 1.6, gain: 0.45, hold: 0.4 }, { t: 0.65, dur: 0.3, noise: 500, noiseTo: 300, q: 0.6, gain: 0.3 }];   // yawn + shake
      default:       return bark(0, 0.7);
    }
  }
  function birdPlan(kind, hz, r, n) {
    const chirp = (t, up) => ({ t, dur: 0.07 + r() * 0.03, hz: hz * (up ? 0.8 : 1.15), glideTo: hz * (up ? 1.3 : 0.75), wave: 'sine', bp: hz, q: 0.5, lp: 8000, gain: 0.6, attack: 0.004 });
    const run = (t0, k) => Array.from({ length: k }, (_, i) => chirp(t0 + i * 0.1, i % 2 === 0));
    switch (kind) {
      case 'click':  return run(0, 2);
      case 'happy':  return run(0, 5);
      case 'talk':   return run(0, Math.max(2, n * 2));
      case 'stroke': return [{ t: 0, dur: 0.6, hz: hz * 0.9, wave: 'sine', vib: 0.08, vibHz: 22, bp: hz, q: 0.5, lp: 8000, gain: 0.4, hold: 0.6 }];   // soft trill
      case 'angry': case 'hit': return [{ t: 0, dur: 0.3, noise: 2500, q: 0.9, gain: 0.5 }, { t: 0, dur: 0.3, hz: hz * 0.45, glideTo: hz * 0.3, wave: 'sawtooth', bp: 1500, q: 1, gain: 0.6 }];   // squawk
      case 'drag':   return run(0, 4);
      case 'drop':   return [chirp(0, false)];
      case 'feed':   return [0, 0.12, 0.24].map(t => ({ t, dur: 0.04, noise: 3000, q: 3, gain: 0.4 }));
      case 'drink':  return [0, 0.15].map(t => ({ t, dur: 0.05, noise: 2500, q: 3, gain: 0.35 }));
      case 'sleep':  return [{ t: 0, dur: 0.5, hz: hz * 0.7, glideTo: hz * 0.5, wave: 'sine', bp: hz * 0.6, q: 0.6, lp: 8000, gain: 0.35, hold: 0.3 }];
      case 'typing': return [chirp(0, true)];
      case 'whine':  return [{ t: 0, dur: 0.4, hz: hz * 0.7, glideMid: hz * 0.9, glideTo: hz * 0.6, wave: 'sine', vib: 0.06, vibHz: 12, bp: hz * 0.7, q: 0.5, lp: 8000, gain: 0.5, hold: 0.5 }];   // plaintive peep
      case 'surprise': return [{ t: 0, dur: 0.12, hz: hz * 1.3, glideTo: hz * 1.8, wave: 'sine', bp: hz * 1.4, q: 0.5, lp: 9000, gain: 0.7, attack: 0.003 }];
      case 'greet':  return run(0, 3);
      case 'wake':   return [{ t: 0, dur: 0.35, hz: hz * 0.6, glideTo: hz * 1.1, wave: 'sine', bp: hz * 0.8, q: 0.5, lp: 8000, gain: 0.45 }, ...run(0.4, 2)];
      default:       return run(0, 1);
    }
  }
  function rodentPlan(kind, hz, r, n) {
    const sq = (t, dur, g) => ({ t, dur, hz: hz * 0.9, glideMid: hz * 1.2, glideTo: hz * 0.8, wave: 'triangle', bp: hz, q: 0.6, lp: 9000, gain: g, attack: 0.005 });
    switch (kind) {
      case 'click':  return [sq(0, 0.09, 0.6)];
      case 'happy': case 'talk': return Array.from({ length: Math.max(2, n) }, (_, i) => sq(i * 0.13, 0.08, 0.55));
      case 'stroke': return [{ t: 0, dur: 0.7, hz: hz * 0.3, wave: 'triangle', am: 28, bp: hz * 0.3, q: 0.8, lp: 6000, gain: 0.35, hold: 0.7, attack: 0.08 }];   // contented bruxing
      case 'angry': case 'hit': return [sq(0, 0.2, 0.9), sq(0.22, 0.2, 0.85)];
      case 'drag':   return [sq(0, 0.1, 0.6), sq(0.12, 0.1, 0.6), sq(0.24, 0.1, 0.6)];
      case 'drop':   return [sq(0, 0.12, 0.7)];
      case 'feed':   return [0, 0.1, 0.2, 0.3].map(t => ({ t, dur: 0.04, noise: 2800, q: 3, gain: 0.4 }));
      case 'drink':  return [0, 0.12, 0.24].map(t => ({ t, dur: 0.04, noise: 3000, q: 3, gain: 0.35 }));
      case 'sleep':  return [{ t: 0, dur: 0.4, hz: hz * 0.6, glideTo: hz * 0.4, wave: 'sine', bp: hz * 0.5, q: 0.6, lp: 9000, gain: 0.3 }];
      case 'typing': return [sq(0, 0.06, 0.4)];
      case 'whine':  return [sq(0, 0.25, 0.6), sq(0.3, 0.3, 0.55)];                                   // drawn-out squeaks
      case 'surprise': return [sq(0, 0.07, 0.9)];
      case 'greet':  return [sq(0, 0.08, 0.55), sq(0.1, 0.08, 0.55), { t: 0.2, dur: 0.4, hz: hz * 0.3, wave: 'triangle', am: 28, bp: hz * 0.3, q: 0.8, lp: 6000, gain: 0.3, hold: 0.7, attack: 0.05 }];
      case 'wake':   return [{ t: 0, dur: 0.3, hz: hz * 0.5, glideTo: hz * 0.9, wave: 'sine', bp: hz * 0.6, q: 0.6, lp: 9000, gain: 0.4 }];
      default:       return [sq(0, 0.08, 0.5)];
    }
  }

  /** kind: a reaction kind (click, stroke, …), 'hit', or 'talk' (a bubble line: sized by opts.text). */
  function planAnimal(species, kind, opts) {
    opts = opts || {};
    const base = speciesBase(species); const hz = opts.hz || base.hz;
    const r = rng((opts.seed || 1) * 2654435761 >>> 0 || 7);
    const syl = kind === 'talk' ? syllableUnits(String(opts.text || '')).filter(u => u.syl).length : 0;
    const n = Math.max(1, Math.min(4, Math.round(syl / 4)));
    const fam = /dog/.test(species) ? dogPlan : species === 'bird' ? birdPlan : (species === 'rodent' || species === 'rabbit') ? rodentPlan : catPlan;
    const notes = fam(kind, hz, r, n);
    const total = notes.reduce((m, x) => Math.max(m, x.t + x.dur), 0) + 0.05;
    return { notes, total, rate: 1, species };
  }

  /** Whip crack: a filtered noise burst with a fast downward sweep plus a short click. Procedural, no asset.
   *  Returns a handle { stop() }; a no-op without WebAudio. */
  function whipCrack(volume) {
    if (!global.AudioContext && !global.webkitAudioContext) return { stop() {} };
    ctx = ctx || new (global.AudioContext || global.webkitAudioContext)();
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (_) {} }
    const t0 = ctx.currentTime + 0.005; const len = 0.22; const sr = ctx.sampleRate;
    const buf = ctx.createBuffer(1, Math.ceil(sr * len), sr); const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) { const k = i / d.length; d[i] = (Math.random() * 2 - 1) * Math.pow(1 - k, 2.2) * (k < 0.02 ? k / 0.02 : 1); }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(3800, t0); bp.frequency.exponentialRampToValueAtTime(500, t0 + 0.16);
    const click = ctx.createOscillator(); click.type = 'square'; click.frequency.setValueAtTime(1800, t0); click.frequency.exponentialRampToValueAtTime(300, t0 + 0.05);
    const cg = ctx.createGain(); cg.gain.setValueAtTime(0.5, t0); cg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
    const master = ctx.createGain(); master.gain.value = volume == null ? 0.6 : volume;
    src.connect(bp); bp.connect(master); click.connect(cg); cg.connect(master); master.connect(ctx.destination);
    src.start(t0); click.start(t0); click.stop(t0 + 0.06); src.stop(t0 + len);
    return { stop() { try { src.stop(); click.stop(); } catch (_) {} try { master.disconnect(); } catch (_) {} } };
  }


  // ---------------------------------------------------------------- scene sounds (0.8.15)
  // Not the pet's voice: things that happen around it. All procedural, each a few hundred ms, so every interaction
  // has a sound even when the pet itself is quiet (tts pet between clips, muted voice kind 'none' still gets scenes? no:
  // settings.muted silences everything; voice.kind=none only silences the voice).
  //   thud    : the pet lands after a throw           whoosh : the cup leaves the hand        splat : the cup bursts
  //   pop     : a flower bud appears                  bloom  : it opens (two-note sparkle)     pluck : the flower is picked
  //   chime   : hearts / petals / notes start         fanfare: level up                        knock : perch / cling grab
  function sfx(name, volume) {
    if (!global.AudioContext && !global.webkitAudioContext) return { stop() {} };
    ctx = ctx || new (global.AudioContext || global.webkitAudioContext)();
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (_) {} }
    const t0 = ctx.currentTime + 0.005; const sr = ctx.sampleRate; const nodes = [];
    const master = ctx.createGain(); master.gain.value = volume == null ? 0.5 : volume; master.connect(ctx.destination);
    const noise = (t, dur, f0, f1, q, g, type) => {
      const buf = ctx.createBuffer(1, Math.ceil(sr * (dur + 0.05)), sr); const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource(); src.buffer = buf; const f = ctx.createBiquadFilter(); f.type = type || 'bandpass'; f.Q.value = q;
      f.frequency.setValueAtTime(f0, t0 + t); if (f1) f.frequency.exponentialRampToValueAtTime(f1, t0 + t + dur);
      const gn = ctx.createGain(); gn.gain.setValueAtTime(0.0001, t0 + t); gn.gain.exponentialRampToValueAtTime(g, t0 + t + 0.01); gn.gain.exponentialRampToValueAtTime(0.0001, t0 + t + dur);
      src.connect(f); f.connect(gn); gn.connect(master); src.start(t0 + t); src.stop(t0 + t + dur + 0.05); nodes.push(src);
    };
    const tone = (t, dur, hz, hzTo, wave, g, attack) => {
      const o = ctx.createOscillator(); o.type = wave || 'sine'; o.frequency.setValueAtTime(hz, t0 + t); if (hzTo) o.frequency.exponentialRampToValueAtTime(hzTo, t0 + t + dur);
      const gn = ctx.createGain(); gn.gain.setValueAtTime(0.0001, t0 + t); gn.gain.exponentialRampToValueAtTime(g, t0 + t + (attack || 0.008)); gn.gain.exponentialRampToValueAtTime(0.0001, t0 + t + dur);
      o.connect(gn); gn.connect(master); o.start(t0 + t); o.stop(t0 + t + dur + 0.02); nodes.push(o);
    };
    switch (name) {
      case 'thud':    tone(0, 0.18, 110, 45, 'sine', 0.9); noise(0, 0.12, 400, 120, 0.7, 0.5, 'lowpass'); break;
      case 'whoosh':  noise(0, 0.35, 600, 2400, 0.6, 0.45); break;
      case 'splat':   noise(0, 0.22, 1800, 300, 0.8, 0.7); tone(0, 0.12, 320, 90, 'triangle', 0.5); for (let i = 0; i < 6; i++) noise(0.08 + i * 0.045, 0.04, 2500 + i * 300, 0, 3, 0.25); break;
      case 'pop':     tone(0, 0.08, 500, 900, 'sine', 0.6); break;
      case 'bloom':   tone(0, 0.25, 880, 0, 'sine', 0.45); tone(0.12, 0.35, 1318, 0, 'sine', 0.4); tone(0.24, 0.5, 1760, 0, 'sine', 0.35); break;
      case 'pluck':   tone(0, 0.14, 1200, 700, 'triangle', 0.55, 0.003); noise(0, 0.05, 3000, 0, 2, 0.2); break;
      case 'chime':   [1046, 1318, 1568, 2093].forEach((f, i) => tone(i * 0.09, 0.6, f, 0, 'sine', 0.35)); break;
      case 'fanfare': [[0, 523], [0.12, 659], [0.24, 784], [0.36, 1046]].forEach(([t, f]) => tone(t, 0.22, f, 0, 'triangle', 0.5)); tone(0.5, 0.7, 1046, 0, 'triangle', 0.5); tone(0.5, 0.7, 1318, 0, 'sine', 0.35); break;
      case 'knock':   tone(0, 0.07, 220, 140, 'square', 0.5); noise(0, 0.05, 900, 300, 1, 0.4); break;
      default:        tone(0, 0.08, 600, 0, 'sine', 0.4);
    }
    return { stop() { for (const o of nodes) { try { o.stop(); } catch (_) {} } try { master.disconnect(); } catch (_) {} } };
  }
  const SFX = ['thud', 'whoosh', 'splat', 'pop', 'bloom', 'pluck', 'chime', 'fanfare', 'knock'];
  const REACTION_KINDS = ['click', 'stroke', 'drag', 'drop', 'hit', 'feed', 'drink', 'sleep', 'happy', 'angry', 'typing', 'whine', 'surprise', 'greet', 'wake'];

  // ---------------------------------------------------------------- real recordings (0.8.16)
  // src/sounds/<species>/<kind>-NN.mp3 (CC0 / public domain / CC BY, see src/sounds/CREDITS.md) are what a real animal
  // plays; the synthesised planAnimal above is only the fallback for a kind that has no recording (nom nom, lap lap,
  // a dog's whine) or when the files cannot load. index.json: { cat: { talk: [...], stroke: [...] }, kitten: { _alias: 'cat', rate } }
  let bankIndex = null, bankLoading = null; const bankCache = {};
  function loadBank(base) {
    if (bankIndex) return Promise.resolve(bankIndex);
    if (!bankLoading) bankLoading = fetch((base || '') + 'sounds/index.json').then(r => r.json()).then(j => (bankIndex = j)).catch(() => (bankIndex = {}));
    return bankLoading;
  }
  /** Which recording pool a reaction kind draws from, per species; null = use the synth. */
  const POOL = {
    cat:    { talk: 'talk', click: 'talk', greet: 'talk', typing: 'talk', drop: 'talk', surprise: 'talk', wake: 'talk', drag: 'talk', happy: 'talk', whine: 'whine', stroke: 'stroke', angry: 'hiss', hit: 'angry' },
    dog:    { talk: 'talk', click: 'talk', greet: 'talk', typing: 'talk', drop: 'talk', surprise: 'talk', wake: 'talk', drag: 'talk', happy: 'talk', hit: 'talk', angry: 'talk', whine: 'howl' },
    bird:   { talk: 'talk', click: 'talk', greet: 'talk', typing: 'talk', drop: 'talk', surprise: 'talk', wake: 'talk', drag: 'talk', happy: 'talk', hit: 'talk', angry: 'talk', whine: 'talk', stroke: 'talk' },
    rodent: { talk: 'talk', click: 'talk', greet: 'talk', typing: 'talk', drop: 'talk', surprise: 'talk', wake: 'talk', drag: 'talk', happy: 'talk', hit: 'talk', angry: 'talk', whine: 'whine' },
    rabbit: { angry: 'thump', hit: 'thump', drop: 'thump', surprise: 'thump', drag: 'thump' },
  };
  function poolFor(species) { return POOL[/dog/.test(species) ? 'dog' : species === 'kitten' ? 'cat' : species] || POOL.cat; }
  function resolveSpecies(idx, species) {
    let sp = species, rate = 1, hops = 0;
    while (idx[sp] && idx[sp]._alias && hops++ < 3) { rate *= idx[sp].rate || 1; sp = idx[sp]._alias; }
    return { sp, rate };
  }
  /** Pick `n` recordings for (species, kind); [] when the bank has none -> caller falls back to the synth. */
  function pickRecordings(species, kind, n, seed) {
    const idx = bankIndex || {}; const pool = poolFor(species)[kind]; if (!pool) return [];
    let { sp, rate } = resolveSpecies(idx, species);
    let files = (idx[sp] && idx[sp][pool]) || [];
    if (!files.length && idx[sp] && idx[sp]._fallback) { const fb = resolveSpecies(idx, idx[sp]._fallback); sp = fb.sp; rate *= fb.rate; files = (idx[sp] && idx[sp][pool]) || []; }
    if (!files.length) return [];
    const r = rng((seed || 1) * 48271 + 11); const out = [];
    for (let i = 0; i < n; i++) out.push({ url: 'sounds/' + sp + '/' + files[Math.floor(r() * files.length)], rate });
    return out;
  }
  /** Play the real call(s) for a reaction. Returns null when there is no recording for this kind (use the synth),
   *  else a handle { stop() }. `opts.text` sizes a 'talk' (1-3 calls); typing is one short, quiet call. */
  function playAnimal(species, kind, opts) {
    opts = opts || {};
    const syl = kind === 'talk' ? syllableUnits(String(opts.text || '')).filter(u => u.syl).length : 0;
    const n = kind === 'talk' ? Math.max(1, Math.min(3, Math.round(syl / 5))) : (kind === 'happy' || kind === 'greet') ? 2 : 1;
    const picks = pickRecordings(species, kind, n, opts.seed);
    if (!picks.length || typeof Audio === 'undefined') return null;
    const vol = opts.volume == null ? (kind === 'typing' ? 0.3 : kind === 'hit' || kind === 'angry' ? 0.6 : 0.5) : opts.volume;
    const players = []; let stopped = false, i = 0;
    const next = () => {
      if (stopped || i >= picks.length) return;
      const pk = picks[i++]; const a = bankCache[pk.url] ? bankCache[pk.url].cloneNode() : new Audio(pk.url); bankCache[pk.url] = bankCache[pk.url] || a;
      a.volume = vol; a.playbackRate = pk.rate * (kind === 'typing' ? 1.05 : 1); a.preservesPitch = false; a.mozPreservesPitch = false;
      a.onended = () => setTimeout(next, 120 + Math.random() * 120); a.onerror = () => { if (opts.onFail) opts.onFail(); };
      players.push(a); a.play().catch(() => { if (opts.onFail) opts.onFail(); });
    };
    next();
    return { stop() { stopped = true; for (const a of players) { try { a.pause(); a.currentTime = 0; } catch (_) {} } } };
  }

  /** The pet's voice kind, with a safe default for packs made before voice.kind existed. */
  function voiceKind(manifest, voiceIndex) {
    const v = (manifest && manifest.voice) || {};
    if (v.kind === 'tts' || v.kind === 'babble' || v.kind === 'none') return v.kind;
    return (voiceIndex && Object.keys(voiceIndex).length) ? 'tts' : 'babble';
  }

  // ---------------------------------------------------------------- typing voice cooldown (0.9.4)
  // Every real voice that a typing event causes — the fast-typing startle, the "that's a lot of typing" line, the garden's
  // bud / bloom / pick lines, rule `typing*` steps and the soft per-nod "mrp" — goes through ONE gate: at most one real
  // voice per `cooldownSec` (pet.json.voice.cooldowns.typingSec, default 60). Bubbles, nods and flowers are untouched;
  // only the clip / synth is skipped. In-process only; the host does not call allow() while muted, so the mute switch
  // never counts as "played".
  const TYPING_COOLDOWN_SEC = 60;
  function typingCooldownSec(manifest) {
    const c = (((manifest && manifest.voice) || {}).cooldowns || {}).typingSec;
    return Number.isFinite(c) && c >= 0 ? c : TYPING_COOLDOWN_SEC;
  }
  class TypingGate {
    constructor(cooldownSec) { this.cooldownSec = cooldownSec == null ? TYPING_COOLDOWN_SEC : cooldownSec; this.lastAt = -Infinity; this.skipped = 0; }
    /** true when a typing-sourced voice may play now (and records it as played); false while cooling down. */
    allow(nowSec) { if (nowSec - this.lastAt < this.cooldownSec) { this.skipped++; return false; } this.lastAt = nowSec; return true; }
    remaining(nowSec) { return Math.max(0, this.cooldownSec - (nowSec - this.lastAt)); }
  }

  global.KapiVoice = { PRESETS, SPECIES, SFX, REACTION_KINDS, planBabble, renderBabble, voiceKind, syllableUnits, planHit, planReaction, planAnimal, whipCrack, sfx, loadBank, playAnimal, pickRecordings, POOL,
                       TypingGate, typingCooldownSec, TYPING_COOLDOWN_SEC };
})(typeof window !== 'undefined' ? window : globalThis);
