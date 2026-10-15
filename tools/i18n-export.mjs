// Dump the built-in English set from src/i18n.js as plain JSON.
//
// That dump is the BASE every language pack is written against and checked against: same keys, same
// {placeholders}, strings only. Packs themselves do NOT live here — they live in the skill
// (kapi-deskpet/assets/i18n/<lang>.json) and are copied into a pet package as ui.json at packaging time, so
// adding a language never needs a runtime rebuild.
//
//   node tools/i18n-export.mjs                 -> prints the base to stdout
//   node tools/i18n-export.mjs out/base.en.json -> writes it
//
// Re-run this and refresh the skill's assets/i18n/_base.en.json whenever a UI string is added or changed here;
// the skill's selftest compares every pack against that file.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const g = {};
new Function('globalThis', readFileSync(join(HERE, '..', 'src', 'i18n.js'), 'utf8'))(g);
const en = g.I18N.strings.en;

// _lang / _dir are computed per pet from persona.language, never translated
const { _dir, _lang, ...rest } = en;
const out = JSON.stringify(rest, null, 2) + '\n';

const dest = process.argv[2];
if (dest) { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, out, 'utf8'); console.error(`wrote ${dest}`); }
else process.stdout.write(out);
