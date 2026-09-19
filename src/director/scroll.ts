// Scroll → uP smoothing — §13: critically damped spring k = 110 s⁻², c = 21 s⁻¹,
// velocity LPF τ = 140 ms. Reduced motion hardens to a τ = 60 ms first-order lag.
//
// Writing dwell (review, 2026-08-27): the raw scroll fraction passes through a density
// remap that slows p across the §10 write span [0.30, 0.62] by ×2.0 (was ×1.35) — the writing takes
// ~35% more scroll travel while every window stays §10-exact in p. The spacer scales by
// the total density so scroll feel OUTSIDE the dwell is unchanged. Capture mode pins p
// directly and never touches the remap (blessed frames unaffected).

const DWELL = 2.0; // 2026-09-19 (owner: "slow down the writing"): ×1.35 → ×2.0, the writing takes ~48% more scroll travel
const DWELL_A = 0.3;
const DWELL_B = 0.62;
const DWELL_F = 0.03; // feather
const sstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const density = (p: number): number =>
  1 + (DWELL - 1) * (sstep(DWELL_A - DWELL_F, DWELL_A + DWELL_F, p) - sstep(DWELL_B - DWELL_F, DWELL_B + DWELL_F, p));

const LUT_N = 512;
const cum = new Float64Array(LUT_N + 1);
for (let i = 1; i <= LUT_N; i++) cum[i] = cum[i - 1]! + density((i - 0.5) / LUT_N) / LUT_N;

/** Total scroll-density integral — the spacer multiplies its base height by this. */
export const SCROLL_DENSITY_TOTAL = cum[LUT_N]!;

/** Inverse map: scroll fraction s ∈ [0,1] → p (monotone, C¹ via the feathered density). */
export function scrollToP(s: number): number {
  const t = Math.min(1, Math.max(0, s)) * cum[LUT_N]!;
  let lo = 0;
  let hi = LUT_N;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= t) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi]! - cum[lo]! || 1e-9;
  return (lo + (t - cum[lo]!) / seg) / LUT_N;
}

export class ScrollDriver {
  p = 0;
  target = 0;
  /** Low-passed dp/dt — feeds the residual sim (M1+). */
  vLpf = 0;
  /** Capture mode pins p directly and zeroes all dynamics. */
  forced: number | null = null;

  private v = 0;
  private forcedPrev: number | null = null;
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  update(dtRaw: number): void {
    if (this.forced !== null) {
      const prev = this.forcedPrev ?? this.forced;
      this.p = this.forced;
      this.target = this.forced;
      this.v = dtRaw > 0 ? (this.forced - prev) / dtRaw : 0;
      this.vLpf += (this.v - this.vLpf) * (dtRaw > 0 ? 1 - Math.exp(-dtRaw / 0.06) : 0);
      this.forcedPrev = this.forced;
      return;
    }
    this.forcedPrev = null;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    this.target = max > 0 ? scrollToP(window.scrollY / max) : 0;

    const dt = Math.min(dtRaw, 1 / 30);
    if (dt <= 0) return;

    if (this.reduced) {
      const k = 1 - Math.exp(-dt / 0.06);
      const prev = this.p;
      this.p += (this.target - this.p) * k;
      this.v = (this.p - prev) / dt;
    } else {
      const a = 110 * (this.target - this.p) - 21 * this.v;
      this.v += a * dt;
      this.p += this.v * dt;
    }
    this.p = Math.min(1, Math.max(0, this.p));
    this.vLpf += (this.v - this.vLpf) * (1 - Math.exp(-dt / 0.14));
  }
}
