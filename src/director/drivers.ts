// p-drivers: every animated quantity is a pure function of the smoothed scroll uniform.
// M0 carries only the drivers the gray-box needs; the full DeformUBO set lands with M1.

import { E1, E2, span } from './easing';

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
