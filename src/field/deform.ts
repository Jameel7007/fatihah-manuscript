// Deform drivers — §4/§17. All CPU-side: every value here is a pure function of p, and the
// GPU passes receive only finished numbers. The §4 checkpoint table is the contract, so the
// driver curves are monotone cubics (Fritsch–Carlson) THROUGH the checkpoints — the table is
// exact by construction. Derived quantities (edge-tip lift, curl apex) fall out of the model
// and are recorded back into the spec by the probe harness.

export const CHECKPOINT_P = [0.06, 0.14, 0.22, 0.3, 0.38] as const;

/** Monotone cubic (PCHIP / Fritsch–Carlson) through checkpoints; clamped outside. */
export function pchip(xs: readonly number[], ys: readonly number[]): (x: number) => number {
  const n = xs.length;
  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const hx = (xs[i + 1] ?? 0) - (xs[i] ?? 0);
    h.push(hx);
    d.push(((ys[i + 1] ?? 0) - (ys[i] ?? 0)) / hx);
  }
  const m: number[] = [d[0] ?? 0];
  for (let i = 1; i < n - 1; i++) {
    const d0 = d[i - 1] ?? 0;
    const d1 = d[i] ?? 0;
    if (d0 * d1 <= 0) m.push(0);
    else {
      const h0 = h[i - 1] ?? 1;
      const h1 = h[i] ?? 1;
      const w1 = 2 * h1 + h0;
      const w2 = h1 + 2 * h0;
      m.push((w1 + w2) / (w1 / d0 + w2 / d1));
    }
  }
  m.push(d[n - 2] ?? 0);
  return (x: number): number => {
    const x0 = xs[0] ?? 0;
    const xn = xs[n - 1] ?? 0;
    if (x <= x0) return ys[0] ?? 0;
    if (x >= xn) return ys[n - 1] ?? 0;
    let i = 0;
    while (i < n - 2 && x > (xs[i + 1] ?? 0)) i++;
    const t = (x - (xs[i] ?? 0)) / (h[i] ?? 1);
    const y0 = ys[i] ?? 0;
    const y1 = ys[i + 1] ?? 0;
    const hi = h[i] ?? 1;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      y0 * (2 * t3 - 3 * t2 + 1) +
      (m[i] ?? 0) * hi * (t3 - 2 * t2 + t) +
      y1 * (-2 * t3 + 3 * t2) +
      (m[i + 1] ?? 0) * hi * (t3 - t2)
    );
  };
}

// §4 checkpoint drivers (columns of the table, exact).
const wTop = pchip(CHECKPOINT_P, [0.34, 0.238, 0.126, 0.048, 0.04]);
const wBot = pchip(CHECKPOINT_P, [0.26, 0.221, 0.156, 0.078, 0.03]);
const rCore = pchip(CHECKPOINT_P, [0.0285, 0.0334, 0.0398, 0.0465, 0.052]);
const sagD = pchip(CHECKPOINT_P, [-0.0118, -0.0102, -0.0079, -0.0058, -0.0035]);

// Bottom C-curl model — three chained circular arcs (ramp → curl → edge). The ramp share
// shrinks as the sheet pays out: the terminal residual is all tight edge-memory curl. Radii
// tuned so the terminal tip lift lands at the §4 value (±0.002); mid-unroll apexes are
// derived and recorded to the spec by the probe harness.
const rampFrac = pchip(CHECKPOINT_P, [0.55, 0.5, 0.4, 0.2, 0.0]);
const rampR = pchip(CHECKPOINT_P, [0.8, 0.72, 0.6, 0.45, 0.36]);
const curlR = pchip(CHECKPOINT_P, [0.034, 0.034, 0.034, 0.033, 0.031]);
const edgeR = pchip(CHECKPOINT_P, [0.026, 0.026, 0.027, 0.028, 0.028]);

export const THICKNESS = 0.0009; // §2
const K_SPIRAL = THICKNESS / (2 * Math.PI); // Archimedean growth per radian

export interface ArcPhase {
  /** start point in (z, y) */
  sz: number;
  sy: number;
  /** start tangent angle (0 = +z, positive lifts toward +y) */
  alpha: number;
  /** curvature 1/R (positive curls upward) */
  kappa: number;
  /** arc length of this phase */
  len: number;
  /** cumulative arc length at phase start (from bottom curl line) */
  s0: number;
}

export interface DeformState {
  p: number;
  wTop: number;
  wBot: number;
  rCore: number;
  /** total wrap angle of the top roll */
  phiTop: number;
  /** outer radius of the top roll */
  rOuter: number;
  /** top roll center in (z, y) */
  topC: [number, number];
  /** z of the top curl line (= wTop − 0.5, static anchor z = v − 0.5) */
  zTopCurl: number;
  /** z of the bottom curl line (= 0.5 − wBot) */
  zBotCurl: number;
  sag: number;
  cup: number;
  twist: number;
  bottom: ArcPhase[];
  /** derived: tip heights above the plane (probe / spec record) */
  derived: { topTipLift: number; botTipLift: number; botApex: number };
}

/** Chain a circular arc: given start (z, y, alpha), curvature k, length L → end pose. */
function arcEnd(
  sz: number,
  sy: number,
  alpha: number,
  kappa: number,
  len: number,
): { z: number; y: number; alpha: number } {
  const a1 = alpha + kappa * len;
  const z = sz + (Math.sin(a1) - Math.sin(alpha)) / kappa;
  const y = sy - (Math.cos(a1) - Math.cos(alpha)) / kappa;
  return { z, y, alpha: a1 };
}

/** Point at local arc length s within a phase. */
export function arcPoint(ph: ArcPhase, s: number): { z: number; y: number } {
  const a1 = ph.alpha + ph.kappa * s;
  return {
    z: ph.sz + (Math.sin(a1) - Math.sin(ph.alpha)) / ph.kappa,
    y: ph.sy - (Math.cos(a1) - Math.cos(ph.alpha)) / ph.kappa,
  };
}

export function evalDeform(p: number): DeformState {
  const wt = wTop(p);
  const wb = wBot(p);
  const rc = rCore(p);

  // Top roll: solve wrapped length = rc·Φ + K/2·Φ² for Φ (quadratic, positive root).
  const phiTop = (-rc + Math.sqrt(rc * rc + 2 * K_SPIRAL * wt)) / K_SPIRAL;
  const rOuter = rc + K_SPIRAL * phiTop;
  const zTopCurl = wt - 0.5;
  const topC: [number, number] = [zTopCurl, rOuter]; // center sits one outer radius above the curl line

  // Bottom curl: three chained arcs starting at the curl line, tangent to the flat web.
  const zBotCurl = 0.5 - wb;
  const fr = Math.max(0, Math.min(1, rampFrac(p)));
  const lRamp = fr * wb;
  const lCurl = (1 - fr) * 0.6 * wb;
  const lEdge = (1 - fr) * 0.4 * wb;
  const phases: ArcPhase[] = [];
  let cz = zBotCurl;
  let cy = 0;
  let ca = 0;
  let s0 = 0;
  const defs: Array<[number, number]> = [
    [lRamp, 1 / rampR(p)],
    [lCurl, 1 / curlR(p)],
    [lEdge, 1 / edgeR(p)],
  ];
  for (const [len, kappa] of defs) {
    if (len <= 1e-6) continue;
    phases.push({ sz: cz, sy: cy, alpha: ca, kappa, len, s0 });
    const e = arcEnd(cz, cy, ca, kappa, len);
    cz = e.z;
    cy = e.y;
    ca = e.alpha;
    s0 += len;
  }

  // Derived record values (§4 correction cells).
  const topTipLift = rc > 0 ? topC[1] - rc * Math.cos(phiTop) : 0; // y of the v=0 tip
  const botTipLift = cy;
  let botApex = 0;
  for (const ph of phases) {
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
      botApex = Math.max(botApex, arcPoint(ph, (ph.len * i) / steps).y);
    }
  }

  const cup = 0.009 + (0.004 - 0.009) * Math.max(0, Math.min(1, (p - 0.1) / 0.3));

  return {
    p,
    wTop: wt,
    wBot: wb,
    rCore: rc,
    phiTop,
    rOuter,
    topC,
    zTopCurl,
    zBotCurl,
    sag: sagD(p),
    cup,
    twist: 0.006,
    bottom: phases,
    derived: { topTipLift, botTipLift, botApex },
  };
}
