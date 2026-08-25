// CPU mirror of the shader pose (field.ts poseNodes) — the probe oracle. Keep in lockstep
// with the TSL math; the probe harness compares GPU readbacks against this to ±0.0015 and
// GPU FD normals against the analytic normal to ≤2°.

import { THICKNESS, type DeformState } from './deform';

const SHEET_W = 0.78;
const K = THICKNESS / (2 * Math.PI);

export interface PosePoint {
  x: number;
  y: number;
  z: number;
  /** analytic profile normal (unit, x = 0 before cup/twist perturbation) */
  nx: number;
  ny: number;
  nz: number;
}

export function cpuPose(u: number, v: number, d: DeformState): PosePoint {
  let z: number;
  let y: number;
  let a: number;

  if (v < d.wTop) {
    const theta = (-d.rCore + Math.sqrt(d.rCore * d.rCore + 2 * K * Math.max(v, 0))) / K;
    const rho = d.rCore + K * theta;
    const psi = d.phiTop - theta;
    z = d.topC[0] - rho * Math.sin(psi);
    y = d.topC[1] - rho * Math.cos(psi);
    a = -psi;
  } else if (v >= 1 - d.wBot) {
    const sB = v - (1 - d.wBot);
    let zz = 0;
    let yy = 0;
    let aa = 0;
    let rem = sB;
    for (let i = 0; i < d.bottom.length; i++) {
      const ph = d.bottom[i];
      if (!ph) break;
      const sLocal = Math.max(0, Math.min(rem, ph.len));
      const a1 = ph.alpha + ph.kappa * sLocal;
      zz = ph.sz + (Math.sin(a1) - Math.sin(ph.alpha)) / ph.kappa;
      yy = ph.sy - (Math.cos(a1) - Math.cos(ph.alpha)) / ph.kappa;
      aa = a1;
      rem -= ph.len;
      if (rem <= 0) break;
    }
    z = zz;
    y = yy;
    a = aa;
  } else {
    const webLen = 1 - d.wTop - d.wBot;
    const xw = Math.max(0, Math.min(1, (v - d.wTop) / webLen));
    z = v - 0.5;
    y = d.sag * Math.sin(Math.PI * xw) ** 2;
    a = (d.sag * Math.PI * Math.sin(2 * Math.PI * xw)) / webLen;
  }

  const nz = -Math.sin(a);
  const ny = Math.cos(a);
  const att = Math.max(0.3, Math.min(1, 1 - (Math.abs(a) / Math.PI) * 0.6));
  const lateral = u * 2;
  const dn = (d.cup * lateral * lateral + d.twist * lateral * (v * 2 - 1)) * att;

  return {
    x: u * SHEET_W,
    y: y + dn * ny,
    z: z + dn * nz,
    nx: 0,
    ny,
    nz,
  };
}
