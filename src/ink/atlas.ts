// Ink atlas runtime loader (M3) — fetches the frozen atlases + instance table and builds
// the GPU-side lookup structures: a sheet-uv spatial grid (8 instance slots per cell) and
// a packed instance texture. Everything is checksum-gated against the frozen composition.

import { assetUrl } from '../core/url';
import { DataTexture, LinearFilter, NearestFilter, RGBAFormat, Texture, TextureLoader, NoColorSpace, UnsignedByteType, ClampToEdgeWrapping } from 'three/webgpu';
import { uniform } from 'three/tsl';

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

export interface InkInstance {
  gid: number;
  order: number;
  line: number;
  word: number;
  ayah: number;
  kind: string;
  kashida: boolean;
  sheet: [number, number, number, number];
  atlas: [number, number, number, number];
  start: number;
  dur: number;
}

export interface InkRing {
  ayah: number;
  x: number;
  y: number;
  r: number;
  stroke: number;
  start: number;
  dur: number;
}

export interface InkPack {
  mtsdf: Texture;
  prog: Texture;
  inst: DataTexture;
  grid: DataTexture;
  gridW: number;
  gridH: number;
  slots: number; // instance slots per grid cell (texels × 4)
  count: number;
  rangePx: number;
  wetDp: number;
  uP: N;
  meta: { mtsdfSha: string; progSha: string; compositionSvg: string };
}

const GRID_W = 112;
const GRID_H = 144;
const SHEET_W = 0.78;

/** World (composition) x/y → sheet uv. */
const toSuv = (x: number, y: number): [number, number] => [(x + SHEET_W / 2) / SHEET_W, y]; // +x (composition right) = suv.x 1 = screen right on the viewed recto

export async function loadInk(): Promise<InkPack> {
  const data = (await (await fetch(assetUrl('text/ink-instances.json'))).json()) as {
    pxPerEm: number;
    rangePx: number;
    atlas: [number, number];
    wetDp: number;
    checksums: { compositionSvg: string; mtsdfPng: string; progPng: string };
    instances: InkInstance[];
    rings: InkRing[];
  };
  const loader = new TextureLoader();
  const [mtsdf, prog] = await Promise.all([loader.loadAsync(assetUrl('text/ink-mtsdf.png')), loader.loadAsync(assetUrl('text/ink-prog.png'))]);
  for (const t of [mtsdf, prog]) {
    t.colorSpace = NoColorSpace;
    t.flipY = false; // atlas row 0 = top; sampled with v measured top-down
    t.generateMipmaps = false;
    t.minFilter = LinearFilter;
    t.magFilter = LinearFilter;
    t.wrapS = ClampToEdgeWrapping;
    t.wrapT = ClampToEdgeWrapping;
    t.needsUpdate = true;
  }

  const N_G = data.instances.length;
  const N_R = data.rings.length;
  const count = N_G + N_R;

  // ALL lookup data ships as fixed-point RGBA8 — float32 DataTextures silently break the
  // physical material's pipeline in three r185 WebGPU (bisected 2026-08-27: one textureLoad
  // on an RGBA32F texture and the sheet loses its environment light or vanishes outright,
  // with no console error). 16-bit big-endian pairs give 1.5e-5 precision over [0,1].
  const put16 = (buf: Uint8Array, at: number, v01: number): void => {
    const q = Math.max(0, Math.min(65535, Math.round(v01 * 65535)));
    buf[at] = q >> 8;
    buf[at + 1] = q & 255;
  };

  // instance texture: 8 RGBA8 texels per row —
  //  T0 [su0, sv0] T1 [su1, sv1] T2 [au0, av0] T3 [au1, av1] T4 [start, dur]
  //  T5 [aaSlope/4096 ×2B, kind, 0] T6 [ring cx+0.5, cy] T7 [ring r/0.1, stroke/0.1]
  const INST_TEXELS = 8;
  const inst = new Uint8Array(count * INST_TEXELS * 4);
  const rowAt = (row: number, texel: number): number => (row * INST_TEXELS + texel) * 4;
  const rects: Array<[number, number, number, number]> = [];
  data.instances.forEach((g, i) => {
    const [x0, y0, x1, y1] = g.sheet;
    const [suA, sv0] = toSuv(x0, y0);
    const [suB, sv1] = toSuv(x1, y1);
    const su0 = Math.min(suA, suB);
    const su1 = Math.max(suA, suB);
    rects.push([su0, sv0, su1, sv1]);
    put16(inst, rowAt(i, 0), su0);
    put16(inst, rowAt(i, 0) + 2, sv0);
    put16(inst, rowAt(i, 1), su1);
    put16(inst, rowAt(i, 1) + 2, sv1);
    put16(inst, rowAt(i, 2), g.atlas[0]);
    put16(inst, rowAt(i, 2) + 2, g.atlas[1]);
    put16(inst, rowAt(i, 3), g.atlas[2]);
    put16(inst, rowAt(i, 3) + 2, g.atlas[3]);
    put16(inst, rowAt(i, 4), g.start);
    put16(inst, rowAt(i, 4) + 2, g.dur);
    // analytic AA slope: normalized-sd change per unit suv (per §14 fwidth AA) — the cell
    // spans (atlasRect·atlasPx) over (su1−su0) of sheet u; sd is encoded over 2·rangePx
    const cellPxW = (g.atlas[2] - g.atlas[0]) * data.atlas[0];
    const aaSlope = cellPxW / Math.max(1e-6, su1 - su0) / (2 * data.rangePx);
    put16(inst, rowAt(i, 5), Math.min(1, aaSlope / 4096));
    inst[rowAt(i, 5) + 2] = 0; // kind: glyph
  });
  data.rings.forEach((r, ri) => {
    const i = N_G + ri;
    const pad = r.stroke * 2.5;
    const [suA, sv0] = toSuv(r.x - r.r - pad, r.y - r.r - pad);
    const [suB, sv1] = toSuv(r.x + r.r + pad, r.y + r.r + pad);
    const su0 = Math.min(suA, suB);
    const su1 = Math.max(suA, suB);
    rects.push([su0, sv0, su1, sv1]);
    put16(inst, rowAt(i, 0), su0);
    put16(inst, rowAt(i, 0) + 2, sv0);
    put16(inst, rowAt(i, 1), su1);
    put16(inst, rowAt(i, 1) + 2, sv1);
    put16(inst, rowAt(i, 4), r.start);
    put16(inst, rowAt(i, 4) + 2, r.dur);
    inst[rowAt(i, 5) + 2] = 255; // kind: ring
    put16(inst, rowAt(i, 6), r.x + 0.5);
    put16(inst, rowAt(i, 6) + 2, r.y);
    put16(inst, rowAt(i, 7), r.r / 0.1);
    put16(inst, rowAt(i, 7) + 2, r.stroke / 0.1);
  });
  const instTex = new DataTexture(inst, INST_TEXELS, count, RGBAFormat, UnsignedByteType);
  instTex.minFilter = NearestFilter;
  instTex.magFilter = NearestFilter;
  instTex.needsUpdate = true;

  // sheet-uv grid: 8 slots per cell as 16-bit indices in 4 RGBA8 texels; 0xFFFF = empty
  const GRID_TEXELS = 4;
  const grid = new Uint8Array(GRID_W * GRID_TEXELS * GRID_H * 4).fill(255);
  const counts = new Uint8Array(GRID_W * GRID_H);
  let overflow = 0;
  rects.forEach(([su0, sv0, su1, sv1], idx) => {
    const cx0 = Math.max(0, Math.floor(su0 * GRID_W));
    const cx1 = Math.min(GRID_W - 1, Math.floor(su1 * GRID_W));
    const cy0 = Math.max(0, Math.floor(sv0 * GRID_H));
    const cy1 = Math.min(GRID_H - 1, Math.floor(sv1 * GRID_H));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = counts[cy * GRID_W + cx]!;
        if (c >= 8) {
          overflow++;
          continue;
        }
        const at = (cy * GRID_W * GRID_TEXELS + cx * GRID_TEXELS + (c >> 1)) * 4 + (c & 1) * 2;
        grid[at] = idx >> 8;
        grid[at + 1] = idx & 255;
        counts[cy * GRID_W + cx] = c + 1;
      }
    }
  });
  if (overflow > 0) console.warn(`[ink] grid overflow: ${overflow} cell-entries dropped (raise the slot budget)`);
  const gridTex = new DataTexture(grid, GRID_W * GRID_TEXELS, GRID_H, RGBAFormat, UnsignedByteType);
  gridTex.minFilter = NearestFilter;
  gridTex.magFilter = NearestFilter;
  gridTex.needsUpdate = true;

  return {
    mtsdf,
    prog,
    inst: instTex,
    grid: gridTex,
    gridW: GRID_W,
    gridH: GRID_H,
    slots: 8,
    count,
    rangePx: data.rangePx,
    wetDp: data.wetDp,
    uP: uniform(0),
    meta: { mtsdfSha: data.checksums.mtsdfPng, progSha: data.checksums.progPng, compositionSvg: data.checksums.compositionSvg },
  };
}
