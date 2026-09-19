// Step 1 evidence tool: characterise cross-load differences between two captured frames.
// Usage: node qa/frame-compare.mjs A.png B.png        → one JSON line
//        node qa/frame-compare.mjs --pairs             → every qa/review/v166-diff-*-baseline/-repeat pair
// Metrics: changed pixels (any RGBA channel), max channel delta, ΔE76 (sRGB→Lab) per changed pixel
// (max and p99.9), and the worst 3×3 and 5×5 block mean ΔE76 — a single-pixel star flip stays local, a
// real regression (shifted lettering, changed gold) lifts a whole block. Diagnostic only; nothing here
// blesses a reference.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pngDecode } from './png-io.mjs';

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
function lab(r, g, b) {
  const R = lin(r), G = lin(g), B = lin(b);
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, y = 0.2126 * R + 0.7152 * G + 0.0722 * B, z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
export function compare(aBuf, bBuf) {
  const A = pngDecode(aBuf), B = pngDecode(bBuf);
  if (A.w !== B.w || A.h !== B.h) throw new Error(`size mismatch ${A.w}x${A.h} vs ${B.w}x${B.h}`);
  const w = A.w, h = A.h, a = A.pix, b = B.pix;
  const dE = new Float32Array(w * h);
  let changed = 0, maxDelta = 0, maxDE = 0;
  const des = [];
  for (let i = 0, p = 0; i < a.length; i += 4, p++) {
    let d = 0;
    for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(a[i + k] - b[i + k]));
    if (d) {
      changed++; maxDelta = Math.max(maxDelta, d);
      const la = lab(a[i], a[i + 1], a[i + 2]), lb = lab(b[i], b[i + 1], b[i + 2]);
      const e = Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
      dE[p] = e; des.push(e); maxDE = Math.max(maxDE, e);
    }
  }
  const block = (r) => {
    let worst = 0;
    const n = (2 * r + 1) ** 2;
    for (let y = r; y < h - r; y++) for (let x = r; x < w - r; x++) {
      let s = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) s += dE[(y + dy) * w + x + dx];
      if (s / n > worst) worst = s / n;
    }
    return worst;
  };
  const worstBlock = changed ? block(1) : 0;
  const worstBlock5 = changed ? block(2) : 0;
  des.sort((p, q) => p - q);
  const q = (t) => (des.length ? des[Math.min(des.length - 1, Math.floor(t * des.length))] : 0);
  return { width: w, height: h, pixels: w * h, changed, changedPct: +(100 * changed / (w * h)).toFixed(4), maxDelta, maxDE76: +maxDE.toFixed(2), dE76p50: +q(0.5).toFixed(2), dE76p999: +q(0.999).toFixed(2), worstBlockDE76: +worstBlock.toFixed(2), worstBlock5x5DE76: +worstBlock5.toFixed(2) };
}
if (process.argv[1] && process.argv[1].endsWith('frame-compare.mjs')) {
  const args = process.argv.slice(2);
  if (args[0] === '--pairs') {
    const dir = join(process.cwd(), 'qa/review');
    for (const n of readdirSync(dir).filter((n) => /^v166-diff-.*-baseline\.png$/.test(n)).sort()) {
      const rep = n.replace('-baseline.png', '-repeat.png');
      try { console.log(JSON.stringify({ pair: n.replace('-baseline.png', ''), ...compare(readFileSync(join(dir, n)), readFileSync(join(dir, rep))) })); }
      catch (e) { console.log(JSON.stringify({ pair: n, error: String(e.message) })); }
    }
  } else console.log(JSON.stringify(compare(readFileSync(args[0]), readFileSync(args[1]))));
}
