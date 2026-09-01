// p-drivers: every animated quantity is a pure function of the smoothed scroll uniform.
// M0 carries only the drivers the gray-box needs; the full DeformUBO set lands with M1.

import { E1, E2, E7, span } from './easing';

/** Environment yaw in degrees — §10 schedule: +12° through the unroll, sweeping to −38° as
 *  the text rises so the window reflection travels along the gold (idle drift is M6's). */
export function envYawDeg(p: number): number {
  if (p < 0.36) return 12;
  if (p < 0.6) return 12 * (1 - E1(span(p, 0.36, 0.6)));
  if (p < 0.86) return -20 * E1(span(p, 0.6, 0.86));
  return -20 - 18 * E1(span(p, 0.86, 1));
}

/** Sheet pose tilt in degrees — §4/§10: +14° → +6° over [0.06, 0.36], → 0° over [0.54, 0.64]. */
export function poseTiltDeg(p: number): number {
  const settled = 14 + (6 - 14) * E2(span(p, 0.06, 0.36));
  return settled * (1 - E2(span(p, 0.54, 0.64)));
}

/** World transform of the sheet root: tilt pivoted at the moving top curl line. Single
 *  source of truth — used by the scene (sheetRoot) and by the camera's extent sampler. */
export function poseTransform(p: number, zTopCurl: number): { rotX: number; offY: number; offZ: number } {
  const t = (poseTiltDeg(p) * Math.PI) / 180;
  return { rotX: t, offY: zTopCurl * Math.sin(t), offZ: zTopCurl * (1 - Math.cos(t)) };
}

/** §14 emboss apparent-height factor (0..1): E2 growth over the emboss window
 *  [0.640, 0.690], then the E7 fade across the geometry-handoff overlap [0.690, 0.730]
 *  (embossStr = 1 − E7(t); the glyph mesh takes over inside that window — M5). */
export function embossFactor(p: number): number {
  return E2(span(p, 0.64, 0.69)) * (1 - E7(span(p, 0.69, 0.73)));
}

/** §14 geometry depth (world): the glyph mesh enters at HALF the emboss's apparent height
 *  (0.00045) at p = 0.690 and grows to 0.0012 across the handoff overlap, E2. Below the
 *  window the mesh is hidden (applyFrame); the returned floor keeps the z-guard exact at
 *  entry. The M5 per-āyah rise stagger composes as depth = max(geoDepth, kind·stagger). */
export function geoDepth(p: number): number {
  return 0.00045 + 0.00075 * E2(span(p, 0.69, 0.73));
}

// ---- M5 · the rise (§5/§10/§14) --------------------------------------------------------
export const RISE_START = 0.722; // first āyah's rise begins inside the handoff tail
export const RISE_AYAH_DP = 0.0115; // āyah offset
export const RISE_CLUSTER_DP = 0.0012; // within an āyah, clusters lead by reading order
export const RISE_DUR = 0.093; // per cluster, E4 (= E2, no overshoot by decree)
export const RISE_GOLD_LAG = 0.25; // gold transmutation lags the rise by this fraction of the window
export const DEPTH_FULL = 0.0115; // §6 D = 0.55 × x-height
export const DEPTH_ENTRY = 0.0012; // handoff end depth — the rise continues from here

/** Rise start for a cluster (āyah 1..7, reading-order cluster index within it). */
export function riseStart(ayah: number, cluster: number): number {
  return RISE_START + RISE_AYAH_DP * (ayah - 1) + RISE_CLUSTER_DP * cluster;
}

/** Per-cluster extrusion depth (world) — CPU reference of the vertex-stage law:
 *  max(geoDepth, stagger) with stagger = 0.0012 → 0.0115 over [start, start + 0.093], E4. */
export function riseDepth(p: number, ayah: number, cluster: number): number {
  const s = riseStart(ayah, cluster);
  const stagger = DEPTH_ENTRY + (DEPTH_FULL - DEPTH_ENTRY) * E2(span(p, s, s + RISE_DUR));
  return Math.max(geoDepth(p), p >= s ? stagger : 0);
}

/** Gold transmutation factor for a cluster (§14): the rise window shifted by 0.25 of its length, E2. */
export function goldFactor(p: number, ayah: number, cluster: number): number {
  const s = riseStart(ayah, cluster) + RISE_GOLD_LAG * RISE_DUR;
  return E2(span(p, s, s + RISE_DUR));
}

/** §14/§7 flat-ink ghost: the occluded flat layer fades to the 8% stain over [0.78, 0.84]. */
export function inkGhost(p: number): number {
  return 1 - 0.92 * E1(span(p, 0.78, 0.84));
}

/** §8/§10 contact-shadow blob ramp: starts at 0.72, full by 0.80 (E2). */
export function contactRamp(p: number): number {
  return E2(span(p, 0.72, 0.8));
}

/** §10 key-intensity factor: 1.00 through the unroll, S3 dim to 0.88 as the ink begins,
 *  rising 0.88 → 0.95 with the presenting climb [0.52, 0.60], holding 0.95 after. */
export function keyFactor(p: number): number {
  return 1 - 0.12 * E1(span(p, 0.3, 0.34)) + 0.07 * E1(span(p, 0.52, 0.6));
}

/** §10 rim-intensity factor (of the rig's 0.30 base ratio): 0.30 → 0.42 over the emboss
 *  [0.64, 0.68], → 0.52 as the rise begins [0.72, 0.76]. Returned as a multiplier of the
 *  M2 base (rim = KEY·0.30·rimFactor/0.30). */
export function rimFactor(p: number): number {
  const a = 0.3 + (0.42 - 0.3) * E2(span(p, 0.64, 0.68));
  return (a + (0.52 - 0.42) * E2(span(p, 0.72, 0.76))) / 0.3;
}

/** State label for the HUD — ranges from §1 (overlaps resolve to the later state). */
const STATES: ReadonlyArray<readonly [string, number]> = [
  ['1 · rolled', 0.0],
  ['2 · unrolling', 0.06],
  ['3 · ink', 0.32],
  ['4 · presenting', 0.54],
  ['5 · relief', 0.64],
  ['6 · rising', 0.722],
  ['7 · facing', 0.84],
];

export function stateLabel(p: number): string {
  let label = STATES[0]?.[0] ?? '';
  for (const [name, start] of STATES) {
    if (p >= start) label = name;
  }
  return label;
}
