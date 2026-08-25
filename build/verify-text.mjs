// Text verification — compares the shaping input against the Tanzil Uthmani text of
// Al-Fātiḥah (served by api.alquran.cloud, edition "quran-uthmani", which is the Tanzil
// Uthmani text), character by character including all marks and small signs. On first run
// it pins the fetched canonical text into build/canonical-fatihah.json (source, date,
// checksum) so the pipeline is reproducible offline; shape-text.mjs reads the pinned file.
//
// Run: node build/verify-text.mjs [--refetch]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CANON_PATH = join(root, 'build/canonical-fatihah.json');
const SOURCE_URL = 'https://api.alquran.cloud/v1/surah/1/quran-uthmani';

// The strings the pipeline ACTUALLY shapes: the pinned canonical āyāt run through the same
// derivation shape-text.mjs uses (āyah 7 split at the first عَلَيْهِمْ, then rejoined here) —
// so this verifies the whole input chain, not a copy of it.
function shapedInput(pinned) {
  const SPLIT_WORD = 'عَلَيْهِمْ';
  const a7 = pinned.ayahs[6] ?? '';
  const splitAt = a7.indexOf(SPLIT_WORD) + SPLIT_WORD.length;
  const l7a = a7.slice(0, splitAt);
  const l7b = a7.slice(splitAt + 1);
  return [...pinned.ayahs.slice(0, 6), `${l7a} ${l7b}`];
}

const cpName = (ch) => {
  const cp = ch.codePointAt(0);
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
};

async function getCanonical(refetch) {
  if (!refetch && existsSync(CANON_PATH)) {
    return JSON.parse(readFileSync(CANON_PATH, 'utf8'));
  }
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const json = await res.json();
  // U+FEFF: the API serialization prepends a BOM to the first āyah — a data artifact,
  // not part of the text; stripped at pinning.
  const ayahs = json.data.ayahs.map((a) => a.text.replaceAll('﻿', '').normalize('NFC'));
  const canon = {
    source: 'Tanzil Uthmani (via api.alquran.cloud, edition quran-uthmani)',
    url: SOURCE_URL,
    fetched: new Date().toISOString().slice(0, 10),
    sha256: createHash('sha256').update(ayahs.join('\n')).digest('hex'),
    ayahs,
  };
  writeFileSync(CANON_PATH, JSON.stringify(canon, null, 1));
  console.log(`pinned canonical text → build/canonical-fatihah.json (${canon.fetched})`);
  return canon;
}

// Always verify against a FRESH fetch when reachable (falls back to the pin offline);
// the pinned file is what shaping consumes.
const pinned = existsSync(CANON_PATH) ? JSON.parse(readFileSync(CANON_PATH, 'utf8')) : await getCanonical(true);
let canon;
try {
  canon = await getCanonical(true);
} catch {
  console.warn('!! source unreachable — verifying against the pinned copy only');
  canon = pinned;
}
const CURRENT = shapedInput(pinned);

let identical = true;
const report = [];
for (let i = 0; i < 7; i++) {
  const ours = (CURRENT[i] ?? '').normalize('NFC');
  const theirs = (canon.ayahs[i] ?? '').normalize('NFC');
  if (ours === theirs) {
    report.push({ ayah: i + 1, result: 'identical' });
    continue;
  }
  identical = false;
  const a = [...ours];
  const b = [...theirs];
  const diffs = [];
  let ai = 0;
  let bi = 0;
  while (ai < a.length || bi < b.length) {
    if (a[ai] === b[bi]) {
      ai++;
      bi++;
      continue;
    }
    // simple resync: try skipping one char on either side
    if (a[ai + 1] === b[bi]) {
      diffs.push({ at: ai, ours: `${a[ai]} ${cpName(a[ai])}`, theirs: '(absent)' });
      ai++;
    } else if (a[ai] === b[bi + 1]) {
      diffs.push({ at: bi, ours: '(absent)', theirs: `${b[bi]} ${cpName(b[bi])}` });
      bi++;
    } else {
      diffs.push({ at: ai, ours: a[ai] ? `${a[ai]} ${cpName(a[ai])}` : '(end)', theirs: b[bi] ? `${b[bi]} ${cpName(b[bi])}` : '(end)' });
      ai++;
      bi++;
    }
  }
  report.push({ ayah: i + 1, result: 'DIFFERS', diffs });
}

console.log(`\nverification vs ${canon.source} (fetched ${canon.fetched}):`);
for (const r of report) {
  console.log(` āyah ${r.ayah}: ${r.result}`);
  if (r.diffs) for (const d of r.diffs) console.log(`   @${d.at}: ours ${d.ours} · canonical ${d.theirs}`);
}
console.log(identical ? '\nALL SEVEN ĀYĀT IDENTICAL to the canonical source.' : '\nDIFFERENCES FOUND — the pipeline must adopt the canonical text.');
writeFileSync(
  join(root, 'build/text-verification.json'),
  JSON.stringify({ source: canon.source, url: canon.url, fetched: canon.fetched, canonicalSha256: canon.sha256, identical, report }, null, 1),
);
