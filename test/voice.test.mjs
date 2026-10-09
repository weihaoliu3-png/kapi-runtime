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
