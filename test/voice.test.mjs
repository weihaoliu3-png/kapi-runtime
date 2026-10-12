import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
new Function(readFileSync(new URL('../src/voice.js', import.meta.url), 'utf8'))();
const { KapiVoice } = globalThis;
// syllables: CJK one per char, latin ~ per 3 letters, punctuation = pauses
assert.equal(KapiVoice.syllableUnits('我在我在！').filter(u => u.syl).length, 4);
assert.equal(KapiVoice.syllableUnits('Hello there, friend.').filter(u => u.syl).length, 2 + 2 + 2);
assert.ok(KapiVoice.syllableUnits('好嘛，好嘛。').some(u => u.pause));
// plan: deterministic, bounded, question rises at the end, long lines compressed
const a = KapiVoice.planBabble('找我吗？', { preset: 'bright' }), b = KapiVoice.planBabble('找我吗？', { preset: 'bright' });
assert.deepEqual(a, b, 'same text -> same babble');
assert.ok(a.notes.at(-1).hz > a.notes[0].hz * 1.15, 'question rises');
const longLine = KapiVoice.planBabble('这是一句特别特别长的台词用来测试会不会被压缩到一点八秒以内而不是被截断掉', { preset: 'soft' });
assert.ok(longLine.total <= 1.9, 'compressed, not cut'); assert.equal(longLine.notes.length, '这是一句特别特别长的台词用来测试会不会被压缩到一点八秒以内而不是被截断掉'.length);
assert.ok(KapiVoice.planBabble('x', { preset: 'low' }).notes[0].hz < KapiVoice.planBabble('x', { preset: 'bright' }).notes[0].hz, 'low preset is lower');
// kind resolution: explicit wins; legacy packs: clips present -> tts, none -> babble
assert.equal(KapiVoice.voiceKind({ voice: { kind: 'none' } }, { a: 'x' }), 'none');
assert.equal(KapiVoice.voiceKind({ voice: { dir: 'voice' } }, { a: 'x' }), 'tts');
assert.equal(KapiVoice.voiceKind({}, {}), 'babble');
// render without AudioContext is a no-op handle
assert.doesNotThrow(() => KapiVoice.renderBabble(a, 0.5).stop());
console.log('voice tests passed');
// whip hit sounds: a short high "ouch" in the pet's own preset timbre; the crack is a no-op without WebAudio
{ const hitB = KapiVoice.planHit({ preset: 'bright' }), hitL = KapiVoice.planHit({ preset: 'low' }), hitF = KapiVoice.planHit({ preset: 'female' });
  assert.ok(hitB.notes.length >= 2 && hitB.total < 0.4, 'short burst');
  assert.ok(hitB.notes[0].hz > KapiVoice.PRESETS.bright.hz, 'higher than the speaking pitch');
  assert.ok(hitL.notes[0].hz < hitB.notes[0].hz, 'low preset stays lower'); assert.equal(hitF.notes[0].hz, hitB.notes[0].hz, 'female maps to bright');
  assert.ok(hitB.notes.at(-1).hz < hitB.notes[0].hz, 'falls at the end');
  assert.doesNotThrow(() => KapiVoice.whipCrack(0.6).stop());
  console.log('whip sounds ok'); }


// 0.8.12 wordless reactions: every kind yields a short plan in the pet's timbre; human presets exist; deterministic per seed
{ const V = globalThis.KapiVoice;
  for (const k of ['click', 'stroke', 'drag', 'drop', 'feed', 'drink', 'sleep', 'happy', 'angry', 'hit']) {
    const pl = V.planReaction(k, { preset: 'female', seed: 3 });
    assert.ok(pl.notes.length >= 2 && pl.total > 0.1 && pl.total < 1.2, `reaction ${k} is short (${pl.total})`);
    for (const n of pl.notes) assert.ok(n.hz > 80 && n.hz < 2000, `reaction ${k} pitch sane`);
  }
  assert.ok(V.PRESETS.female.hz < V.PRESETS.bright.hz && V.PRESETS.male.hz < V.PRESETS.female.hz, 'human presets: male < female < bright');
  const a = V.planReaction('click', { preset: 'male', seed: 5 }), b = V.planReaction('click', { preset: 'male', seed: 5 }), c = V.planReaction('click', { preset: 'male', seed: 6 });
  assert.deepEqual(a, b, 'same seed -> same reaction'); assert.notDeepEqual(a, c, 'different seed -> varied');
  console.log('reactions ok'); }

// 0.8.14 species voices: every species x kind yields a finite plan; a line becomes 1-4 calls sized by its text; dogs bark (noise + tone), cats purr (AM) when stroked
{ const V = globalThis.KapiVoice;
  for (const sp of Object.keys(V.SPECIES)) for (const k of ['click', 'stroke', 'drag', 'drop', 'hit', 'feed', 'drink', 'sleep', 'happy', 'angry', 'talk']) {
    const pl = V.planAnimal(sp, k, { seed: 2, text: '我在我在！' });
    assert.ok(pl.notes.length >= 1 && pl.total > 0.03 && pl.total < 3, `${sp}/${k} plan sane (${pl.total})`);
    for (const n of pl.notes) assert.ok((n.hz == null || (n.hz > 40 && n.hz < 12000)) && n.dur > 0 && n.gain > 0, `${sp}/${k} note sane`);
  }
  assert.ok(V.planAnimal('dog', 'click', {}).notes.some(n => n.noise) && V.planAnimal('dog', 'click', {}).notes.some(n => n.hz), 'a bark = noise burst + tone');
  assert.ok(V.planAnimal('cat', 'stroke', {}).notes[0].am, 'a stroked cat purrs (AM)');
  const short = V.planAnimal('cat', 'talk', { text: '嗯。' }).notes.length, long = V.planAnimal('cat', 'talk', { text: '今天也要加油哦，别忘了喝水休息一下。' }).notes.length;
  assert.ok(long > short, 'longer line -> more meows');
  console.log('species voices ok'); }
// 0.8.15: every interaction has a sound — new reaction kinds for humans and every species, plus scene sfx
{ for (const k of KapiVoice.REACTION_KINDS) {
    const h = KapiVoice.planReaction(k, { preset: 'female' }); assert.ok(h.notes.length >= 1 && h.total < 1.2, 'human ' + k);
    for (const sp of Object.keys(KapiVoice.SPECIES)) { const a = KapiVoice.planAnimal(sp, k, {}); assert.ok(a.notes.length >= 1 && a.total < 1.6, sp + ' ' + k); }
  }
  assert.ok(KapiVoice.REACTION_KINDS.includes('typing') && KapiVoice.REACTION_KINDS.includes('whine') && KapiVoice.REACTION_KINDS.includes('wake'));
  const ty = KapiVoice.planReaction('typing', { preset: 'female' }); assert.ok(ty.total < 0.2 && ty.notes[0].gain <= 0.5, 'typing note is tiny and soft');
  assert.ok(KapiVoice.planAnimal('cat', 'typing', {}).total < 0.3, 'cat typing trill is short');
  for (const n of KapiVoice.SFX) assert.doesNotThrow(() => KapiVoice.sfx(n, 0.5).stop(), n);
  assert.deepEqual(KapiVoice.SFX, ['thud', 'whoosh', 'splat', 'pop', 'bloom', 'pluck', 'chime', 'fanfare', 'knock']);
  console.log('interaction sounds ok'); }
