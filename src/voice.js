// Kapi voice (v0.7): one voice kind per pet, never mixed.
//   kind = 'tts'    : pre-rendered mp3 per fixed line (voice/index.json); lines without a clip are bubble-only (silent).
//   kind = 'babble' : "Animalese"-style synthetic syllables for EVERY line (fixed lines and chat replies alike),
//                     generated with WebAudio from the text's length and the persona's pitch — no files, no network.
//   kind = 'none'   : silent.
// Pure planning (planBabble) is separated from rendering (renderBabble) so it can be unit-tested without an AudioContext.
(function (global) {
  'use strict';

  // base pitch per preset (Hz) and syllable rate (syllables / second)
  const PRESETS = { soft: { hz: 330, rate: 9, jitter: 0.08, vowel: 0.55 }, bright: { hz: 440, rate: 12, jitter: 0.14, vowel: 0.45 }, low: { hz: 240, rate: 8, jitter: 0.06, vowel: 0.65 } };

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
      const osc = ctx.createOscillator(); osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(n.hz, t0 + n.t);
      osc.frequency.exponentialRampToValueAtTime(n.hz * 0.92, t0 + n.t + n.dur);           // slight fall inside each syllable
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 500 + n.vowel * 1500; f.Q.value = 2.2;   // vowel colour
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3800;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0 + n.t);
      g.gain.exponentialRampToValueAtTime(n.gain, t0 + n.t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.t + n.dur);
      osc.connect(f); f.connect(lp); lp.connect(g); g.connect(master);
      osc.start(t0 + n.t); osc.stop(t0 + n.t + n.dur + 0.02);
      nodes.push(osc);
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

  /** The pet's voice kind, with a safe default for packs made before voice.kind existed. */
  function voiceKind(manifest, voiceIndex) {
    const v = (manifest && manifest.voice) || {};
    if (v.kind === 'tts' || v.kind === 'babble' || v.kind === 'none') return v.kind;
    return (voiceIndex && Object.keys(voiceIndex).length) ? 'tts' : 'babble';
  }

  global.KapiVoice = { PRESETS, planBabble, renderBabble, voiceKind, syllableUnits, planHit, whipCrack };
})(typeof window !== 'undefined' ? window : globalThis);
