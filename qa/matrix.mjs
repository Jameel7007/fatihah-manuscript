// §20 regression matrix checker (M7). The self-driving runner (public/qa/matrix.html) posts
// its hash table to the capture sink as qa/review/matrix-<backend>.png (JSON bytes); this
// compares every frame against the blessed references in qa/references/manifest.json and
// writes build/matrix-report.json.
//
// Usage: node qa/matrix.mjs [webgpu|webgl2]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const backend = process.argv[2] ?? 'webgpu';
const only = process.argv[3] ?? '';
const tag = only ? `matrix-${backend}-${only}` : `matrix-${backend}`;
const src = join(root, `qa/review/${tag}.png`);
if (!existsSync(src)) throw new Error(`no runner output at ${src} — open /qa/matrix.html?backend=${backend}${only ? '&only=' + only : ''} first`);
const run = JSON.parse(readFileSync(src, 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'qa/references/manifest.json'), 'utf8'));

// blessed references: frames[] entries whose id is exactly R-<p>-T<n> (no suffix) and whose
// hash is a clean 64-hex string (stale/superseded entries carry annotations)
const blessed = new Map();
for (const f of manifest.frames) {
  const m = /^R-([0-9.]+)-T(\d)$/.exec(f.id);
  if (!m) continue;
  const sha = f.sha256?.[backend];
  if (typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha)) blessed.set(`${(+m[1]).toFixed(3)}-T${m[2]}`, sha);
}

const rows = [];
let match = 0;
let mismatch = 0;
let unblessed = 0;
let errors = 0;
for (const r of run.results) {
  const m = /^R-([0-9.]+)-T(\d)(-noblob)?-/.exec(r.id);
  const key = m ? `${(+m[1]).toFixed(3)}-T${m[2]}${m[3] ?? ''}` : r.id;
  const ref = m && !m[3] ? blessed.get(key) : undefined;
  let status;
  if (!/^[0-9a-f]{64}$/.test(r.sha256)) {
    status = 'error';
    errors++;
  } else if (ref === undefined) {
    status = 'unblessed';
    unblessed++;
  } else if (ref === r.sha256) {
    status = 'match';
    match++;
  } else {
    status = 'MISMATCH';
    mismatch++;
  }
  rows.push({ id: r.id, key, status, sha256: r.sha256, blessed: ref ?? null });
}
const report = { backend, ran: run.ran, seconds: run.seconds, frames: rows.length, match, mismatch, unblessed, errors, rows };
writeFileSync(join(root, `build/${tag.replace('matrix-', 'matrix-report-')}.json`), JSON.stringify(report, null, 1));
for (const r of rows) console.log(`${r.status.padEnd(9)} ${r.id}  ${r.sha256.slice(0, 16)}${r.blessed ? '  (ref ' + r.blessed.slice(0, 8) + ')' : ''}`);
console.log(`\nmatrix ${tag}: ${rows.length} frames in ${run.seconds}s — ${match} match · ${mismatch} mismatch · ${unblessed} unblessed · ${errors} errors → build/${tag.replace('matrix-', 'matrix-report-')}.json`);
process.exit(mismatch > 0 || errors > 0 ? 1 : 0);
