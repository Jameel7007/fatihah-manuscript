// Reference gate (owner-authorized 2026-09-19): drives a headless Chromium (Brave by default) through the
// 74-frame §20 matrix, captures each frame through the deterministic rig, and either BLESSES references
// (--bless, from two cold loads each) or VERIFIES the current build against them (--verify).
//
//   Both backends → bit-exact when the SHA-256 of the decoded PNG's RGBA equals the blessed hash; otherwise a
//   tolerance comparison against the blessed PNG (qa/frame-compare.mjs metrics) — changed pixels ≤ 1.0 %,
//   median ΔE76 of changed pixels ≤ 1.0, worst 5×5 block mean ΔE76 ≤ 4.0. Derived from 38 observed cold-load
//   pairs (build/step1-pair-metrics-2026-09-19.jsonl); a moved letter, changed gold or lighting shift lifts a
//   whole block. Measured 2026-09-19: frames are bit-identical within one browser process on both backends and
//   differ at ulp level (1-level scatter) between processes, so bit-exact is a bonus, tolerance is the gate.
//   The hash recorded here is computed by this script from the decoded blessed PNG (the page's own hash of its
//   readback is kept alongside as pageHash); the PNG is the reference artefact.
//
// Usage: node qa/verify-references.mjs --bless|--verify [--backend webgpu|webgl2] [--base http://localhost:4521]
//        [--browser "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"] [--only T1|T2|T3] [--retry 1]
// Never invents a hash: every value written comes from a capture the script performed and can be re-run.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pngDecode } from './png-io.mjs';
import { compare } from './frame-compare.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const mode = args.includes('--bless') ? 'bless' : args.includes('--verify') ? 'verify' : null;
if (!mode) { console.error('need --bless or --verify'); process.exit(2); }
const backends = opt('--backend') ? [opt('--backend')] : ['webgpu', 'webgl2'];
const base = opt('--base', 'http://localhost:4521');
const browser = opt('--browser', process.env.FATIHAH_BROWSER ?? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
const only = opt('--only', '');
const retries = Number(opt('--retry', '1'));
const port = 9400 + Math.floor(Math.random() * 400);
export const TOLERANCE = { changedPctMax: 1.0, dE76p50Max: 1.0, worstBlock5x5DE76Max: 4.0 };
const P = [0.0, 0.08, 0.21, 0.34, 0.45, 0.56, 0.645, 0.71, 0.76, 0.86, 0.93, 1.0];

function frames(backend) {
  const list = [];
  for (const p of P) {
    if (!only || only === 'T1') list.push({ id: `R-${p.toFixed(3)}-T1`, url: `/?capture=${p}&tier=1&w=1440&h=900&backend=${backend}` });
    if (!only || only === 'T2') list.push({ id: `R-${p.toFixed(3)}-T2`, url: `/?capture=${p}&tier=2&w=390&h=844&backend=${backend}` });
    if (!only || only === 'T3') list.push({ id: `R-${p.toFixed(3)}-T3`, url: `/?capture=${p}&tier=3&w=390&h=844&backend=${backend}` });
  }
  if (!only || only === 'T1') list.push({ id: 'R-1.000-T1-noblob', url: `/?capture=1.0&tier=1&w=1440&h=900&backend=${backend}&noblob` });
  return list;
}

const userData = join(root, 'build', `.headless-${mode}-${port}`);
mkdirSync(userData, { recursive: true });
const proc = spawn(browser, ['--headless=new', '--no-first-run', '--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal', '--ignore-gpu-blocklist', '--window-size=1512,900', `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { proc.kill(); } catch { /* gone */ } };
process.on('exit', cleanup);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 60; i++) { try { await (await fetch(`http://localhost:${port}/json/version`)).json(); break; } catch { await sleep(500); } }

async function cdp(ws) { // minimal DevTools client
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  return (method, params = {}) => new Promise((res, rej) => { const my = ++id; pending.set(my, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))); ws.send(JSON.stringify({ id: my, method, params })); });
}
async function capture(url) {
  const tab = await (await fetch(`http://localhost:${port}/json/new?${encodeURIComponent(base + url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const call = await cdp(ws);
  const t0 = Date.now();
  let out;
  while (Date.now() - t0 < 120000) {
    await sleep(300);
    try {
      const r = await call('Runtime.evaluate', { expression: 'window.__capture ? {hash: window.__capture.hash, backend: window.__capture.backend, dataUrl: window.__capture.dataUrl} : (window.__captureError ? {error: String(window.__captureError)} : null)', returnByValue: true });
      if (r.result.value) { out = r.result.value; break; }
    } catch { /* navigating */ }
  }
  ws.close();
  await fetch(`http://localhost:${port}/json/close/${tab.id}`);
  if (!out) throw new Error(`timeout capturing ${url}`);
  if (out.error) throw new Error(`capture error ${url}: ${out.error}`);
  const png = Buffer.from(out.dataUrl.slice(out.dataUrl.indexOf(',') + 1), 'base64');
  const pix = pngDecode(png).pix;
  const hash = createHash('sha256').update(pix).digest('hex');
  return { hash, pageHash: out.hash, backend: out.backend, png };
}
const within = (m) => m.changedPct <= TOLERANCE.changedPctMax && m.dE76p50 <= TOLERANCE.dE76p50Max && m.worstBlock5x5DE76 <= TOLERANCE.worstBlock5x5DE76Max;

const manifestPath = join(root, 'qa/references/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const framesDir = join(root, 'qa/references/frames');
const results = [];
let failures = 0;
for (const backend of backends) {
  for (const f of frames(backend)) {
    const dir = join(framesDir, backend); mkdirSync(dir, { recursive: true });
    const pngPath = join(dir, `${f.id}.png`);
    const row = { id: f.id, backend, url: f.url };
    try {
      if (mode === 'bless') {
        const a = await capture(f.url);
        if (a.backend !== backend) throw new Error(`backend mismatch: page ran ${a.backend}`);
        let b = await capture(f.url); let loads = 2;
        if (a.hash === b.hash) { row.mode = 'bit'; }
        else {
          let m = compare(a.png, b.png); row.pairMetrics = m;
          if (!within(m) && retries > 0) { b = await capture(f.url); loads++; m = compare(a.png, b.png); row.pairMetrics = m; }
          if (within(m)) row.mode = 'tolerance'; else throw new Error(`two cold loads differ beyond tolerance: ${JSON.stringify(m)}`);
        }
        writeFileSync(pngPath, a.png);
        Object.assign(row, { sha256: a.hash, pageHash: a.pageHash, secondLoad: b.hash, loads, png: `qa/references/frames/${backend}/${f.id}.png`, verified: new Date().toISOString() });
      } else {
        const ref = manifest.blessed_2026_09_19?.frames?.find((r) => r.id === f.id && r.backend === backend);
        if (!ref) { row.status = 'unblessed'; results.push(row); console.log(`unblessed ${backend} ${f.id}`); continue; }
        let c = await capture(f.url); row.sha256 = c.hash; row.blessed = ref.sha256;
        if (c.hash === ref.sha256) row.status = 'match';
        else {
          let m = compare(readFileSync(join(root, ref.png)), c.png); row.metrics = m;
          if (!within(m) && retries > 0) { c = await capture(f.url); row.sha256Retry = c.hash; m = compare(readFileSync(join(root, ref.png)), c.png); row.metricsRetry = m; }
          row.status = within(m) ? 'match-tolerance' : 'FAIL';
        }
        if (row.status === 'FAIL') failures++;
      }
    } catch (e) { row.status = 'FAIL'; row.error = String(e.message); failures++; }
    results.push(row);
    console.log(`${(row.status ?? row.mode).padEnd(15)} ${backend.padEnd(6)} ${f.id.padEnd(20)} ${(row.sha256 ?? '').slice(0, 16)}${row.pairMetrics ? '  pair ' + JSON.stringify(row.pairMetrics) : ''}${row.metrics ? '  ' + JSON.stringify(row.metrics) : ''}${row.error ? '  ' + row.error : ''}`);
  }
}
cleanup();
const stamp = new Date().toISOString();
if (mode === 'bless') {
  if (failures) { console.error(`${failures} frame(s) failed to reproduce — manifest NOT written`); process.exit(1); }
  const fresh = JSON.parse(readFileSync(manifestPath, 'utf8')); // re-read: another backend's run may have written meanwhile
  Object.assign(manifest, fresh);
  const section = manifest.blessed_2026_09_19 ?? { authorization: 'owner, 2026-09-19: "okay pass everything" (chat), after the ledger entry proposing this gate', environment: { machine: 'MacBook Pro Mac14,9 (Apple M2 Pro), macOS 26.6', browser: 'Brave 153 --headless=new (Chromium 153, ANGLE Metal), --enable-unsafe-webgpu', three: '0.185.1', capture: 'rig, DPR 1, 15 warm-up frames; hash = SHA-256 of raw RGBA' }, gate: { both: 'bit-exact SHA-256 of the decoded PNG RGBA when it reproduces; else tolerance vs the blessed PNG', measured: 'bit-identical within one browser process on both backends; ulp-level scatter between processes (2026-09-19)', tolerance: TOLERANCE, note: 'Historical frames[] entries (27) are preserved untouched and are not consulted by this gate.' }, frames: [] };
  for (const r of results) { const i = section.frames.findIndex((x) => x.id === r.id && x.backend === r.backend); if (i >= 0) section.frames[i] = r; else section.frames.push(r); }
  section.lastBlessed = stamp;
  manifest.blessed_2026_09_19 = section;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`blessed ${results.length} frame(s) → manifest.blessed_2026_09_19 (${results.filter((r) => r.mode === 'tolerance').length} by tolerance)`);
} else {
  const report = { date: stamp, base, browser, backends, tolerance: TOLERANCE, frames: results.length, match: results.filter((r) => r.status === 'match').length, matchTolerance: results.filter((r) => r.status === 'match-tolerance').length, unblessed: results.filter((r) => r.status === 'unblessed').length, fail: failures, results };
  const out = join(root, 'build', `verify-report-${stamp.slice(0, 19).replace(/[:T]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify(report, null, 1));
  console.log(`\nverify: ${report.frames} frames — ${report.match} match · ${report.matchTolerance} match by tolerance · ${report.unblessed} unblessed · ${report.fail} FAIL → ${out}`);
  process.exit(failures ? 1 : 0);
}
