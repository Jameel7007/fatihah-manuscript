// Ink atlas pipeline (M3, §14/§17/§18) — from the FROZEN composition:
//   · atlasMTSDF: RGB = multi-channel sdf (edge-colored pseudo-distances,
//     corner-preserving), 64 px/em cells, A = 255. Distances are analytic against the
//     outline edges (lines + quadratics); signs from nonzero winding with per-glyph
//     auto-calibration of the RGB orientation convention.
//   · atlasProg: R = stroke-order field w (skeleton geodesic, §17 priors: tall stems
//     top-down, RTL entry otherwise, components chained right→left), G = TRUE SDF,
//     B = §14 emboss puff height (interior distance, clamped, 1.5-texel pre-blur),
//     A = 255. NO data lives in any alpha channel: browsers premultiply RGB by A on
//     PNG decode/upload, which crushes co-stored channels (learned the hard way).
//   · ink-instances: every composition glyph placed on the sheet with its atlas cell
//     and its §10 write window mapped from the §17 writing schedule (units → Δp per
//     āyah, 0.002 pen-lift at every internal line break, segments proportional).
//     Āyah markers ride along as analytic ring instances (pen draws the circle).
//   · gates: per-glyph reconstruction IoU vs the outline fill, skeleton sanity, and
//     the M3 RTL writing-order audit (10 clusters).
//
// Dev format is PNG (lossless); the §18 KTX2/UASTC packaging is a build-hardening
// step later — tracked, not forgotten.
//
// Run: node build/build-ink-atlas.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const comp = JSON.parse(readFileSync(join(root, 'public/text/composition.json'), 'utf8'));
if (comp.variant !== '7line') throw new Error(`active composition is ${comp.variant}, expected 7line`);

const EM = comp.em;
const PX_PER_EM = 64; // §18
const RANGE_PX = 6; // sdf half-range in cell px (encoded 0..1 over ±RANGE)
const PAD = 8; // cell padding, px
const HI = 4; // skeleton raster supersample
const ATLAS_W = 2048;
const PUFF_NORM_EM = 0.05; // interior distance that saturates the §14 puff channel
const upem = Math.round(EM / comp.lines[0].glyphs[0].scale);
const S = PX_PER_EM / upem; // font units → cell px

// §17 writing schedule constants — MUST mirror src/director/writing.ts WRITING
const W = { glyphUnit: 1.0, kashidaUnit: 0.35, markUnit: 0.65, markLag: 1.2, wordGap: 2.2, ringUnits: 1.5 };
// §10 per-āyah write windows (state 3)
const WINDOWS = {
  1: [0.32, 0.352],
  2: [0.356, 0.389],
  3: [0.393, 0.42],
  4: [0.424, 0.451],
  5: [0.455, 0.488],
  6: [0.492, 0.522],
  7: [0.526, 0.58],
};
const LINE_BREAK_GAP = 0.002; // pen lift at an internal line break, in p
const WET_DP = 0.045; // §20 M3 wet-trail

// ---- outline parsing --------------------------------------------------------------------
/** Parse an absolute M/L/Q/C/Z path (harfbuzz glyphToPath) into contours of edges.
 *  Cubics are flattened to short lines (they are rare in a TrueType source). */
import { parsePath, evalEdge, derivEdge, nearestT, edgeDistance, winding } from './outline-lib.mjs';
// (outline machinery extracted verbatim to outline-lib.mjs for the M4 bevel extruder —
//  the SS14/SS17 'identical flattened polylines' guarantee, made structural)

// ---- edge coloring (msdf) ---------------------------------------------------------------
const MAG = 0b101;
const YEL = 0b110;
const CYA = 0b011;
const WHITE = 0b111;

function colorContour(ct) {
  const n = ct.length;
  const corner = new Array(n).fill(false);
  let any = false;
  for (let i = 0; i < n; i++) {
    const prev = ct[(i + n - 1) % n];
    const d1 = derivEdge(prev, 1);
    const d2 = derivEdge(ct[i], 0);
    const l1 = Math.hypot(d1[0], d1[1]) || 1e-12;
    const l2 = Math.hypot(d2[0], d2[1]) || 1e-12;
    const dot = (d1[0] * d2[0] + d1[1] * d2[1]) / (l1 * l2);
    if (dot < Math.cos((25 * Math.PI) / 180)) {
      corner[i] = true;
      any = true;
    }
  }
  if (!any) {
    for (const e of ct) e.color = WHITE;
    return;
  }
  // rotate to start at a corner, split into runs, alternate MAG/YEL (any pair of the
  // three colors shares exactly one channel); avoid first==last at the wrap
  const startIdx = corner.findIndex(Boolean);
  const runs = [];
  let run = [];
  for (let k = 0; k < n; k++) {
    const i = (startIdx + k) % n;
    if (corner[i] && run.length) {
      runs.push(run);
      run = [];
    }
    run.push(ct[i]);
  }
  if (run.length) runs.push(run);
  const palette = [MAG, YEL, CYA];
  runs.forEach((r, ri) => {
    let col = palette[ri % 2]; // MAG/YEL alternation
    if (ri === runs.length - 1 && runs.length > 1 && col === runs[0][0].color) col = CYA;
    for (const e of r) e.color = col;
  });
}

// ---- per-glyph build --------------------------------------------------------------------
const JIT = 0.137713; // fixed jitter off integer path coordinates (winding degeneracies)

function buildGlyph(gid, pathD) {
  const contours = parsePath(pathD);
  const edges = contours.flat();
  if (!edges.length) return null;
  for (const ct of contours) colorContour(ct);

  // bbox in font units
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (const e of edges)
    for (const p of e.p) {
      bx0 = Math.min(bx0, p[0]);
      by0 = Math.min(by0, p[1]);
      bx1 = Math.max(bx1, p[0]);
      by1 = Math.max(by1, p[1]);
    }
  const cw = Math.ceil((bx1 - bx0) * S) + 2 * PAD;
  const ch = Math.ceil((by1 - by0) * S) + 2 * PAD;
  const fx = (i) => bx0 + (i + 0.5 - PAD) / S + JIT;
  const fy = (j) => by1 - (j + 0.5 - PAD) / S + JIT;

  // --- MTSDF ---
  const rgba = new Float32Array(cw * ch * 4);
  const enc = (d) => Math.max(0, Math.min(1, (d / RANGE_PX) * 0.5 + 0.5));
  let signVotes = 0;
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      const q = [fx(i), fy(j)];
      let dT = Infinity;
      const best = { [MAG & 0b100 ? 'r' : 'r']: null }; // placeholder for lints
      let bR = null;
      let bG = null;
      let bB = null;
      for (const e of edges) {
        const d = edgeDistance(e, q);
        if (d.trueD < dT) dT = d.trueD;
        const better = (prev) => !prev || d.trueD < prev.trueD - 1e-9 || (Math.abs(d.trueD - prev.trueD) < 1e-9 && d.ortho > prev.ortho);
        if (e.color & 0b100 && better(bR)) bR = d;
        if (e.color & 0b010 && better(bG)) bG = d;
        if (e.color & 0b001 && better(bB)) bB = d;
      }
      const inside = winding(contours, q) !== 0;
      const sT = inside ? 1 : -1;
      const k = (j * cw + i) * 4;
      const px = (d) => (d ? d.pseudo : -RANGE_PX) / S / (1 / S); // font units are cell-px/S; convert:
      // distances computed in font units — convert to cell px
      const toPx = (d) => d * S;
      rgba[k] = enc(toPx(bR ? bR.pseudo : -1e9));
      rgba[k + 1] = enc(toPx(bG ? bG.pseudo : -1e9));
      rgba[k + 2] = enc(toPx(bB ? bB.pseudo : -1e9));
      rgba[k + 3] = enc(toPx(sT * dT));
      void px;
      void best;
      // calibration vote: does the median sign agree with winding?
      const med = [rgba[k], rgba[k + 1], rgba[k + 2]].sort((a, b) => a - b)[1];
      if (Math.abs(toPx(dT)) > 1.5) signVotes += (med > 0.5) === inside ? 1 : -1;
    }
  }
  if (signVotes < 0) {
    // RGB orientation convention flipped for this outline — negate the pseudo channels
    for (let k = 0; k < rgba.length; k += 4) {
      rgba[k] = 1 - rgba[k];
      rgba[k + 1] = 1 - rgba[k + 1];
      rgba[k + 2] = 1 - rgba[k + 2];
    }
  }
  // error correction: where the median strays from the true SDF, fall back to true
  for (let k = 0; k < rgba.length; k += 4) {
    const med = [rgba[k], rgba[k + 1], rgba[k + 2]].sort((a, b) => a - b)[1];
    if (Math.abs(med - rgba[k + 3]) > 0.18) {
      rgba[k] = rgba[k + 3];
      rgba[k + 1] = rgba[k + 3];
      rgba[k + 2] = rgba[k + 3];
    }
  }

  // --- hi-res binary raster (skeleton + IoU reference) ---
  const hw = cw * HI;
  const hh = ch * HI;
  const hfx = (i) => bx0 + (i + 0.5 - PAD * HI) / (S * HI) + JIT;
  const hfy = (j) => by1 - (j + 0.5 - PAD * HI) / (S * HI) + JIT;
  const ink = new Uint8Array(hw * hh);
  for (let j = 0; j < hh; j++)
    for (let i = 0; i < hw; i++) if (winding(contours, [hfx(i), hfy(j)]) !== 0) ink[j * hw + i] = 1;

  // --- skeleton: Zhang–Suen thinning ---
  const sk = ink.slice();
  const at = (a, i, j) => (i < 0 || j < 0 || i >= hw || j >= hh ? 0 : a[j * hw + i]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      const del = [];
      for (let j = 0; j < hh; j++) {
        for (let i = 0; i < hw; i++) {
          if (!sk[j * hw + i]) continue;
          const p = [at(sk, i, j - 1), at(sk, i + 1, j - 1), at(sk, i + 1, j), at(sk, i + 1, j + 1), at(sk, i, j + 1), at(sk, i - 1, j + 1), at(sk, i - 1, j), at(sk, i - 1, j - 1)];
          const bsum = p.reduce((a, b) => a + b, 0);
          if (bsum < 2 || bsum > 6) continue;
          let trans = 0;
          for (let t = 0; t < 8; t++) if (!p[t] && p[(t + 1) % 8]) trans++;
          if (trans !== 1) continue;
          if (pass === 0) {
            if (p[0] * p[2] * p[4] !== 0) continue;
            if (p[2] * p[4] * p[6] !== 0) continue;
          } else {
            if (p[0] * p[2] * p[6] !== 0) continue;
            if (p[0] * p[4] * p[6] !== 0) continue;
          }
          del.push(j * hw + i);
        }
      }
      for (const d of del) sk[d] = 0;
      if (del.length) changed = true;
    }
  }

  // --- components, §17 start priors, geodesic w ---
  const compId = new Int32Array(hw * hh).fill(-1);
  const comps = [];
  for (let j = 0; j < hh; j++) {
    for (let i = 0; i < hw; i++) {
      if (!sk[j * hw + i] || compId[j * hw + i] >= 0) continue;
      const px = [];
      const stack = [[i, j]];
      compId[j * hw + i] = comps.length;
      while (stack.length) {
        const [x, y] = stack.pop();
        px.push([x, y]);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= hw || ny >= hh) continue;
            if (sk[ny * hw + nx] && compId[ny * hw + nx] < 0) {
              compId[ny * hw + nx] = comps.length;
              stack.push([nx, ny]);
            }
          }
      }
      comps.push({ px });
    }
  }
  // RTL: components ordered by rightmost extent, descending (atlas x grows leftward? no —
  // atlas i grows with font x, so RTL entry = LARGEST i first)
  comps.forEach((c) => {
    c.maxI = Math.max(...c.px.map((p) => p[0]));
  });
  comps.sort((a, b) => b.maxI - a.maxI);

  const aspect = (by1 - by0) / Math.max(1e-6, bx1 - bx0);
  const geo = new Float32Array(hw * hh).fill(-1);
  let total = 0;
  for (const c of comps) {
    const nb = (x, y) => {
      const out = [];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < hw && ny < hh && sk[ny * hw + nx]) out.push([nx, ny]);
        }
      return out;
    };
    const ends = c.px.filter(([x, y]) => nb(x, y).length === 1);
    let start;
    if (aspect > 2.2 && ends.length) {
      start = ends.reduce((a, b) => (b[1] < a[1] ? b : a)); // tall stem: topmost end
    } else if (ends.length) {
      start = ends.reduce((a, b) => (b[0] > a[0] ? b : a)); // RTL: rightmost end
    } else {
      start = c.px.reduce((a, b) => (b[1] < a[1] || (b[1] === a[1] && b[0] > a[0]) ? b : a)); // loop: top
    }
    // BFS geodesic from start (loops flood both arms — ccw prior noted as approximation)
    const dist = new Map();
    const qk = (x, y) => y * hw + x;
    dist.set(qk(...start), 0);
    const Q = [start];
    let far = 0;
    while (Q.length) {
      const [x, y] = Q.shift();
      const d0 = dist.get(qk(x, y));
      far = Math.max(far, d0);
      for (const [nx, ny] of nb(x, y)) {
        if (!dist.has(qk(nx, ny))) {
          dist.set(qk(nx, ny), d0 + Math.hypot(nx - x, ny - y));
          Q.push([nx, ny]);
        }
      }
    }
    c.len = Math.max(far, 1);
    c.dist = dist;
    total += c.len;
  }
  let cum = 0;
  for (const c of comps) {
    const span = c.len / total;
    for (const [x, y] of c.px) geo[y * hw + x] = cum + ((c.dist.get(y * hw + x) ?? 0) / c.len) * span;
    cum += c.len / total;
  }

  // --- propagate w outward (nearest skeleton px), track distance-to-skeleton ---
  const wField = new Float32Array(hw * hh).fill(-1);
  const dSk = new Float32Array(hw * hh).fill(1e9);
  {
    const Q = [];
    for (let j = 0; j < hh; j++)
      for (let i = 0; i < hw; i++)
        if (geo[j * hw + i] >= 0) {
          wField[j * hw + i] = geo[j * hw + i];
          dSk[j * hw + i] = 0;
          Q.push([i, j]);
        }
    let head = 0;
    while (head < Q.length) {
      const [x, y] = Q[head++];
      const d0 = dSk[y * hw + x];
      const w0 = wField[y * hw + x];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= hw || ny >= hh) continue;
          const nd = d0 + Math.hypot(dx, dy);
          if (nd < dSk[ny * hw + nx] - 1e-6) {
            dSk[ny * hw + nx] = nd;
            wField[ny * hw + nx] = w0;
            Q.push([nx, ny]);
          }
        }
    }
  }

  // --- prog cell (downsample HI×HI) + puff from true SDF ---
  const prog = new Float32Array(cw * ch * 4);
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      let wS = 0;
      let dS = 0;
      for (let sj = 0; sj < HI; sj++)
        for (let si = 0; si < HI; si++) {
          const hi = i * HI + si;
          const hj = j * HI + sj;
          wS += Math.max(0, wField[hj * hw + hi]);
          dS += Math.min(dSk[hj * hw + hi], HI * 8);
        }
      const k = (j * cw + i) * 4;
      prog[k] = wS / (HI * HI);
      prog[k + 1] = Math.max(0, Math.min(1, dS / (HI * HI) / (HI * 6)));
      const sdPx = (rgba[k + 3] - 0.5) * 2 * RANGE_PX; // true sdf, cell px
      const insideEm = Math.max(0, sdPx) / PX_PER_EM;
      prog[k + 3] = Math.max(0, Math.min(1, insideEm / PUFF_NORM_EM));
    }
  }
  // 1.5-texel pre-blur on the puff channel (§14), separable [1,4,6,4,1]
  const blur1 = (src, ch4, off) => {
    const tmp = new Float32Array(cw * ch);
    const ker = [1, 4, 6, 4, 1];
    for (let j = 0; j < ch; j++)
      for (let i = 0; i < cw; i++) {
        let s = 0;
        let wsum = 0;
        for (let t = -2; t <= 2; t++) {
          const ii = Math.max(0, Math.min(cw - 1, i + t));
          s += ker[t + 2] * src[(j * cw + ii) * 4 + off];
          wsum += ker[t + 2];
        }
        tmp[j * cw + i] = s / wsum;
      }
    for (let j = 0; j < ch; j++)
      for (let i = 0; i < cw; i++) {
        let s = 0;
        let wsum = 0;
        for (let t = -2; t <= 2; t++) {
          const jj = Math.max(0, Math.min(ch - 1, j + t));
          s += ker[t + 2] * tmp[jj * cw + i];
          wsum += ker[t + 2];
        }
        src[(j * cw + i) * 4 + off] = s / wsum;
      }
    void ch4;
  };
  blur1(prog, 4, 3);

  // --- IoU gate: mtsdf reconstruction vs winding fill at HI res ---
  let inter = 0;
  let uni = 0;
  for (let j = 0; j < hh; j++) {
    for (let i = 0; i < hw; i++) {
      // per-CHANNEL bilinear then median — exactly what the GPU sampler + shader do
      // (interpolating medians is the classic msdf mistake and mis-measures corners)
      const x = (i + 0.5) / HI - 0.5;
      const y = (j + 0.5) / HI - 0.5;
      const i0 = Math.max(0, Math.min(cw - 2, Math.floor(x)));
      const j0 = Math.max(0, Math.min(ch - 2, Math.floor(y)));
      const fxs = Math.max(0, Math.min(1, x - i0));
      const fys = Math.max(0, Math.min(1, y - j0));
      const chAt = (ii, jj, t) => rgba[(jj * cw + ii) * 4 + t];
      const bil = (t) =>
        chAt(i0, j0, t) * (1 - fxs) * (1 - fys) +
        chAt(i0 + 1, j0, t) * fxs * (1 - fys) +
        chAt(i0, j0 + 1, t) * (1 - fxs) * fys +
        chAt(i0 + 1, j0 + 1, t) * fxs * fys;
      const m = [bil(0), bil(1), bil(2)].sort((a, b) => a - b)[1];
      const rec = m > 0.5 ? 1 : 0;
      const ref = ink[j * hw + i];
      if (rec && ref) inter++;
      if (rec || ref) uni++;
    }
  }
  const iou = uni ? inter / uni : 1;

  return { gid, cw, ch, bx0, by0, bx1, by1, rgba, prog, iou, comps: comps.length, hasSkeleton: total > 1 };
}

// ---- run all glyphs ---------------------------------------------------------------------
const gidPaths = new Map();
for (const l of comp.lines) for (const g of l.glyphs) if (!gidPaths.has(g.gid)) gidPaths.set(g.gid, g.path);

// v1.5: the āyah marker is a DRAWN rosette outline (composition.marker) — it becomes an
// ordinary atlas cell + instances (kind 'marker'), replacing the M3 analytic rings. The
// synthetic gid sits far above the font's gid space.
const ROSETTE_GID = 100000;
if (comp.marker?.path) gidPaths.set(ROSETTE_GID, comp.marker.path);

console.log(`building ${gidPaths.size} glyph cells (64 px/em, range ±${RANGE_PX}px, pad ${PAD})…`);
const cells = [];
let worstIoU = { gid: -1, iou: 1 };
for (const [gid, d] of gidPaths) {
  const c = buildGlyph(gid, d);
  if (!c) throw new Error(`glyph ${gid}: empty outline`);
  if (!c.hasSkeleton) throw new Error(`glyph ${gid}: no skeleton`);
  cells.push(c);
  if (c.iou < worstIoU.iou) worstIoU = { gid, iou: c.iou };
}
const meanIoU = cells.reduce((a, c) => a + c.iou, 0) / cells.length;
console.log(`reconstruction IoU: mean ${meanIoU.toFixed(4)}, worst ${worstIoU.iou.toFixed(4)} (gid ${worstIoU.gid})`);
if (worstIoU.iou < 0.94) throw new Error('IoU gate failed — MTSDF reconstruction diverges from the outline');

// ---- shelf packing ----------------------------------------------------------------------
cells.sort((a, b) => b.ch - a.ch);
let shelfY = 0;
let shelfH = 0;
let curX = 0;
for (const c of cells) {
  if (curX + c.cw > ATLAS_W) {
    shelfY += shelfH;
    shelfH = 0;
    curX = 0;
  }
  c.ax = curX;
  c.ay = shelfY;
  curX += c.cw;
  shelfH = Math.max(shelfH, c.ch);
}
const ATLAS_H = 1 << Math.ceil(Math.log2(shelfY + shelfH));
if (ATLAS_H > 2048) throw new Error(`atlas overflow: ${shelfY + shelfH}px tall`);
console.log(`atlas ${ATLAS_W}×${ATLAS_H}, ${cells.length} cells, fill ${(((shelfY + shelfH) / ATLAS_H) * 100).toFixed(0)}%`);

const mtsdfPix = new Uint8Array(ATLAS_W * ATLAS_H * 4);
const progPix = new Uint8Array(ATLAS_W * ATLAS_H * 4);
for (let k = 3; k < mtsdfPix.length; k += 4) {
  mtsdfPix[k] = 255; // opaque everywhere — alpha must carry no data (premultiply)
  progPix[k] = 255;
}
for (const c of cells) {
  for (let j = 0; j < c.ch; j++)
    for (let i = 0; i < c.cw; i++) {
      const src = (j * c.cw + i) * 4;
      const dst = ((c.ay + j) * ATLAS_W + (c.ax + i)) * 4;
      // Alpha carries NO data in either PNG (=255): browsers premultiply RGB by A on
      // image decode/upload, which crushed the msdf median inside thin strokes when the
      // true SDF lived in mtsdf.A (bisected 2026-08-27). Layout: mtsdf = [msdf RGB, 255],
      // prog = [w, trueSDF, puff, 255].
      mtsdfPix[dst] = Math.round(c.rgba[src] * 255);
      mtsdfPix[dst + 1] = Math.round(c.rgba[src + 1] * 255);
      mtsdfPix[dst + 2] = Math.round(c.rgba[src + 2] * 255);
      mtsdfPix[dst + 3] = 255;
      progPix[dst] = Math.round(c.prog[src] * 255);
      progPix[dst + 1] = Math.round(c.rgba[src + 3] * 255); // true SDF
      progPix[dst + 2] = Math.round(c.prog[src + 3] * 255); // §14 puff
      progPix[dst + 3] = 255;
    }
}

// ---- PNG encode -------------------------------------------------------------------------
function pngEncode(pix, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let j = 0; j < h; j++) {
    raw[j * (w * 4 + 1)] = 0;
    Buffer.from(pix.buffer, pix.byteOffset + j * w * 4, w * 4).copy(raw, j * (w * 4 + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcTable = pngEncode.crcTable ?? (pngEncode.crcTable = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
      }
      return t;
    })());
    let crc = 0xffffffff;
    for (const b of td) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    const cb = Buffer.alloc(4);
    cb.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, td, cb]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA8
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const mtsdfPng = pngEncode(mtsdfPix, ATLAS_W, ATLAS_H);
const progPng = pngEncode(progPix, ATLAS_W, ATLAS_H);
writeFileSync(join(root, 'public/text/ink-mtsdf.png'), mtsdfPng);
writeFileSync(join(root, 'public/text/ink-prog.png'), progPng);

// ---- §10 window mapping (writing schedule → p) ------------------------------------------
const cellByGid = new Map(cells.map((c) => [c.gid, c]));
const allGlyphs = [];
for (const l of comp.lines) for (const g of l.glyphs) allGlyphs.push({ ...g, line: l.line });

// schedule per (āyah, line-segment); mirrors director/writing.ts semantics
function scheduleSegment(glyphs) {
  const sorted = [...glyphs].sort((a, b) => a.order - b.order);
  const items = new Map();
  let cursor = 0;
  let prev = '';
  let baseEnd = 0;
  let markCur = 0;
  let wordEnd = 0;
  for (const g of sorted) {
    const key = `${g.line}:${g.word}`;
    if (key !== prev) {
      cursor = prev === '' ? 0 : wordEnd + W.wordGap;
      prev = key;
      baseEnd = cursor;
      markCur = -1;
      wordEnd = cursor;
    }
    if (g.kind === 'base') {
      const u = g.kashida ? W.kashidaUnit : W.glyphUnit;
      items.set(g.order, { start: cursor, dur: u });
      cursor += u;
      baseEnd = cursor;
      wordEnd = Math.max(wordEnd, cursor);
    } else {
      if (markCur < 0) markCur = baseEnd + W.markLag;
      items.set(g.order, { start: markCur, dur: W.markUnit });
      markCur += W.markUnit;
      wordEnd = Math.max(wordEnd, markCur);
    }
  }
  return { items, span: wordEnd };
}

const instances = [];
const ringInstances = [];
for (let ay = 1; ay <= 7; ay++) {
  const [w0, w1] = WINDOWS[ay];
  const gl = allGlyphs.filter((g) => g.ayah === ay);
  const linesOf = [...new Set(gl.map((g) => g.line))].sort((a, b) => a - b);
  const segs = linesOf.map((ln) => {
    const sg = gl.filter((g) => g.line === ln);
    return { line: ln, glyphs: sg, sched: scheduleSegment(sg) };
  });
  // the āyah ring closes the final segment
  const ringSeg = segs[segs.length - 1];
  ringSeg.ringUnits = W.ringUnits;
  const totalUnits = segs.reduce((a, s) => a + s.sched.span + (s.ringUnits ?? 0), 0);
  const usable = w1 - w0 - (segs.length - 1) * LINE_BREAK_GAP;
  let p0 = w0;
  for (const s of segs) {
    const segUnits = s.sched.span + (s.ringUnits ?? 0);
    const segSpanP = (segUnits / totalUnits) * usable;
    const perUnit = segUnits > 0 ? segSpanP / segUnits : 0;
    for (const g of s.glyphs) {
      const it = s.sched.items.get(g.order);
      const cell = cellByGid.get(g.gid);
      // sheet rect = glyph bbox expanded to the padded atlas cell footprint (world)
      const padW = PAD / PX_PER_EM / (upem / EM) / (1 / upem); // PAD px → font units → world
      const padWorld = (PAD / S) * (EM / upem);
      const sx0 = g.x + cell.bx0 * (EM / upem) - padWorld;
      const sx1 = g.x + cell.bx1 * (EM / upem) + padWorld;
      // glyph y: baseline − fontY·s → world top uses by1
      const sy0 = g.y - cell.by1 * (EM / upem) - padWorld;
      const sy1 = g.y - cell.by0 * (EM / upem) + padWorld;
      void padW;
      instances.push({
        gid: g.gid,
        order: g.order,
        line: g.line,
        word: g.word,
        ayah: ay,
        kind: g.kind,
        kashida: !!g.kashida,
        sheet: [+sx0.toFixed(6), +sy0.toFixed(6), +sx1.toFixed(6), +sy1.toFixed(6)],
        atlas: [c2u(cell.ax, ATLAS_W), c2u(cell.ay, ATLAS_H), c2u(cell.ax + cell.cw, ATLAS_W), c2u(cell.ay + cell.ch, ATLAS_H)],
        start: +(p0 + it.start * perUnit).toFixed(5),
        dur: +Math.max(1e-4, it.dur * perUnit).toFixed(5),
      });
    }
    if (s.ringUnits) {
      const line = comp.lines[s.line];
      const mk = line.markers.find((m) => m.ayah === ay);
      if (mk && comp.marker?.path) {
        // v1.5 rosette marker — an ordinary instance in the old ring's timing slot
        const cell = cellByGid.get(ROSETTE_GID);
        const padWorld = (PAD / S) * (EM / upem);
        instances.push({
          gid: ROSETTE_GID,
          order: 100000 + ay, // synthetic, unique per (line, order) join
          line: s.line,
          word: -1,
          ayah: ay,
          kind: 'marker',
          kashida: false,
          sheet: [
            +(mk.x + cell.bx0 * (EM / upem) - padWorld).toFixed(6),
            +(mk.y - cell.by1 * (EM / upem) - padWorld).toFixed(6),
            +(mk.x + cell.bx1 * (EM / upem) + padWorld).toFixed(6),
            +(mk.y - cell.by0 * (EM / upem) + padWorld).toFixed(6),
          ],
          atlas: [c2u(cell.ax, ATLAS_W), c2u(cell.ay, ATLAS_H), c2u(cell.ax + cell.cw, ATLAS_W), c2u(cell.ay + cell.ch, ATLAS_H)],
          start: +(p0 + s.sched.span * perUnit).toFixed(5),
          dur: +(s.ringUnits * perUnit).toFixed(5),
        });
      } else if (mk) {
        ringInstances.push({
          ayah: ay,
          x: mk.x,
          y: mk.y,
          r: 0.1086 * EM,
          stroke: 0.0276 * EM,
          start: +(p0 + s.sched.span * perUnit).toFixed(5),
          dur: +(s.ringUnits * perUnit).toFixed(5),
        });
      }
    }
    p0 += segSpanP + LINE_BREAK_GAP;
  }
}
function c2u(px, size) {
  return +(px / size).toFixed(6);
}

// ---- M3 RTL writing-order audit (10 clusters) -------------------------------------------
const audit = [];
{
  const words = new Map();
  for (const g of allGlyphs) {
    const key = `${g.line}:${g.word}`;
    if (!words.has(key)) words.set(key, []);
    words.get(key).push(g);
  }
  for (const [key, gl] of words) {
    if (audit.length >= 10) break;
    const bases = gl.filter((g) => g.kind === 'base').sort((a, b) => a.order - b.order);
    if (bases.length < 2) continue;
    let rtl = true;
    for (let i = 1; i < bases.length; i++) if (bases[i].x > bases[i - 1].x + 1e-6) rtl = false;
    const marksAfter = Math.min(...gl.filter((g) => g.kind === 'mark').map((g) => g.order), Infinity) > Math.max(...bases.map((g) => g.order));
    audit.push({ word: key, bases: bases.length, rtlOrder: rtl, marksAfterBases: marksAfter });
  }
}
const rtlPass = audit.every((a) => a.rtlOrder && a.marksAfterBases);
console.log(`RTL audit (10 clusters): ${rtlPass ? 'PASS' : 'FAIL'}`);
for (const a of audit) console.log(`  ${a.word}: ${a.bases} bases, RTL ${a.rtlOrder ? 'ok' : 'BAD'}, marks-after ${a.marksAfterBases ? 'ok' : 'BAD'}`);
if (!rtlPass) throw new Error('RTL writing-order audit failed');

// ---- outputs ----------------------------------------------------------------------------
const sha = (b) => createHash('sha256').update(b).digest('hex');
const out = {
  source: 'built from the FROZEN 7-line composition — consumers verify checksums',
  pxPerEm: PX_PER_EM,
  rangePx: RANGE_PX,
  pad: PAD,
  atlas: [ATLAS_W, ATLAS_H],
  em: EM,
  wetDp: WET_DP,
  windows: WINDOWS,
  lineBreakGap: LINE_BREAK_GAP,
  checksums: {
    compositionSvg: comp.checksums.svg,
    mtsdfPng: sha(mtsdfPng),
    progPng: sha(progPng),
  },
  qa: { meanIoU: +meanIoU.toFixed(4), worstIoU: { gid: worstIoU.gid, iou: +worstIoU.iou.toFixed(4) }, rtlAudit: rtlPass },
  instances,
  rings: ringInstances,
};
writeFileSync(join(root, 'public/text/ink-instances.json'), JSON.stringify(out, null, 1));
writeFileSync(join(root, 'build/ink-audit.json'), JSON.stringify({ audit, rtlPass, meanIoU, worstIoU }, null, 1));

console.log(`\nink-mtsdf.png  ${(mtsdfPng.length / 1024).toFixed(0)} KB  ${out.checksums.mtsdfPng.slice(0, 12)}`);
console.log(`ink-prog.png   ${(progPng.length / 1024).toFixed(0)} KB  ${out.checksums.progPng.slice(0, 12)}`);
console.log(`instances ${instances.length} glyphs + ${ringInstances.length} rings`);
const a1 = instances.filter((i) => i.ayah === 1);
console.log(`Ā1 window check: first start ${Math.min(...a1.map((i) => i.start))}, last end ${Math.max(...a1.map((i) => i.start + i.dur)).toFixed(4)} (window 0.320–0.352)`);
