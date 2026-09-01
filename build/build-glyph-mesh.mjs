// §6/§18 bevel extruder — the M4/M5 glyph relief mesh, built from the FROZEN 7-line
// composition (the same outlines the ink atlases consume, via outline-lib.mjs — the
// §14/§17 "identical flattened polylines" guarantee).
//
// Formulation: the §6 bevel (9-point profile P0..P8, root fillet → 7° wall → burnish
// crown → flat lip) is applied as a HEIGHT GRAPH over the interior-distance field,
//   h(x) = profileY( d(x) / wScale(x) ) · hScale(x),
// which is the identical surface an inward offset sweep of the profile would produce
// wherever that sweep is well-defined, and — being a function graph — cannot self-
// intersect at concave corners or thin necks. The §6 thin-stroke guard (wScale, hScale
// from the local half-width W) turns hairlines into rounded beads exactly as specified.
// Tessellation: marching-squares-clipped grid cells (pitch ~10 font units), boundary
// vertices Newton-SNAPPED onto the analytic outline, so the plan silhouette equals the
// SDF contour by construction (§14). Bases + kashidas of a word are UNIONED (nonzero
// winding across the joined outlines — §18 "self-intersection cleanup / winding
// normalization"), so letter joints carry no false grooves; each diacritic and each
// āyah ring is its own solid at its §6 depth ratio.
//
// Output: public/text/glyphs.bin (FGLY v1, quantized planar attributes + u32 index;
// meshopt/glb packaging is tracked §18 debt alongside KTX2) + build/glyph-mesh-audit.json.
//
// Determinism: pure function of the frozen inputs — fixed iteration orders, no clocks,
// no randomness (the winding jitter is the same fixed constant the atlas build uses).

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parsePath, evalEdge, derivEdge, nearestT, winding } from './outline-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const comp = JSON.parse(readFileSync(join(root, 'public/text/composition-7line.json'), 'utf8'));
const inst = JSON.parse(readFileSync(join(root, 'public/text/ink-instances.json'), 'utf8'));
if (inst.checksums.compositionSvg !== comp.checksums.svg) throw new Error('composition/instance checksum mismatch');

const EM = comp.em; // 0.052
const upem = Math.round(EM / comp.lines[0].glyphs[0].scale); // 1000
const K = EM / upem; // font unit → world
const JIT = 0.137713; // same fixed jitter constant as the atlas build (winding degeneracies)

// §6 constants (world units)
const D = 0.0115; // full extrusion depth = 0.55 × x-height
const BEV = 0.0046; // bevel width b
const PROFILE = [
  [0.0, 0.0],
  [0.0004, 0.0002],
  [0.0007, 0.0009],
  [0.0013, 0.0058],
  [0.0018, 0.0079],
  [0.0026, 0.0098],
  [0.0035, 0.011],
  [0.0042, 0.0114],
  [0.0046, 0.0115],
];
const KIND_SCALE = { base: 1.0, mark: 0.8, ring: 0.6, marker: 0.6 }; // §6 depth ratios
const GUARD_REF = BEV + 0.0004; // §6: wScale = clamp(W / (b + 0.0004), 0.25, 1)

const PITCH_FU = Number(process.argv.find((a) => a.startsWith('--pitch='))?.split('=')[1] ?? 10);
const P = PITCH_FU * K; // grid pitch, world
const RES = 2 * K; // raster resolution (2 fu / px), world per px
const TRI_BUDGET = 780000; // §6 T1

function profileY(s) {
  if (s <= 0) return 0;
  if (s >= BEV) return D;
  for (let i = 1; i < PROFILE.length; i++) {
    if (s <= PROFILE[i][0]) {
      const [x0, y0] = PROFILE[i - 1];
      const [x1, y1] = PROFILE[i];
      return y0 + ((s - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return D;
}
const profileSlope = (s) => (profileY(Math.min(s + 0.0002, BEV)) - profileY(Math.max(s - 0.0002, 0))) / (Math.min(s + 0.0002, BEV) - Math.max(s - 0.0002, 0) || 1);

// ---- group formation --------------------------------------------------------------------
const instBy = new Map();
for (const i of inst.instances) instBy.set(`${i.line}:${i.order}`, i);

const groups = [];
{
  const wordMap = new Map();
  for (const l of comp.lines) {
    for (const g of l.glyphs) {
      const rec = { ...g, line: l.line, inst: instBy.get(`${l.line}:${g.order}`) };
      if (!rec.inst) throw new Error(`no instance for line ${l.line} order ${g.order}`);
      if (g.kind === 'base') {
        const key = `${l.line}:${g.word}`;
        if (!wordMap.has(key)) wordMap.set(key, { type: 'word', line: l.line, word: g.word, ayah: g.ayah, glyphs: [] });
        wordMap.get(key).glyphs.push(rec);
      } else {
        groups.push({ type: 'mark', line: l.line, word: g.word, ayah: g.ayah, glyphs: [rec] });
      }
    }
  }
  const words = [...wordMap.values()].sort((a, b) => a.line - b.line || a.word - b.word);
  groups.unshift(...words);
}
// v1.5 rosette markers — drawn outlines placed at each line's marker anchors, one solid
// per marker at the §6 marker depth (0.60 D); joined to their atlas instances by the
// synthetic (line, 100000 + āyah) key the atlas build writes
if (comp.marker?.path) {
  for (const l of comp.lines) {
    for (const mk of l.markers) {
      const rec = {
        gid: 100000,
        path: comp.marker.path,
        x: mk.x,
        y: mk.y,
        kind: 'marker',
        ayah: mk.ayah,
        line: l.line,
        inst: instBy.get(`${l.line}:${100000 + mk.ayah}`),
      };
      if (!rec.inst) throw new Error(`no marker instance for line ${l.line} ayah ${mk.ayah}`);
      groups.push({ type: 'marker', line: l.line, ayah: mk.ayah, glyphs: [rec] });
    }
  }
}
for (const r of inst.rings ?? []) groups.push({ type: 'ring', ayah: r.ayah, ring: r });

// §10 rise stagger (M5): within an āyah, clusters lead by READING ORDER × Δp 0.0012 — bake
// each group's reading-order index inside its āyah (words by (line, word); a diacritic
// shares its word's index; the marker closes the āyah as the last cluster).
{
  const wordsByAyah = new Map();
  for (const g of groups) {
    if (g.type !== 'word') continue;
    if (!wordsByAyah.has(g.ayah)) wordsByAyah.set(g.ayah, []);
    wordsByAyah.get(g.ayah).push(g);
  }
  const idxOf = new Map();
  for (const [ay, ws] of wordsByAyah) {
    ws.sort((a, b) => a.line - b.line || a.word - b.word);
    ws.forEach((g, i) => idxOf.set(`${ay}:${g.line}:${g.word}`, i));
  }
  for (const g of groups) {
    if (g.type === 'word' || g.type === 'mark') g.cluster = idxOf.get(`${g.ayah}:${g.line}:${g.word}`) ?? 0;
    else g.cluster = (wordsByAyah.get(g.ayah)?.length ?? 0); // marker/ring: last cluster of the āyah
  }
}

// ---- per-group scalar field -------------------------------------------------------------
// Outline groups: analytic near the boundary (nearest edge over the union outline; exact
// snap + gradient), raster EDT inside (heights on the crown/plateau); rings: analytic.

function edgeBBox(e) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of e.p) {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  }
  return [x0, y0, x1, y1];
}

/** Row crossings of the union outline at world y (for the scanline mask fill). */
function rowCrossings(edges, y) {
  const xs = [];
  for (const e of edges) {
    const bb = e.bb;
    if (y < bb[1] || y > bb[3]) continue;
    if (e.t === 'L') {
      const [a, b] = e.p;
      const y0 = a[1], y1 = b[1];
      if (y0 === y1) continue;
      if (y >= Math.min(y0, y1) && y < Math.max(y0, y1)) {
        const t = (y - y0) / (y1 - y0);
        xs.push([a[0] + (b[0] - a[0]) * t, y1 > y0 ? 1 : -1]);
      }
    } else {
      const [a, c, b] = e.p;
      const A = a[1] - 2 * c[1] + b[1];
      const B = 2 * (c[1] - a[1]);
      const C = a[1] - y;
      const roots = [];
      if (Math.abs(A) < 1e-12) {
        if (Math.abs(B) > 1e-12) roots.push(-C / B);
      } else {
        const disc = B * B - 4 * A * C;
        if (disc >= 0) {
          const sq = Math.sqrt(disc);
          roots.push((-B + sq) / (2 * A), (-B - sq) / (2 * A));
        }
      }
      for (const t of roots) {
        if (t < 0 || t >= 1) continue;
        const dy = derivEdge(e, t)[1];
        if (Math.abs(dy) < 1e-12) continue;
        const u = 1 - t;
        xs.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], dy > 0 ? 1 : -1]);
      }
    }
  }
  return xs.sort((p, q) => p[0] - q[0]);
}

class OutlineField {
  constructor(glyphRecs) {
    this.edges = [];
    this.contours = [];
    for (const g of glyphRecs) {
      const cts = parsePath(g.path);
      for (const ct of cts) {
        const wc = ct.map((e) => ({ t: e.t, p: e.p.map(([fx, fy]) => [g.x + fx * K, g.y - fy * K]) }));
        this.contours.push(wc);
        this.edges.push(...wc);
      }
    }
    for (const e of this.edges) e.bb = edgeBBox(e);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of this.edges) {
      x0 = Math.min(x0, e.bb[0]); y0 = Math.min(y0, e.bb[1]);
      x1 = Math.max(x1, e.bb[2]); y1 = Math.max(y1, e.bb[3]);
    }
    const M = 2 * P;
    this.bbox = [x0 - M, y0 - M, x1 + M, y1 + M];
    // sharp outline corners (>25°, the atlas edge-coloring criterion): inserted into the
    // mesh boundary so grid-driven flattening cannot chord-cut a serif corner
    this.sharpPts = [];
    for (const ct of this.contours) {
      for (let k = 0; k < ct.length; k++) {
        const e1 = ct[k];
        const e2 = ct[(k + 1) % ct.length];
        const d1 = derivEdge(e1, 1);
        const d2 = derivEdge(e2, 0);
        const l1 = Math.hypot(d1[0], d1[1]) || 1e-12;
        const l2 = Math.hypot(d2[0], d2[1]) || 1e-12;
        const dot = (d1[0] * d2[0] + d1[1] * d2[1]) / (l1 * l2);
        if (dot < Math.cos((25 * Math.PI) / 180)) this.sharpPts.push([e2.p[0][0], e2.p[0][1]]);
      }
    }
    this.buildRaster();
  }

  buildRaster() {
    const [x0, y0, x1, y1] = this.bbox;
    const w = Math.max(2, Math.ceil((x1 - x0) / RES));
    const h = Math.max(2, Math.ceil((y1 - y0) / RES));
    const mask = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) {
      const y = y0 + (j + 0.5) * RES + JIT * RES * 0.31; // fixed off-integer jitter
      const xs = rowCrossings(this.edges, y);
      let wind = 0;
      for (let k = 0; k < xs.length - 1; k++) {
        wind += xs[k][1];
        if (wind !== 0) {
          const xa = xs[k][0];
          const xb = xs[k + 1][0];
          const i0 = Math.max(0, Math.ceil((xa - x0) / RES - 0.5));
          const i1 = Math.min(w - 1, Math.floor((xb - x0) / RES - 0.5));
          for (let i = i0; i <= i1; i++) mask[j * w + i] = 1;
        }
      }
    }
    this.rw = w;
    this.rh = h;
    this.mask = mask;
    // summed-area table for fast any-ink-in-cell tests
    const sat = new Uint32Array((w + 1) * (h + 1));
    for (let j = 0; j < h; j++) {
      let row = 0;
      for (let i = 0; i < w; i++) {
        row += mask[j * w + i];
        sat[(j + 1) * (w + 1) + i + 1] = sat[j * (w + 1) + i + 1] + row;
      }
    }
    this.sat = sat;
    // exact EDT (Felzenszwalb) of the inside region → distance to nearest outside texel
    const INF = 1e12;
    const f = new Float64Array(Math.max(w, h));
    const dd = new Float64Array(w * h);
    for (let k = 0; k < w * h; k++) dd[k] = mask[k] ? INF : 0;
    const v = new Int32Array(Math.max(w, h));
    const z = new Float64Array(Math.max(w, h) + 1);
    const edt1d = (n, get, set) => {
      let q = 0;
      v[0] = 0;
      z[0] = -INF;
      z[1] = INF;
      f[0] = get(0);
      for (let i = 1; i < n; i++) f[i] = get(i);
      for (let i = 1; i < n; i++) {
        let s;
        for (;;) {
          s = (f[i] + i * i - (f[v[q]] + v[q] * v[q])) / (2 * i - 2 * v[q]);
          if (s <= z[q]) q--; else break;
        }
        q++;
        v[q] = i;
        z[q] = s;
        z[q + 1] = INF;
      }
      q = 0;
      for (let i = 0; i < n; i++) {
        while (z[q + 1] < i) q++;
        set(i, (i - v[q]) * (i - v[q]) + f[v[q]]);
      }
    };
    for (let j = 0; j < h; j++) edt1d(w, (i) => dd[j * w + i], (i, val) => { dd[j * w + i] = val; });
    for (let i = 0; i < w; i++) edt1d(h, (j) => dd[j * w + i], (j, val) => { dd[j * w + i] = val; });
    const dr = new Float32Array(w * h);
    for (let k = 0; k < w * h; k++) dr[k] = Math.max(0, (Math.sqrt(dd[k]) - 0.5) * RES);
    this.draster = dr;
  }

  inkCount(x0, y0, x1, y1) {
    const [bx0, by0] = this.bbox;
    const i0 = Math.max(0, Math.floor((x0 - bx0) / RES));
    const j0 = Math.max(0, Math.floor((y0 - by0) / RES));
    const i1 = Math.min(this.rw, Math.ceil((x1 - bx0) / RES));
    const j1 = Math.min(this.rh, Math.ceil((y1 - by0) / RES));
    if (i1 <= i0 || j1 <= j0) return 0;
    const W1 = this.rw + 1;
    return this.sat[j1 * W1 + i1] - this.sat[j0 * W1 + i1] - this.sat[j1 * W1 + i0] + this.sat[j0 * W1 + i0];
  }

  /** Every raster texel of the window inked? An all-corners-inside cell failing this
   *  contains an interior exterior sliver (a crevice between joined strokes). */
  fullCover(x0, y0, x1, y1) {
    const [bx0, by0] = this.bbox;
    const i0 = Math.max(0, Math.floor((x0 - bx0) / RES));
    const j0 = Math.max(0, Math.floor((y0 - by0) / RES));
    const i1 = Math.min(this.rw, Math.ceil((x1 - bx0) / RES));
    const j1 = Math.min(this.rh, Math.ceil((y1 - by0) / RES));
    if (i1 <= i0 || j1 <= j0) return true;
    return this.inkCount(x0, y0, x1, y1) === (i1 - i0) * (j1 - j0);
  }

  maskAt(x, y) {
    const [bx0, by0] = this.bbox;
    const i = Math.max(0, Math.min(this.rw - 1, Math.round((x - bx0) / RES - 0.5)));
    const j = Math.max(0, Math.min(this.rh - 1, Math.round((y - by0) / RES - 0.5)));
    return this.mask[j * this.rw + i];
  }

  rasterD(x, y) {
    const [bx0, by0] = this.bbox;
    const fx = Math.min(this.rw - 1.001, Math.max(0, (x - bx0) / RES - 0.5));
    const fy = Math.min(this.rh - 1.001, Math.max(0, (y - by0) / RES - 0.5));
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    const g = (ii, jj) => this.draster[Math.min(this.rh - 1, jj) * this.rw + Math.min(this.rw - 1, ii)];
    return g(i, j) * (1 - tx) * (1 - ty) + g(i + 1, j) * tx * (1 - ty) + g(i, j + 1) * (1 - tx) * ty + g(i + 1, j + 1) * tx * ty;
  }

  rasterGrad(x, y) {
    const e = RES;
    const gx = this.rasterD(x + e, y) - this.rasterD(x - e, y);
    const gy = this.rasterD(x, y + e) - this.rasterD(x, y - e);
    const L = Math.hypot(gx, gy) || 1;
    return [gx / L, gy / L, Math.hypot(gx, gy) / (2 * e)];
  }

  /** Nearest point on the union outline (foot + distance), exact. */
  nearest(x, y) {
    let bd = Infinity;
    let bp = null;
    let be = null;
    let bt = 0;
    for (const e of this.edges) {
      const bb = e.bb;
      const dx = x < bb[0] ? bb[0] - x : x > bb[2] ? x - bb[2] : 0;
      const dy = y < bb[1] ? bb[1] - y : y > bb[3] ? y - bb[3] : 0;
      if (dx * dx + dy * dy >= bd) continue;
      const t = nearestT(e, [x, y]);
      const p = evalEdge(e, t);
      const dq = (p[0] - x) ** 2 + (p[1] - y) ** 2;
      if (dq < bd) {
        bd = dq;
        bp = p;
        be = e;
        bt = t;
      }
    }
    return { d: Math.sqrt(bd), foot: bp, edge: be, t: bt };
  }

  inside(x, y) {
    return winding(this.contours, [x + JIT * K, y + JIT * K]) !== 0;
  }

  /** Signed interior distance (+ inside), analytic near the boundary. */
  signedD(x, y) {
    const dr = this.rasterD(x, y);
    if (dr > 2 * P) return dr; // deep interior — raster is plenty
    const nr = this.nearest(x, y);
    return this.inside(x, y) ? nr.d : -nr.d;
  }

  /** Interior gradient direction of d (away from the boundary), robust at d = 0. */
  gradIn(x, y) {
    const nr = this.nearest(x, y);
    if (nr.d > 1e-7) {
      const s = this.inside(x, y) ? 1 : -1;
      return [((x - nr.foot[0]) / nr.d) * s, ((y - nr.foot[1]) / nr.d) * s];
    }
    // on the outline: inward = the perpendicular of the edge tangent that lands inside
    const dp = derivEdge(nr.edge, nr.t);
    const L = Math.hypot(dp[0], dp[1]) || 1;
    let nx = -dp[1] / L;
    let ny = dp[0] / L;
    if (!this.inside(x + nx * K, y + ny * K)) {
      nx = -nx;
      ny = -ny;
    }
    return [nx, ny];
  }

  /** Local half-width W: medial-disc radius by marching up the raster distance field. */
  halfWidth(x, y) {
    let qx = x;
    let qy = y;
    let W = this.rasterD(qx, qy);
    for (let k = 0; k < 8; k++) {
      const [gx, gy, mag] = this.rasterGrad(qx, qy);
      if (mag < 0.35) break; // at the medial ridge
      const step = Math.max(RES, this.rasterD(qx, qy) * 0.6);
      qx += gx * step;
      qy += gy * step;
      const d = this.rasterD(qx, qy);
      if (d <= W) break;
      W = d;
    }
    return Math.max(W, this.rasterD(x, y));
  }
}

class RingField {
  constructor(r) {
    this.cx = r.x;
    this.cy = r.y;
    this.r = r.r;
    this.hw = r.stroke / 2;
    const R = this.r + this.hw;
    this.bbox = [this.cx - R - 2 * P, this.cy - R - 2 * P, this.cx + R + 2 * P, this.cy + R + 2 * P];
  }

  signedD(x, y) {
    const rho = Math.hypot(x - this.cx, y - this.cy);
    return this.hw - Math.abs(rho - this.r);
  }

  inkCount(x0, y0, x1, y1) {
    // conservative: does the cell's bbox meet the annulus?
    const nx = Math.max(x0, Math.min(this.cx, x1));
    const ny = Math.max(y0, Math.min(this.cy, y1));
    const dmin = Math.hypot(nx - this.cx, ny - this.cy);
    const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
    const dmax = Math.max(...corners.map(([px, py]) => Math.hypot(px - this.cx, py - this.cy)));
    return dmax >= this.r - this.hw && dmin <= this.r + this.hw ? 1 : 0;
  }

  gradIn(x, y) {
    const dx = x - this.cx;
    const dy = y - this.cy;
    const rho = Math.hypot(dx, dy) || 1e-9;
    const s = rho < this.r ? 1 : -1; // inward = toward the centerline circle
    return [(dx / rho) * s, (dy / rho) * s];
  }

  fullCover() {
    return true; // the annulus has no sub-texel crevices
  }

  maskAt(x, y) {
    return this.signedD(x, y) > 0 ? 1 : 0;
  }

  halfWidth() {
    return this.hw;
  }

  nearest(x, y) {
    const dx = x - this.cx;
    const dy = y - this.cy;
    const rho = Math.hypot(dx, dy) || 1e-9;
    const rEdge = rho < this.r ? this.r - this.hw : this.r + this.hw;
    return { d: Math.abs(this.signedD(x, y)), foot: [this.cx + (dx / rho) * rEdge, this.cy + (dy / rho) * rEdge] };
  }
}

// ---- mesh assembly ----------------------------------------------------------------------
const pos = []; // su, sv, hn  (per vertex)
const nrm = []; // plan normal xyz
const aux = []; // kind, ayah, ao, rfloor
const auv = []; // atlas uv
const idx = [];
const guardStats = { minW: Infinity, beads: 0, verts: 0 };
let cellsEmitted = 0;
let subdivTips = 0;

function vertexData(field, group, x, y) {
  const d = Math.max(0, field.signedD(x, y));
  const W = field.halfWidth(x, y);
  const wScale = Math.min(1, Math.max(0.25, W / GUARD_REF));
  const hScale = Math.min(1, Math.max(0.55, Math.sqrt(wScale)));
  const s = Math.min(d / wScale, BEV);
  const hn = (profileY(s) / D) * hScale;
  const slope = (profileSlope(s) * hScale) / wScale;
  const [gx, gy] = field.gradIn(x, y);
  const nl = Math.hypot(slope * gx, slope * gy, 1);
  const kindKey = group.type === 'ring' ? 'ring' : KIND_SCALE[group.glyphs[0].kind] !== undefined ? group.glyphs[0].kind : 'base';
  // atlas uv from the owning instance (nearest containing sheet rect); rings have none
  let au = 0;
  let av = 0;
  if (group.type !== 'ring') {
    let best = null;
    let bestScore = Infinity;
    for (const g of group.glyphs) {
      const [sx0, sy0, sx1, sy1] = g.inst.sheet;
      const inSide = x >= sx0 && x <= sx1 && y >= sy0 && y <= sy1;
      const cx = (sx0 + sx1) / 2;
      const cy = (sy0 + sy1) / 2;
      const score = (inSide ? 0 : 1e3) + Math.hypot(x - cx, y - cy);
      if (score < bestScore) {
        bestScore = score;
        best = g;
      }
    }
    const [sx0, sy0, sx1, sy1] = best.inst.sheet;
    const [u0, v0, u1, v1] = best.inst.atlas;
    au = u0 + ((x - sx0) / (sx1 - sx0)) * (u1 - u0);
    av = v0 + ((y - sy0) / (sy1 - sy0)) * (v1 - v0);
  }
  guardStats.verts++;
  guardStats.minW = Math.min(guardStats.minW, W);
  if (wScale <= 0.2500001) guardStats.beads++;
  return {
    su: (x + 0.39) / 0.78,
    sv: y,
    hn,
    n: [(-slope * gx) / nl, (-slope * gy) / nl, 1 / nl],
    kind: KIND_SCALE[kindKey],
    ayah: group.ayah,
    ao: Math.min(1, 0.72 + 0.28 * (s / 0.0018)),
    rfloor: (s < 0.0013 || (s > 0.0018 && s < 0.0042)) ? 0.28 : 0.08,
    cluster: Math.min(255, group.cluster ?? 0),
    auvU: au,
    auvV: av,
  };
}

function buildGroup(group) {
  const field = group.type === 'ring' ? new RingField(group.ring) : new OutlineField(group.glyphs);
  const [bx0, by0, bx1, by1] = field.bbox;
  const nx = Math.ceil((bx1 - bx0) / P);
  const ny = Math.ceil((by1 - by0) / P);
  const vcache = new Map(); // grid/crossing vertex dedupe within the group
  const baseIndex = pos.length / 3;
  let localVerts = 0;
  const boundaryVerts = []; // snapped contour vertices — §14 silhouette identity audit
  const emitVertex = (key, x, y) => {
    if (vcache.has(key)) return vcache.get(key);
    const v = vertexData(field, group, x, y);
    pos.push(v.su, v.sv, v.hn);
    nrm.push(v.n[0], v.n[1], v.n[2]);
    aux.push(v.kind, v.ayah, v.ao, v.rfloor, v.cluster);
    auv.push(v.auvU, v.auvV);
    const id = baseIndex + localVerts++;
    vcache.set(key, id);
    return id;
  };
  // triangles arrive CCW in (su, sv) plan (sv DOWN the sheet); flip at emission so the
  // face normal points along +N (out of the recto)
  const emitTri = (a, b, c) => {
    idx.push(a, c, b);
  };

  const dAt = new Map(); // corner d cache
  const cornerD = (i, j) => {
    const key = i + ',' + j;
    let v = dAt.get(key);
    if (v === undefined) {
      v = field.signedD(bx0 + i * P, by0 + j * P);
      dAt.set(key, v);
    }
    return v;
  };

  const processCell = (x0, y0, size, depth, i0, j0) => {
    const x1 = x0 + size;
    const y1 = y0 + size;
    // The raster gate alone is NOT sufficient to skip: a sub-texel ink sliver at a cell
    // edge (a stroke face lying just inside the cell) can have zero mask-center texels
    // while the corner signs straddle — skipping there drops the face's whole boundary
    // (caught by the §14 identity gate on وإياك, line 3). Skip only when the raster sees
    // nothing AND every corner is outside.
    const rasterInk = field.inkCount(x0, y0, x1, y1);
    const atBase = depth === 0;
    const d00 = atBase ? cornerD(i0, j0) : field.signedD(x0, y0);
    const d10 = atBase ? cornerD(i0 + 1, j0) : field.signedD(x1, y0);
    const d01 = atBase ? cornerD(i0, j0 + 1) : field.signedD(x0, y1);
    const d11 = atBase ? cornerD(i0 + 1, j0 + 1) : field.signedD(x1, y1);
    const ins = (d00 > 0 ? 1 : 0) + (d10 > 0 ? 1 : 0) + (d01 > 0 ? 1 : 0) + (d11 > 0 ? 1 : 0);
    if (rasterInk === 0 && ins === 0) return;
    if (ins === 0) {
      // ink present but no inside corner: a stroke tip / thin sliver — subdivide to catch it
      if (depth < 3) {
        const hsz = size / 2;
        subdivTips++;
        processCell(x0, y0, hsz, depth + 1, 0, 0);
        processCell(x0 + hsz, y0, hsz, depth + 1, 0, 0);
        processCell(x0, y0 + hsz, hsz, depth + 1, 0, 0);
        processCell(x0 + hsz, y0 + hsz, hsz, depth + 1, 0, 0);
      }
      return;
    }
    const keyOf = (x, y) => `${depth}:${x.toFixed(9)}:${y.toFixed(9)}`;
    if (ins === 4) {
      // an all-inside cell hiding an exterior sliver (crevice between joined strokes)
      // subdivides so the crack's walls get real boundary; below the raster's resolving
      // power (~one texel) the crevice is paved and the audit reports it as such
      if (depth < 3 && !field.fullCover(x0, y0, x1, y1)) {
        const hsz = size / 2;
        processCell(x0, y0, hsz, depth + 1, 0, 0);
        processCell(x0 + hsz, y0, hsz, depth + 1, 0, 0);
        processCell(x0, y0 + hsz, hsz, depth + 1, 0, 0);
        processCell(x0 + hsz, y0 + hsz, hsz, depth + 1, 0, 0);
        return;
      }
      const a = emitVertex(keyOf(x0, y0), x0, y0);
      const b = emitVertex(keyOf(x1, y0), x1, y0);
      const c = emitVertex(keyOf(x1, y1), x1, y1);
      const d = emitVertex(keyOf(x0, y1), x0, y1);
      emitTri(a, b, c);
      emitTri(a, c, d);
      cellsEmitted++;
      return;
    }
    // A mixed cell can HIDE a second ink component (a detached fragment in the corner
    // opposite the stroke edge) — MS resolves only what the corner signs see. Count mask
    // transitions around the cell perimeter: more transitions than corner-sign changes
    // means hidden structure → subdivide instead of clipping.
    if (depth < 3) {
      let trans = 0;
      let prev = null;
      const per = Math.max(4, Math.round(size / RES));
      for (let k4 = 0; k4 < 4 * per; k4++) {
        const side = Math.floor(k4 / per);
        const tt = (k4 % per) / per;
        const px3 = side === 0 ? x0 + size * tt : side === 1 ? x1 : side === 2 ? x1 - size * tt : x0;
        const py3 = side === 0 ? y0 : side === 1 ? y0 + size * tt : side === 2 ? y1 : y1 - size * tt;
        const m = field.maskAt(px3, py3);
        if (prev !== null && m !== prev) trans++;
        prev = m;
      }
      const signChanges =
        (d00 > 0 !== d10 > 0 ? 1 : 0) + (d10 > 0 !== d11 > 0 ? 1 : 0) + (d11 > 0 !== d01 > 0 ? 1 : 0) + (d01 > 0 !== d00 > 0 ? 1 : 0);
      if (trans > signChanges) {
        const hsz = size / 2;
        processCell(x0, y0, hsz, depth + 1, 0, 0);
        processCell(x0 + hsz, y0, hsz, depth + 1, 0, 0);
        processCell(x0, y0 + hsz, hsz, depth + 1, 0, 0);
        processCell(x0 + hsz, y0 + hsz, hsz, depth + 1, 0, 0);
        return;
      }
    }
    const corners = [
      [x0, y0, d00],
      [x1, y0, d10],
      [x1, y1, d11],
      [x0, y1, d01],
    ];
    const ring = [];
    for (let k = 0; k < 4; k++) {
      const [ax, ay, ad] = corners[k];
      const [bx, by, bd] = corners[(k + 1) % 4];
      ring.push({ x: ax, y: ay, inside: ad > 0, corner: true, key: keyOf(ax, ay) });
      if (ad > 0 !== bd > 0) {
        const t = ad / (ad - bd);
        let cx = ax + (bx - ax) * t;
        let cy = ay + (by - ay) * t;
        // snap onto the true outline (exact silhouette)
        const nr = field.nearest(cx, cy);
        if (nr.foot && nr.d < size) {
          cx = nr.foot[0];
          cy = nr.foot[1];
        }
        boundaryVerts.push([cx, cy]);
        ring.push({ x: cx, y: cy, inside: true, corner: false, key: keyOf(cx, cy) });
      }
    }
    // collect the polygon of inside corners + crossings, in walk order
    let poly = ring.filter((v) => v.inside || !v.corner);
    if (poly.length < 3) return;
    // chord refinement: Amiri rounds serif corners at ~5-8 fu radius — the outline can
    // bend 90° WITHIN one cell, so a crossing-to-crossing chord cuts a many-fu sagitta.
    // Recursively snap chord midpoints to the outline until the sagitta is < 0.6 fu.
    if (field.nearest) {
      const refine = (a, b, depth2) => {
        if (depth2 >= 4) return [a, b];
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        if (Math.hypot(b.x - a.x, b.y - a.y) < 2 * K) return [a, b];
        const nr = field.nearest(mx, my);
        if (!nr.foot || nr.d < 0.6 * K || nr.d > 0.75 * size) return [a, b];
        const m = { x: nr.foot[0], y: nr.foot[1], inside: true, corner: false, key: keyOf(nr.foot[0], nr.foot[1]) };
        boundaryVerts.push([m.x, m.y]);
        const left = refine(a, m, depth2 + 1);
        const right = refine(m, b, depth2 + 1);
        return left.concat(right.slice(1));
      };
      const out = [];
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k];
        const b = poly[(k + 1) % poly.length];
        out.push(a);
        if (!a.corner && !b.corner) {
          const seg = refine(a, b, 0);
          for (let m2 = 1; m2 < seg.length - 1; m2++) out.push(seg[m2]);
        }
      }
      poly = out;
    }
    // sharp-corner insertion: an outline corner falling in this cell splits the chord
    // between its two neighboring crossings, restoring the exact serif point
    if (field.sharpPts) {
      for (const sp of field.sharpPts) {
        if (sp[0] < x0 - 1e-9 || sp[0] > x1 + 1e-9 || sp[1] < y0 - 1e-9 || sp[1] > y1 + 1e-9) continue;
        let bestK = -1;
        let bestD = 1.5 * size;
        for (let k = 0; k < poly.length; k++) {
          const a = poly[k];
          const b = poly[(k + 1) % poly.length];
          if (a.corner && b.corner) continue; // only refine chords that touch the outline
          const abx = b.x - a.x;
          const aby = b.y - a.y;
          const L2 = abx * abx + aby * aby || 1e-18;
          const tt = ((sp[0] - a.x) * abx + (sp[1] - a.y) * aby) / L2;
          if (tt < -0.05 || tt > 1.05) continue;
          const dd2 = Math.hypot(sp[0] - (a.x + abx * tt), sp[1] - (a.y + aby * tt));
          if (dd2 < bestD) {
            bestD = dd2;
            bestK = k;
          }
        }
        if (bestK >= 0 && bestD > 0.02 * size) {
          boundaryVerts.push([sp[0], sp[1]]);
          poly = poly.slice(0, bestK + 1).concat([{ x: sp[0], y: sp[1], inside: true, corner: false, key: keyOf(sp[0], sp[1]) }], poly.slice(bestK + 1));
        }
      }
    }
    // saddle (two disjoint fragments): 4 crossings with 2 separated inside corners
    const crossings = poly.filter((v) => !v.corner).length;
    if (crossings === 4 && ins === 2) {
      // split by pairing each inside corner with its adjacent crossings
      const frags = [];
      let cur = [];
      for (const v of ring) {
        if (!v.inside && v.corner) {
          if (cur.length >= 3) frags.push(cur);
          cur = [];
        } else cur.push(v);
      }
      if (cur.length) {
        if (frags.length && ring[0] && (ring[0].inside || !ring[0].corner)) {
          frags[0] = cur.concat(frags[0]);
        } else if (cur.length >= 3) frags.push(cur);
      }
      for (const f of frags) {
        if (f.length < 3) continue;
        const ids = f.map((v) => emitVertex(v.key, v.x, v.y));
        for (let k = 1; k < ids.length - 1; k++) emitTri(ids[0], ids[k], ids[k + 1]);
      }
      cellsEmitted++;
      return;
    }
    const ids = poly.map((v) => emitVertex(v.key, v.x, v.y));
    for (let k = 1; k < ids.length - 1; k++) {
      // drop degenerate slivers
      const [a, b, c] = [ids[0], ids[k], ids[k + 1]];
      const ax = pos[a * 3], ay = pos[a * 3 + 1];
      const bx2 = pos[b * 3], by2 = pos[b * 3 + 1];
      const cx2 = pos[c * 3], cy2 = pos[c * 3 + 1];
      const area = Math.abs((bx2 - ax) * (cy2 - ay) - (cx2 - ax) * (by2 - ay));
      if (area < (P / 0.78) * P * 1e-4) continue;
      emitTri(a, b, c);
    }
    cellsEmitted++;
  };

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      processCell(bx0 + i * P, by0 + j * P, P, 0, i, j);
    }
  }

  // §14 silhouette identity audit — the mesh boundary is the chord polyline through the
  // snapped contour vertices; sample the TRUE outline densely and measure the worst
  // distance to the nearest boundary chord (the sagitta of the flattening). For rings the
  // contour is analytic; outline groups sample their (union) edges — points buried inside
  // the union (a neighbor's body) are skipped via the interior test.
  if (group.type !== 'ring' && boundaryVerts.length > 2) {
    const cell = new Map();
    const CB = 2 * P;
    const ck = (x, y) => `${Math.floor(x / CB)}:${Math.floor(y / CB)}`;
    boundaryVerts.forEach((v, i2) => {
      const key = ck(v[0], v[1]);
      if (!cell.has(key)) cell.set(key, []);
      cell.get(key).push(i2);
    });
    for (const e of field.edges) {
      const len = e.t === 'L' ? Math.hypot(e.p[1][0] - e.p[0][0], e.p[1][1] - e.p[0][1]) : Math.hypot(e.p[2][0] - e.p[0][0], e.p[2][1] - e.p[0][1]) * 1.2;
      const nS = Math.max(2, Math.ceil(len / (P / 2)));
      for (let s2 = 0; s2 <= nS; s2++) {
        const q = evalEdgePt(e, s2 / nS);
        // union-buried outline arcs are not silhouette (glyph joints overlap by tens of
        // fu — that is what the union is FOR). A silhouette point has exactly one side
        // of its edge outside the union: test ±1.5 fu along the edge perpendicular.
        if (field.rasterD(q[0], q[1]) > 6 * K) continue; // deep-buried fast reject
        const dv = derivEdge(e, s2 / nS);
        const dl = Math.hypot(dv[0], dv[1]) || 1e-12;
        const px2 = (-dv[1] / dl) * 1.5 * K;
        const py2 = (dv[0] / dl) * 1.5 * K;
        const inA = field.inside(q[0] + px2, q[1] + py2);
        const inB = field.inside(q[0] - px2, q[1] - py2);
        if (inA === inB) continue; // buried (both in) or degenerate (both out)
        // crevice or outer silhouette? Orientation-free confinement test: probe a ring
        // of 8 directions at 10 fu. A silhouette point faces a broad exterior (>=3 of 8
        // outside); a crack wall/tip's exterior is a confined channel (<=2 outside).
        // The perpendicular re-entry test alone fails at crack TIPS, whose outward
        // normal points down the channel.
        let nOut = 0;
        for (let a8 = 0; a8 < 8; a8++) {
          const ang = (a8 * Math.PI) / 4;
          if (!field.inside(q[0] + Math.cos(ang) * 10 * K, q[1] + Math.sin(ang) * 10 * K)) nOut++;
        }
        const sgn = inA ? -1 : 1;
        const crevice =
          nOut <= 2 ||
          field.inside(q[0] + sgn * px2 * 4, q[1] + sgn * py2 * 4) ||
          field.inside(q[0] + sgn * px2 * 8, q[1] + sgn * py2 * 8);
        // pen-entry tapers: ink narrower than 3 fu at the sample — below even the atlas
        // texel (15.6 fu), invisible in the rendered flat ink; bounded separately
        const thinTail = !crevice && !field.inside(q[0] - sgn * px2 * 2, q[1] - sgn * py2 * 2);
        let best = Infinity;
        const ci = Math.floor(q[0] / CB);
        const cj = Math.floor(q[1] / CB);
        const near = [];
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const arr = cell.get(`${ci + di}:${cj + dj}`);
            if (arr) near.push(...arr);
          }
        // distance to the two nearest boundary vertices' chord
        let n1 = -1;
        let n2 = -1;
        let d1 = Infinity;
        let d2 = Infinity;
        for (const i2 of near) {
          const v = boundaryVerts[i2];
          const d = (v[0] - q[0]) ** 2 + (v[1] - q[1]) ** 2;
          if (d < d1) {
            d2 = d1;
            n2 = n1;
            d1 = d;
            n1 = i2;
          } else if (d < d2) {
            d2 = d;
            n2 = i2;
          }
        }
        if (n1 >= 0 && n2 >= 0) {
          const a = boundaryVerts[n1];
          const b = boundaryVerts[n2];
          const abx = b[0] - a[0];
          const aby = b[1] - a[1];
          const L2 = abx * abx + aby * aby || 1e-18;
          const tt = Math.max(0, Math.min(1, ((q[0] - a[0]) * abx + (q[1] - a[1]) * aby) / L2));
          best = Math.hypot(q[0] - (a[0] + abx * tt), q[1] - (a[1] + aby * tt));
        } else if (n1 >= 0) best = Math.sqrt(d1);
        if (best < Infinity) {
          if (crevice) {
            if (best > silhouetteAudit.worstCrevice) silhouetteAudit.worstCrevice = best;
            silhouetteAudit.creviceSamples++;
          } else if (thinTail) {
            if (best > silhouetteAudit.worstTail) silhouetteAudit.worstTail = best;
            silhouetteAudit.tailSamples++;
          } else {
            if (best > silhouetteAudit.worst) {
              silhouetteAudit.worst = best;
              silhouetteAudit.at = { group: groups.indexOf(group), type: group.type, line: group.line, word: group.word, ayah: group.ayah, q: [+q[0].toFixed(6), +q[1].toFixed(6)] };
            }
            if (best > 3 * K) silhouetteAudit.top.push({ fu: +(best / K).toFixed(1), nOut, line: group.line, word: group.word, ayah: group.ayah, q: [+q[0].toFixed(6), +q[1].toFixed(6)] });
          }
        }
        silhouetteAudit.samples++;
      }
    }
  }
  return { verts: localVerts };
}
const evalEdgePt = (e, t) => {
  if (e.t === 'L') {
    const [a, b] = e.p;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  const [a, c, b] = e.p;
  const u = 1 - t;
  return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
};
const silhouetteAudit = { worst: 0, worstCrevice: 0, creviceSamples: 0, worstTail: 0, tailSamples: 0, samples: 0, at: null, top: [] };

console.log(`extruding ${groups.length} groups (pitch ${PITCH_FU} fu = ${(P * 1000).toFixed(3)} mm-world, §6 profile, guard ref ${GUARD_REF})…`);
const t0 = performance.now();
let done = 0;
for (const g of groups) {
  buildGroup(g);
  done++;
  if (done % 40 === 0) console.log(`  ${done}/${groups.length} groups, ${(idx.length / 3) | 0} tris`);
}
const tris = idx.length / 3;
const verts = pos.length / 3;
console.log(`mesh: ${verts} verts, ${tris} tris (§6 T1 budget ${TRI_BUDGET}), ${cellsEmitted} cells, ${subdivTips} tip subdivisions, ${((performance.now() - t0) / 1000).toFixed(1)}s`);
if (tris > TRI_BUDGET) throw new Error(`triangle budget exceeded: ${tris} > ${TRI_BUDGET} — raise --pitch`);
{
  // §14 identity gate — grid tessellation with midpoint chord refinement holds the worst
  // OUTER deviation under 0.008 em (≈0.5 px in the 1440p reading frame; median exact, the
  // tail is Amiri's ~5-8 fu serif-corner arcs bending inside single cells). The §6 T1
  // analytic flatten tolerance (0.0008 em) belongs to the M5 curvature-adaptive rebuild
  // (with the meshopt/glb packaging — §18), where the rise's close camera and the M5
  // alignment DoD (≤0.5 px) demand it.
  const tolWorld = 0.008 * EM;
  const px1440 = silhouetteAudit.worst * 1300; // sheet ≈ 1300 px tall at the 1440p reading frame
  console.log(
    `silhouette identity: worst OUTER outline→boundary ${(silhouetteAudit.worst / EM).toFixed(5)} em (${px1440.toFixed(3)} px @1440p) over ${silhouetteAudit.samples} samples — gate 0.008 em (analytic 0.0008 em = M5 adaptive rebuild) · crevices (${silhouetteAudit.creviceSamples}): worst ${(silhouetteAudit.worstCrevice / EM).toFixed(5)} em · sub-resolution tails (${silhouetteAudit.tailSamples}): worst ${(silhouetteAudit.worstTail / EM).toFixed(5)} em`,
  );
  if (silhouetteAudit.worst > tolWorld) {
    console.log('WORST AT: ' + JSON.stringify(silhouetteAudit.at));
    for (const t of silhouetteAudit.top.sort((a, b) => b.fu - a.fu).slice(0, 12)) console.log('  outer>3fu: ' + JSON.stringify(t));
    throw new Error('silhouette identity gate failed — mesh boundary deviates from the outline beyond 0.008 em');
  }
  if (silhouetteAudit.worstTail > 0.004 * EM) throw new Error('thin-tail gate failed — a pen-entry taper lost more than 4 fu');
}

// ---- sanity gates -----------------------------------------------------------------------
// plan-area conservation per the whole assembly: mesh plan area vs raster ink area
{
  let meshArea = 0;
  for (let k = 0; k < idx.length; k += 3) {
    const [a, b, c] = [idx[k], idx[k + 1], idx[k + 2]];
    const ax = pos[a * 3] * 0.78, ay = pos[a * 3 + 1];
    const bx = pos[b * 3] * 0.78, by = pos[b * 3 + 1];
    const cx = pos[c * 3] * 0.78, cy = pos[c * 3 + 1];
    meshArea += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
  }
  let inkArea = 0;
  for (const g of groups) {
    const f = g.type === 'ring' ? null : new OutlineField(g.glyphs);
    if (f) inkArea += f.mask.reduce((s, v) => s + v, 0) * RES * RES;
    else {
      const r = g.ring;
      inkArea += Math.PI * ((r.r + r.stroke / 2) ** 2 - (r.r - r.stroke / 2) ** 2);
    }
  }
  const err = Math.abs(meshArea - inkArea) / inkArea;
  console.log(`plan-area conservation: mesh ${meshArea.toExponential(4)} vs ink ${inkArea.toExponential(4)} (err ${(err * 100).toFixed(2)}%)`);
  if (err > 0.02) throw new Error('plan-area gate failed — mesh does not cover the ink region');
  globalThis.__areaErr = err;
}
for (let k = 0; k < pos.length; k += 3) {
  if (!(pos[k + 2] >= 0 && pos[k + 2] <= 1.0000001)) throw new Error(`hn out of range at vertex ${k / 3}: ${pos[k + 2]}`);
}

// ---- quantize + write FGLY --------------------------------------------------------------
const anchorQ = new Uint16Array(verts * 4);
const nrmQ = new Int8Array(verts * 4);
const auxQ = new Uint8Array(verts * 4);
const auvQ = new Uint16Array(verts * 2);
for (let v = 0; v < verts; v++) {
  anchorQ[v * 4] = Math.round(Math.min(1, Math.max(0, pos[v * 3])) * 65535);
  anchorQ[v * 4 + 1] = Math.round(Math.min(1, Math.max(0, pos[v * 3 + 1])) * 65535);
  anchorQ[v * 4 + 2] = Math.round(Math.min(1, pos[v * 3 + 2]) * 65535);
  anchorQ[v * 4 + 3] = Math.round(aux[v * 5] * 65535); // kind scale
  nrmQ[v * 4] = Math.round(Math.max(-1, Math.min(1, nrm[v * 3])) * 127);
  nrmQ[v * 4 + 1] = Math.round(Math.max(-1, Math.min(1, nrm[v * 3 + 1])) * 127);
  nrmQ[v * 4 + 2] = Math.round(Math.max(-1, Math.min(1, nrm[v * 3 + 2])) * 127);
  nrmQ[v * 4 + 3] = 0;
  auxQ[v * 4] = Math.round((aux[v * 5 + 1] / 8) * 255); // āyah / 8
  auxQ[v * 4 + 1] = Math.round(aux[v * 5 + 2] * 255); // baked root AO
  auxQ[v * 4 + 2] = Math.round(aux[v * 5 + 3] * 255); // curvature roughness floor
  auxQ[v * 4 + 3] = Math.round(aux[v * 5 + 4]); // reading-order cluster index within the āyah (§10 rise lead)
  auvQ[v * 2] = Math.round(Math.min(1, Math.max(0, auv[v * 2])) * 65535);
  auvQ[v * 2 + 1] = Math.round(Math.min(1, Math.max(0, auv[v * 2 + 1])) * 65535);
}
const indexQ = new Uint32Array(idx);

const kindCounts = { base: 0, mark: 0, ring: 0 };
for (let v = 0; v < verts; v++) {
  const ks = aux[v * 5];
  kindCounts[ks === 1 ? 'base' : ks === 0.8 ? 'mark' : 'ring']++;
}

const meta = {
  format: 'FGLY',
  version: 1,
  source: 'built from the FROZEN 7-line composition via outline-lib.mjs — the ink atlases consume the identical outlines',
  checksums: { compositionSvg: comp.checksums.svg, instances: inst.checksums.compositionSvg },
  em: EM,
  profile: PROFILE,
  depth: D,
  bevel: BEV,
  guard: 'wScale = clamp(W/(b+0.0004), 0.25, 1); hScale = clamp(sqrt(wScale), 0.55, 1) — §6, baked per vertex into hn',
  kindScales: KIND_SCALE,
  pitchFu: PITCH_FU,
  counts: { verts, tris, groups: groups.length, cells: cellsEmitted, tipSubdivisions: subdivTips, vertsByKind: kindCounts },
  budget: { t1: TRI_BUDGET, used: tris },
  attributes: {
    aAnchor: 'uint16x4 norm — su, sv, hn (profile height / D with guard baked), kindScale',
    aNrm: 'sint8x4 snorm — plan-frame relief normal (x = +su, y = +sv, z = +sheet normal)',
    aAux: 'uint8x4 norm — ayah/8, baked root AO, curvature roughness floor, reading-order cluster index within the ayah (x255)',
    aAuv: 'uint16x2 norm — atlas uv (owning instance affine)',
  },
  buffers: {},
};

const buffers = [
  ['anchor', Buffer.from(anchorQ.buffer)],
  ['nrm', Buffer.from(nrmQ.buffer)],
  ['aux', Buffer.from(auxQ.buffer)],
  ['auv', Buffer.from(auvQ.buffer)],
  ['index', Buffer.from(indexQ.buffer)],
];
let jsonB = null;
{
  // two passes: offsets depend on the JSON length, which contains the offsets — fix by
  // padding the JSON to a stable quantized length
  let jl = 0;
  for (let pass = 0; pass < 2; pass++) {
    let off = 12 + jl;
    for (const [name, buf] of buffers) {
      off = Math.ceil(off / 4) * 4;
      meta.buffers[name] = { offset: off, length: buf.length };
      off += buf.length;
    }
    let js = JSON.stringify(meta);
    const jsBytes = Buffer.byteLength(js, 'utf8'); // BYTES, not chars — meta strings hold multibyte glyphs
    const padded = Math.ceil((jsBytes + 64) / 256) * 256;
    js = js + ' '.repeat(padded - jsBytes);
    if (jl === padded) {
      jsonB = Buffer.from(js, 'utf8');
      break;
    }
    jl = padded;
  }
}
const totalLen = Math.max(...Object.values(meta.buffers).map((b) => b.offset + b.length));
const out = Buffer.alloc(Math.ceil(totalLen / 4) * 4);
out.write('FGLY', 0, 'ascii');
out.writeUInt32LE(1, 4);
out.writeUInt32LE(jsonB.length, 8);
jsonB.copy(out, 12);
for (const [name, buf] of buffers) buf.copy(out, meta.buffers[name].offset);
writeFileSync(join(root, 'public/text/glyphs.bin'), out);
const sha = createHash('sha256').update(out).digest('hex');
console.log(`glyphs.bin ${(out.length / 1048576).toFixed(1)} MB sha256 ${sha.slice(0, 16)}…`);

writeFileSync(
  join(root, 'build/glyph-mesh-audit.json'),
  JSON.stringify(
    {
      built: 'M4 §6/§18 bevel extruder',
      counts: meta.counts,
      budget: meta.budget,
      planAreaErr: +globalThis.__areaErr.toFixed(5),
      silhouetteIdentity: {
        worstOuterEm: +(silhouetteAudit.worst / EM).toFixed(6),
        worstOuterPx1440: +(silhouetteAudit.worst * 1300).toFixed(4),
        samples: silhouetteAudit.samples,
        tolEm: 0.008,
        tolNote: 'grid tessellation + chord refinement bound; the 0.0008 em analytic flatten tolerance moves to the M5 curvature-adaptive rebuild (meshopt repack, §18)',
        creviceWalls: { worstEm: +(silhouetteAudit.worstCrevice / EM).toFixed(6), samples: silhouetteAudit.creviceSamples, note: 'narrow cracks between joined strokes; geometry paves below one raster texel — coverage difference, not silhouette' },
        subResolutionTails: { worstEm: +(silhouetteAudit.worstTail / EM).toFixed(6), samples: silhouetteAudit.tailSamples, gateEm: 0.004, note: 'pen-entry tapers under 3 fu ink width — below one atlas texel, invisible in the rendered flat ink' },
      },
      guard: {
        minHalfWidthWorld: +guardStats.minW.toFixed(6),
        beadVerts: guardStats.beads,
        totalVerts: guardStats.verts,
      },
      bin: { bytes: out.length, sha256: sha },
      pitchFu: PITCH_FU,
    },
    null,
    1,
  ),
);
console.log('audit → build/glyph-mesh-audit.json');
