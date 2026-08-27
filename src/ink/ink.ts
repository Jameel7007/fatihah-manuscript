// Flat ink layer (M3, §14) — evaluated INSIDE the parchment surface shader: per-fragment
// grid lookup → up to 8 candidate instances → MTSDF coverage with analytic AA, revealed
// along the stroke-order field by the §13 E5 spatial edge (smoothstep over Δw 0.012),
// with a per-texel wet trail (Δp 0.045, §20 M3) and a fiber-grain bleed on the threshold.
// Āyah rings are analytic circle SDFs drawn by the same pen clock (angular w from the
// top, sweeping leftward first — the RTL hand). Everything is a pure function of p.
//
// Lookup textures are fixed-point RGBA8 (16-bit byte pairs) — float32 DataTextures
// silently break the physical material's WebGPU pipeline in three r185 (see ink/atlas.ts).

import { float, vec2, vec4, texture, textureLoad, ivec2, clamp, smoothstep, fwidth, max, min, floor, atan, fract, length, step } from 'three/tsl';
import type { InkPack } from './atlas';

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

const E5_FEATHER = 0.006; // §13 E5: smoothstep over Δw 0.012 of the stroke-order field
const SHEET_W = 0.78;

export interface InkSample {
  cov: N;
  wet: N;
}

/** decode a 16-bit big-endian byte pair (channels already 0..1) back to [0,1] */
const d16 = (hi: N, lo: N): N => hi.mul(65280).add(lo.mul(255)).div(65535);

/** Ink coverage + wetness at sheet uv `suv`, at scroll position `pack.uP`.
 *  `fiberH` is the §7 fiber height sample (bleed + cavity live on it). */
export function inkNode(pack: InkPack, suv: N, fiberH: N): InkSample {
  const uP: N = pack.uP;

  const gx: N = clamp(floor(suv.x.mul(pack.gridW)), 0, pack.gridW - 1).toInt();
  const gy: N = clamp(floor(suv.y.mul(pack.gridH)), 0, pack.gridH - 1).toInt();

  let cov: N = float(0);
  let wet: N = float(0);

  // analytic AA from suv derivatives — continuous across grid cells (a per-instance uv
  // fwidth would spike at cell borders); §14's "analytic fwidth AA" via per-instance slope
  const suvFw: N = length(vec2(fwidth(suv.x), fwidth(suv.y))).max(1e-6);

  for (let slot = 0; slot < pack.slots; slot++) {
    // grid cell: 4 RGBA8 texels = 8 16-bit slots; 0xFFFF = empty
    const gtx: N = textureLoad(pack.grid, ivec2(gx.mul(4).add(slot >> 1), gy));
    const pair: N = slot % 2 === 0 ? gtx.xy : gtx.zw;
    const idxV: N = pair.x.mul(65280).add(pair.y.mul(255)); // integer index as float
    const valid: N = float(1).sub(step(65534.5, idxV));
    const row: N = idxV.min(pack.count - 1).toInt();

    const T = (t: number): N => textureLoad(pack.inst, ivec2(t, row));
    const T0: N = T(0);
    const T1: N = T(1);
    const T4: N = T(4);
    const T5: N = T(5);
    const r0: N = vec4(d16(T0.x, T0.y), d16(T0.z, T0.w), d16(T1.x, T1.y), d16(T1.z, T1.w)); // sheet rect
    const start: N = d16(T4.x, T4.y);
    const dur: N = d16(T4.z, T4.w).max(1e-5);
    const isRing: N = step(0.5, T5.z.mul(255));
    const aaSlope: N = d16(T5.x, T5.y).mul(4096);

    const luv: N = suv.sub(r0.xy).div(r0.zw.sub(r0.xy).max(1e-6));
    const inside: N = step(0, luv.x).mul(step(luv.x, 1)).mul(step(0, luv.y)).mul(step(luv.y, 1));

    // per-texel timing shared by both branches — overscanned by the E5 feather so the
    // stroke start is fully hidden at t=0 and the stroke end fully lands at t=1
    const t01raw: N = clamp(uP.sub(start).div(dur), 0, 1);
    const t01: N = t01raw.mul(1 + 4 * E5_FEATHER).sub(2 * E5_FEATHER);

    // --- glyph branch: MTSDF + stroke-order field ---
    const T2: N = T(2);
    const T3: N = T(3);
    const auv0: N = vec2(d16(T2.x, T2.y), d16(T2.z, T2.w));
    const auv1: N = vec2(d16(T3.x, T3.y), d16(T3.z, T3.w));
    const auv: N = auv0.add(luv.mul(auv1.sub(auv0)));
    const s: N = texture(pack.mtsdf, auv);
    const med: N = max(min(s.r, s.g), min(max(s.r, s.g), s.b));
    const wG: N = texture(pack.prog, auv).r;
    const aaG: N = suvFw.mul(aaSlope).max(1e-5); // normalized-sd units per fragment

    // --- ring branch: analytic circle in world units ---
    const T6: N = T(6);
    const T7: N = T(7);
    const ringC: N = vec2(d16(T6.x, T6.y).sub(0.5), d16(T6.z, T6.w));
    const ringR: N = d16(T7.x, T7.y).mul(0.1);
    const ringS: N = d16(T7.z, T7.w).mul(0.1);
    const pw: N = vec2(suv.x.sub(0.5).mul(SHEET_W), suv.y);
    const d: N = pw.sub(ringC);
    const sdR: N = ringS.mul(0.5).sub(length(d).sub(ringR).abs()); // world; + inside the stroke
    const aaR: N = suvFw.mul(SHEET_W * 0.72).max(1e-6); // ≈ world units per fragment
    const wR: N = fract(atan(d.x.negate(), d.y.negate()).div(2 * Math.PI)); // top = 0, left first

    const w: N = wG.mul(float(1).sub(isRing)).add(wR.mul(isRing));

    // bleed: ink wicks into the fiber grain as it sets — threshold jitter by fiber height,
    // widening slightly once the texel has dried (rings stay crisp)
    const tReveal: N = start.add(w.mul(dur));
    const dry: N = clamp(uP.sub(tReveal).div(pack.wetDp), 0, 1);
    const bleedG: N = fiberH.sub(0.5).mul(0.055).mul(dry.mul(0.5).add(0.5));

    const covG: N = clamp(med.sub(0.5).add(bleedG).div(aaG).add(0.5), 0, 1);
    const covR: N = clamp(sdR.div(aaR).add(0.5), 0, 1);
    const covShape: N = covG.mul(float(1).sub(isRing)).add(covR.mul(isRing));

    const reveal: N = smoothstep(w.sub(E5_FEATHER), w.add(E5_FEATHER), t01); // E5 leading edge
    const c: N = covShape.mul(reveal).mul(inside).mul(valid);

    cov = max(cov, c);
    wet = max(wet, float(1).sub(dry).mul(c));
  }

  return { cov, wet };
}

export const INK_DRY = '#2A211B';
export const INK_WET = '#17100B';
