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

// Every frozen composition variant is verified: read its presentation strings (post
// line-breaking, post kashida-justification), strip the presentation-only U+0640 kashida
// runs, and reassemble the continuous text — this must recover the pinned canonical āyāt
// byte-identically. Kashida is applied AFTER verification by design; this check proves it
// only ever inserts U+0640 and nothing else.
const VARIANT_FILES = ['composition.json', 'composition-8line.json', 'composition-7line.json'];

function shapedInput(pinned, file) {
  const compPath = join(root, 'public/text', file);
  if (!existsSync(compPath)) {
    console.warn(`!! ${file} missing — verifying the pinned text against source only`);
    return [...pinned.ayahs];
  }
  const comp = JSON.parse(readFileSync(compPath, 'utf8'));
  const flow = comp.lines
    .flatMap((l) => l.presentation ?? [])
    .join(' ')
    .replaceAll('ـ', '') // strip kashida (U+0640) — presentation-only
    .replace(/ +/g, ' ')
    .trim()
    .normalize('NFC');
  const joined = pinned.ayahs.join(' ').normalize('NFC');
  // re-split the recovered flow at the canonical āyah boundaries for per-āyah reporting
  const out = [];
  let rest = flow;
  for (let i = 0; i < 7; i++) {
    const target = pinned.ayahs[i] ?? '';
    if (rest.startsWith(target)) {
      out.push(target);
      rest = rest.slice(target.length).replace(/^ /, '');
    } else {
      // misalignment — return the raw remainder so the diff shows where it broke
      out.push(rest.split(' ').slice(0, (target.match(/ /g) || []).length + 1).join(' '));
      rest = rest.split(' ').slice((target.match(/ /g) || []).length + 1).join(' ');
    }
  }
  if (rest.length) out[6] = `${out[6]} ${rest}`;
  void joined;
  return out;
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
function verifyAyahs(current) {
  let identical = true;
  const report = [];
  for (let i = 0; i < 7; i++) {
    const ours = (current[i] ?? '').normalize('NFC');
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
  return { identical, report };
}

console.log(`\nverification vs ${canon.source} (fetched ${canon.fetched}):`);
let allIdentical = true;
const variants = [];
for (const file of VARIANT_FILES) {
  if (!existsSync(join(root, 'public/text', file))) {
    console.log(` ${file}: absent (skipped)`);
    continue;
  }
  const { identical, report } = verifyAyahs(shapedInput(pinned, file));
  allIdentical &&= identical;
  variants.push({ file, identical, report });
  console.log(` ${file}: ${identical ? 'all seven āyāt identical' : 'DIFFERS'}`);
  if (!identical) {
    for (const r of report) {
      if (!r.diffs) continue;
      console.log(`  āyah ${r.ayah}:`);
      for (const d of r.diffs) console.log(`   @${d.at}: ours ${d.ours} · canonical ${d.theirs}`);
    }
  }
}
console.log(allIdentical ? '\nALL VARIANTS: SEVEN ĀYĀT IDENTICAL to the canonical source.' : '\nDIFFERENCES FOUND — the pipeline must adopt the canonical text.');
writeFileSync(
  join(root, 'build/text-verification.json'),
  JSON.stringify({ source: canon.source, url: canon.url, fetched: canon.fetched, canonicalSha256: canon.sha256, identical: allIdentical, variants }, null, 1),
);
