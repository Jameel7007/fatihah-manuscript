// M1 QA — §20 M1 DoD.
//  probes (?probe=1&p=…): GPU field readback vs the CPU pose oracle at 20 sample points
//    (positions ±0.0015) and GPU FD normals vs analytic normals (≤ 2°).
//  storm (?storm=seconds): synthetic scroll thrash; NaN / range / error monitor.
//  flick (?flick=1 or key Q): §17 R-flick profile with a residual-energy trace overlay —
//    the visual sign-off itself stays with a human reviewer.

import type { RenderTarget, WebGPURenderer } from 'three/webgpu';
import { GRID_H, GRID_W, type SilhouetteData } from '../field/silhouette';
import { SIM_H, SIM_W } from '../field/residual';
import { cpuPose } from '../field/cpuPose';
import type { DeformState } from '../field/deform';

/** Oracle normal: FD cross over cpuPose at fine ε — the exact surface, finer than texels. */
function oracleNormal(u: number, v: number, d: DeformState): [number, number, number] {
  const e = 5e-4;
  const pu = cpuPose(u + e, v, d);
  const mu = cpuPose(u - e, v, d);
  const pv = cpuPose(u, v + e, d);
  const mv = cpuPose(u, v - e, d);
  const du = [pu.x - mu.x, pu.y - mu.y, pu.z - mu.z];
  const dv = [pv.x - mv.x, pv.y - mv.y, pv.z - mv.z];
  const n: [number, number, number] = [
    (dv[1] ?? 0) * (du[2] ?? 0) - (dv[2] ?? 0) * (du[1] ?? 0),
    (dv[2] ?? 0) * (du[0] ?? 0) - (dv[0] ?? 0) * (du[2] ?? 0),
    (dv[0] ?? 0) * (du[1] ?? 0) - (dv[1] ?? 0) * (du[0] ?? 0),
  ];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

export interface ProbeRow {
  label: string;
  u: number;
  v: number;
  gpu: [number, number, number];
  cpu: [number, number, number];
  posErr: number;
  normErrDeg: number;
}

export interface ProbeReport {
  p: number;
  rows: ProbeRow[];
  maxPosErr: number;
  maxNormErrDeg: number;
  derived: DeformState['derived'];
  ok: boolean;
}

/** Interior sample points (u, v) — away from the silhouette inset so the oracle applies. */
const PROBE_POINTS: Array<[string, number, number]> = [
  ['web sag center', 0, 0.54],
  ['web quarter', 0, 0.44],
  ['web threequarter', 0, 0.64],
  ['cup edge +u', 0.42, 0.5],
  ['cup edge −u', -0.42, 0.5],
  ['twist corner TR', 0.4, 0.08],
  ['twist corner BL', -0.4, 0.92],
  ['top curl line', 0, 0.35],
  ['top roll mid', 0, 0.17],
  ['top roll deep', 0, 0.06],
  ['top tip', 0, 0.004],
  ['bottom ramp', 0, 0.76],
  ['bottom curl', 0, 0.9],
  ['bottom deep', 0, 0.965],
  ['bottom tip', 0, 0.996],
  ['web off-axis A', 0.25, 0.5],
  ['web off-axis B', -0.25, 0.58],
  ['roll off-axis', 0.3, 0.12],
  ['curl off-axis', -0.3, 0.88],
  ['web near top', 0.1, 0.38],
];

function texelFor(u: number, v: number): [number, number] {
  return [
    Math.round((u + 0.5) * (GRID_W - 1)),
    Math.round(v * (GRID_H - 1)),
  ];
}

export async function runProbes(
  renderer: WebGPURenderer,
  posRT: RenderTarget,
  nrmRT: RenderTarget,
  d: DeformState,
  sil: SilhouetteData,
  backend: 'webgpu' | 'webgl2',
): Promise<ProbeReport> {
  // Two full-texture readbacks instead of 40 texel reads: each WebGL readback costs a
  // fence polled on rAF, and throttled/hidden tabs make per-texel reads pathologically slow.
  const posAll = (await renderer.readRenderTargetPixelsAsync(posRT, 0, 0, GRID_W, GRID_H)) as Float32Array;
  const nrmAll = (await renderer.readRenderTargetPixelsAsync(nrmRT, 0, 0, GRID_W, GRID_H)) as Float32Array;

  const rows: ProbeRow[] = [];
  for (const [label, u, v] of PROBE_POINTS) {
    const [ti, tj] = texelFor(u, v);
    // WebGL readPixels rows are bottom-up; WebGPU buffer copies are top-down. The render
    // path is orientation-consistent on both backends — only readback indexing differs.
    const bj = backend === 'webgl2' ? GRID_H - 1 - tj : tj;
    const base = (bj * GRID_W + ti) * 4;
    const pos = posAll.subarray(base, base + 4);
    const nrm = nrmAll.subarray(base, base + 4);
    // oracle evaluated at the texel's ACTUAL param — boundary texels carry silhouette inset
    const pu = sil.params[(tj * GRID_W + ti) * 2] ?? 0;
    const pv = sil.params[(tj * GRID_W + ti) * 2 + 1] ?? 0;
    const o = cpuPose(pu, pv, d);
    const on = oracleNormal(pu, pv, d);
    const posErr = Math.hypot((pos[0] ?? 0) - o.x, (pos[1] ?? 0) - o.y, (pos[2] ?? 0) - o.z);
    const dot =
      (nrm[0] ?? 0) * (on[0] ?? 0) + (nrm[1] ?? 0) * (on[1] ?? 0) + (nrm[2] ?? 0) * (on[2] ?? 0);
    const len = Math.hypot(nrm[0] ?? 0, nrm[1] ?? 0, nrm[2] ?? 0) || 1;
    const normErrDeg = (Math.acos(Math.max(-1, Math.min(1, dot / len))) * 180) / Math.PI;
    rows.push({
      label,
      u: pu,
      v: pv,
      gpu: [pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? 0],
      cpu: [o.x, o.y, o.z],
      posErr,
      normErrDeg,
    });
  }
  const maxPosErr = Math.max(...rows.map((r) => r.posErr));
  const maxNormErrDeg = Math.max(...rows.map((r) => r.normErrDeg));
  return {
    p: d.p,
    rows,
    maxPosErr,
    maxNormErrDeg,
    derived: d.derived,
    ok: maxPosErr <= 0.0015 && maxNormErrDeg <= 2.0,
  };
}

// --- scrub storm --------------------------------------------------------------------------

export interface StormReport {
  seconds: number;
  frames: number;
  nanHits: number;
  pOutOfRange: number;
  errors: number;
  ok: boolean;
}

export function runStorm(
  seconds: number,
  getP: () => number,
  checkNaN: () => Promise<boolean>,
  done: (r: StormReport) => void,
): void {
  const t0 = performance.now();
  let frames = 0;
  let nanHits = 0;
  let pOut = 0;
  let errors = 0;
  const onErr = (): void => {
    errors++;
  };
  window.addEventListener('error', onErr);
  const max = document.documentElement.scrollHeight - window.innerHeight;

  let lastNaNCheck = 0;
  const tick = async (): Promise<void> => {
    const t = (performance.now() - t0) / 1000;
    if (t > seconds) {
      window.removeEventListener('error', onErr);
      done({ seconds, frames, nanHits, pOutOfRange: pOut, errors, ok: nanHits === 0 && pOut === 0 && errors === 0 });
      return;
    }
    // thrash: sine sweep + hard jumps + flick reversals
    const phase = t * 7.3;
    let target = 0.5 + 0.5 * Math.sin(phase);
    if (Math.floor(t * 2) % 3 === 1) target = t % 2 < 1 ? 0.05 : 0.95;
    window.scrollTo(0, target * max);
    const p = getP();
    if (p < -1e-6 || p > 1 + 1e-6 || Number.isNaN(p)) pOut++;
    if (t - lastNaNCheck > 1) {
      lastNaNCheck = t;
      if (await checkNaN()) nanHits++;
    }
    frames++;
    requestAnimationFrame(() => void tick());
  };
  requestAnimationFrame(() => void tick());
}

// --- R-flick (§17) ------------------------------------------------------------------------

export interface FlickSample {
  t: number;
  maxRn: number;
}

/** Drives the documented profile through real scrollTo calls; returns target p over time. */
export function flickProfile(t: number): number | null {
  const ramps: Array<[number, number, number, number]> = [
    // [t0, t1, from, to]
    [0.0, 1.0, 0.1, 0.1],
    [1.0, 1.5, 0.1, 0.3],
    [1.5, 3.0, 0.3, 0.3],
    [3.0, 3.18, 0.3, 0.22],
    [3.18, 3.36, 0.22, 0.34],
    [3.36, 3.54, 0.34, 0.26],
    [3.54, 6.54, 0.26, 0.26],
  ];
  for (const [t0, t1, a, b] of ramps) {
    if (t >= t0 && t <= t1) {
      const x = (t - t0) / (t1 - t0 || 1);
      return a + (b - a) * x;
    }
  }
  return t > 6.54 ? null : 0.1;
}

export async function sampleResidualEnergy(
  renderer: WebGPURenderer,
  simRT: RenderTarget,
): Promise<{ maxRn: number; nan: boolean }> {
  const data = (await renderer.readRenderTargetPixelsAsync(simRT, 0, 0, SIM_W, SIM_H)) as
    | Float32Array
    | Uint16Array;
  let maxRn = 0;
  let nan = false;
  // HalfFloat targets read back as Uint16 on some paths; decode if needed.
  const decode = (h: number): number => {
    const s = (h & 0x8000) >> 15;
    const e = (h & 0x7c00) >> 10;
    const f = h & 0x03ff;
    if (e === 0) return (s ? -1 : 1) * 2 ** -14 * (f / 1024);
    if (e === 31) return f ? NaN : (s ? -1 : 1) * Infinity;
    return (s ? -1 : 1) * 2 ** (e - 15) * (1 + f / 1024);
  };
  const isU16 = data instanceof Uint16Array;
  for (let i = 0; i < SIM_W * SIM_H; i++) {
    const raw = data[i * 4 + 2] ?? 0;
    const rn = isU16 ? decode(raw) : raw;
    if (Number.isNaN(rn)) nan = true;
    else maxRn = Math.max(maxRn, Math.abs(rn));
  }
  return { maxRn, nan };
}
