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

// §4 checkpoint drivers (columns of the table, exact). v1.3.1 (user direction, tightened):
// the manuscript starts at 82% wrapped — a 4.2-turn roll (outer r 0.0468) with only an
// 18% tongue exposed (10% draped web ≈ one roll diameter + 8% lip). The unroll pays the
// turns out across state 2; terminal residual-curl values are the unchanged contract.
const wTop = pchip(CHECKPOINT_P, [0.82, 0.63, 0.38, 0.13, 0.04]);
const wBot = pchip(CHECKPOINT_P, [0.08, 0.075, 0.062, 0.044, 0.03]);
const rCore = pchip(CHECKPOINT_P, [0.0153, 0.019, 0.026, 0.038, 0.052]);
const sagD = pchip(CHECKPOINT_P, [-0.01, -0.011, -0.011, -0.0075, -0.0035]);

// Bottom C-curl model — three chained circular arcs (ramp → curl → edge). The ramp share
// shrinks as the sheet pays out: the terminal residual is all tight edge-memory curl. Radii
// tuned so the terminal tip lift lands at the §4 value (±0.002); mid-unroll apexes are
// derived and recorded to the spec by the probe harness.
// Tuned slighter (user direction, 2026-08-25): a much flatter entry ramp carries most of
// W_b at p = 0, so the visible hook tops out near ~125° (apex ≈ 0.054) instead of over-
// curling past 180° — a quiet C, not a second roll. Terminal values are unchanged.
const rampFrac = pchip(CHECKPOINT_P, [0.76, 0.68, 0.52, 0.24, 0.0]);
const rampR = pchip(CHECKPOINT_P, [1.8, 1.5, 1.1, 0.6, 0.36]);
const curlR = pchip(CHECKPOINT_P, [0.033, 0.033, 0.033, 0.033, 0.031]);
const edgeR = pchip(CHECKPOINT_P, [0.026, 0.026, 0.027, 0.028, 0.028]);

export const THICKNESS = 0.0009; // §2

// The top roll is a RELAXED spiral: layer spacing 0.0075 (8.3× sheet thickness), so the
// spiral cross-section reads as clearly stacked layers at the roll ends — and the wider
// gap is what lets 4.2 turns still grow the OUTER radius. The terminal residual curl
// (Φ < 1 rad) is insensitive to the gap, so the §4 contract holds.
export const SPIRAL_GAP = 0.0075;
const K_SPIRAL = SPIRAL_GAP / (2 * Math.PI); // Archimedean growth per radian

/** Web sag profile phase — y = sag·sin²(a·x̃) with a = π·(0.72 + 0.28·s). At p = 0 the
 *  profile ends DROOPED (y = 0.593·sag) with an upward slope that hands off C1 into the
 *  lip — the tongue drapes rather than lying flat. At the terminal a = π restores the
 *  symmetric bump (end y = 0), keeping the residual-curl contract exact. */
export function sagPhaseOf(p: number): number {
  const s = Math.max(0, Math.min(1, (p - 0.06) / 0.32));
  return Math.PI * (0.72 + 0.28 * s);
}

/** “Center opens first, sides lag” (§4/state 2): extra wrap held at the sheet edges,
 *  W_eff(u) = W_top + wLag·(2u)², windowed to the unroll so p = 0 and terminal are exact. */
export function wLagOf(p: number): number {
  const s = Math.max(0, Math.min(1, (p - 0.06) / 0.32));
  return 0.035 * Math.sin(Math.PI * s);
}

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
  /** edges-lag extra wrap coefficient — W_eff(u) = wTop + wLag·(2u)² */
  wLag: number;
  rCore: number;
  /** total wrap angle of the top roll at u = 0 */
  phiTop: number;
  /** outer radius of the top roll at u = 0 */
  rOuter: number;
  /** top roll center in (z, y) at u = 0 (shader recomputes per-u for the lag term) */
  topC: [number, number];
  /** z of the top curl line at u = 0 (= wTop − 0.5, static anchor z = v − 0.5) */
  zTopCurl: number;
  /** z of the bottom curl line (= 0.5 − wBot) */
  zBotCurl: number;
  sag: number;
  /** web sag profile phase a — y = sag·sin²(a·x̃) */
  sagA: number;
  cup: number;
  twist: number;
  bottom: ArcPhase[];
  /** derived: tip heights + turn count (probe / spec record) */
  derived: { topTipLift: number; botTipLift: number; botApex: number; turns: number };
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

  // Bottom curl: three chained arcs starting at the curl line, C1 with the draped web —
  // the chain inherits the web profile's end height and end slope (u = 0; the lag term is
  // zero at the curl-line handoff scale and the lip is u-uniform by design).
  const zBotCurl = 0.5 - wb;
  const sag = sagD(p);
  const sagA = sagPhaseOf(p);
  const webLen = Math.max(1e-4, 1 - wt - wb);
  const webEndY = sag * Math.sin(sagA) ** 2;
  const webEndSlope = (sag * sagA * Math.sin(2 * sagA)) / webLen;
  const fr = Math.max(0, Math.min(1, rampFrac(p)));
  const lRamp = fr * wb;
  const lCurl = (1 - fr) * 0.6 * wb;
  const lEdge = (1 - fr) * 0.4 * wb;
  const phases: ArcPhase[] = [];
  let cz = zBotCurl;
  let cy = webEndY;
  let ca = Math.atan(webEndSlope);
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
    wLag: wLagOf(p),
    rCore: rc,
    phiTop,
    rOuter,
    topC,
    zTopCurl,
    zBotCurl,
    sag,
    sagA,
    cup,
    twist: 0.006,
    bottom: phases,
    derived: { topTipLift, botTipLift, botApex, turns: phiTop / (2 * Math.PI) },
  };
}
