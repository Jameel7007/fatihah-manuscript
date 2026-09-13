// §18 payload report (M7) — sizes every shipped byte after `vite build`: raw, gzip, brotli;
// assigns each asset to its §18 load phase (A: reaches the live rolled parchment; B: streams
// after first present; C: glyph mesh, needed before p ≈ 0.55); estimates poster → live on a
// 10 Mbps connection; gates the brotli total against the 8.5 MB target / 10 MB hard cap.
//
// Usage: npx vite build && node qa/payload.mjs

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_MB = 8.5;
const CAP_MB = 10;
const MBPS = 10;

function sizes(buf) {
  return {
    raw: buf.length,
    gz: gzipSync(buf, { level: 9 }).length,
    br: brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }).length,
  };
}

const items = [];
const add = (path, phase, kind) => {
  const full = join(root, path);
  if (!existsSync(full)) return;
  const buf = readFileSync(full);
  items.push({ path, phase, kind, ...sizes(buf) });
};

// app JS (dist)
const distAssets = join(root, 'dist/assets');
if (!existsSync(distAssets)) throw new Error('run `npx vite build` first');
for (const f of readdirSync(distAssets).sort()) {
  if (f.endsWith('.js') || f.endsWith('.css')) add(`dist/assets/${f}`, f.startsWith('fallback-') ? 'F' : 'A', 'app');
}
add('dist/index.html', 'A', 'html');
// poster + LQIP (inline LQIP is inside index.html)
add('public/poster.jpg', 'A', 'poster');
add('public/poster-portrait.jpg', 'A', 'poster-portrait'); // v1.6.7: a portrait viewport fetches this one INSTEAD of poster.jpg (<picture>); phase A counts both, conservatively
// §15 seven-plate folio is requested only on renderer failure (or explicit QA).
for (let i = 1; i <= 7; i++) add(`public/fallback/plate-${i}.jpg`, 'F', 'fallback-plate');
// ink atlases + instances — the writing state needs them (phase B streams after first present)
add('public/text/ink-mtsdf.png', 'B', 'atlas');
add('public/text/ink-prog.png', 'B', 'atlas');
add('public/text/ink-instances.json', 'B', 'instances');
// glyph mesh — phase C
add('public/text/glyphs.bin', 'C', 'mesh');
add('public/text/glyphs-t3.bin', 'C', 'mesh-t3');
// note: parchment / utility / environment / burnish maps are GPU-baked procedurally at boot —
// zero transfer (the §18 KTX2 rows apply to authored maps this build does not ship)

const phaseTotals = {};
for (const it of items) {
  const ph = (phaseTotals[it.phase] ??= { raw: 0, gz: 0, br: 0, files: 0 });
  ph.raw += it.raw;
  ph.gz += it.gz;
  ph.br += it.br;
  ph.files++;
}
const total = items.reduce((a, it) => ({ raw: a.raw + it.raw, gz: a.gz + it.gz, br: a.br + it.br }), { raw: 0, gz: 0, br: 0 });
const mb = (b) => +(b / 1048576).toFixed(3);
const secondsAt = (bytes) => +((bytes * 8) / (MBPS * 1e6)).toFixed(2);
const phaseA = phaseTotals.A ?? { br: 0 };
// poster → live: phase A bytes at 10 Mbps + a pipeline pre-compile allowance (measured M7 boot ≈ 0.6 s
// on Apple Silicon; mobile budgeted at 1.0 s) + 3 presented frames + the 420 ms crossfade
const posterToLive = { transfer_s: secondsAt(phaseA.br), compile_allowance_s: 1.0, crossfade_s: 0.42, estimate_s: +(secondsAt(phaseA.br) + 1.0 + 0.05 + 0.42).toFixed(2), limit_s: 2.2 };
const pass = mb(total.br) <= TARGET_MB && posterToLive.estimate_s <= posterToLive.limit_s;

const report = {
  built: new Date().toISOString().slice(0, 10),
  budget: { target_mb: TARGET_MB, hard_cap_mb: CAP_MB, transfer_metric: 'brotli (gzip also listed)' },
  totals: { raw_mb: mb(total.raw), gz_mb: mb(total.gz), br_mb: mb(total.br) },
  phases: Object.fromEntries(Object.entries(phaseTotals).map(([k, v]) => [k, { files: v.files, raw_mb: mb(v.raw), gz_mb: mb(v.gz), br_mb: mb(v.br), seconds_at_10mbps_br: secondsAt(v.br) }])),
  posterToLive,
  items: items.map((it) => ({ ...it, raw_kb: +(it.raw / 1024).toFixed(1), gz_kb: +(it.gz / 1024).toFixed(1), br_kb: +(it.br / 1024).toFixed(1) })),
  notes: [
    'parchment fiber/utility/environment/burnish maps are procedural GPU bakes — zero transfer; the §18 KTX2 rows for authored maps do not apply to this build',
    'glyphs.bin and glyphs-t3.bin ship as FGLY quantized planar buffers; each client requests only its selected tier (meshopt/glb remains optional while the aggregate payload is under budget)',
    'ink atlases stay PNG (UASTC would cost more transfer for a 2048×256 atlas pair)',
  ],
  pass,
};
writeFileSync(join(root, 'build/payload-report.json'), JSON.stringify(report, null, 1));
console.log(`payload: raw ${mb(total.raw)} MB · gzip ${mb(total.gz)} MB · brotli ${mb(total.br)} MB (target ${TARGET_MB}, cap ${CAP_MB})`);
for (const [k, v] of Object.entries(report.phases)) console.log(`  phase ${k}: ${v.files} files · br ${v.br_mb} MB · ${v.seconds_at_10mbps_br}s @10 Mbps`);
console.log(`  poster → live estimate ${posterToLive.estimate_s}s (limit ${posterToLive.limit_s}s: transfer ${posterToLive.transfer_s}s + compile ${posterToLive.compile_allowance_s}s + crossfade ${posterToLive.crossfade_s}s)`);
console.log(`payload report: ${pass ? 'PASS' : 'FAIL'} → build/payload-report.json`);
process.exit(pass ? 0 : 1);
