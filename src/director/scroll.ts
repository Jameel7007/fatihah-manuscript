// Scroll → uP smoothing — §13: critically damped spring k = 110 s⁻², c = 21 s⁻¹,
// velocity LPF τ = 140 ms. Reduced motion hardens to a τ = 60 ms first-order lag.
//
// Writing dwell (review, 2026-08-27): the raw scroll fraction passes through a density
// remap that slows p across the §10 write span [0.30, 0.62] by ×2.0 (was ×1.35) — the writing takes
// ~35% more scroll travel while every window stays §10-exact in p. The spacer scales by
// the total density so scroll feel OUTSIDE the dwell is unchanged. Capture mode pins p
// directly and never touches the remap (blessed frames unaffected).

const DWELL = 2.4; // 2026-09-19 ×1.35 → ×2.0 ("slow down the writing"); 2026-09-21 → ×2.4 ("slow both down")
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

/** v1.8.0 staged asset limits: p stops just short of the first written stroke (§10 write span
 *  opens at 0.30) until the ink has attached, and just short of the emboss (0.64) until the
 *  relief has. qa/spacer.test.mjs checks both sit before anything they would hide. */
export const INK_NEEDED_P = 0.295;
export const RELIEF_NEEDED_P = 0.635;

export class ScrollDriver {
  p = 0;
  target = 0;
  /** Low-passed dp/dt — feeds the residual sim (M1+). */
  vLpf = 0;
  /** Capture mode pins p directly and zeroes all dynamics. */
  forced: number | null = null;
  /** Furthest p the loaded assets can show (v1.8.0): the unroll always scrolls, the writing
   *  waits only for the ink, the rise only for the relief. 1 once everything has attached. */
  limit = 1;
  /** The reader's scroll position as p, before the asset limit — drives the "still arriving" note. */
  wanted = 0;

  /** v1.8.1 speed limit on p (per second): a hard flick or a lifted asset limit glides instead of racing. */
  vMax = 0.8;
  /** v1.8.1 the viewport height the scroll range is measured against. Phones pass the large viewport
   *  (100lvh), which does not change when the browser toolbar slides, so p does not jump with it. */
  viewportHeight: () => number = () => window.innerHeight;

  private v = 0;
  private forcedPrev: number | null = null;
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** Jump straight to the reader's position (no glide) — used once, under the poster crossfade. */
  snapToTarget(): void {
    if (this.forced !== null) return;
    this.measure();
    this.p = this.target;
    this.v = 0;
    this.vLpf = 0;
  }

  private measure(): void {
    const max = document.documentElement.scrollHeight - this.viewportHeight();
    this.wanted = max > 0 ? scrollToP(window.scrollY / max) : 0;
    this.target = Math.min(this.limit, this.wanted);
  }

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
    this.measure();

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
      this.v = Math.max(-this.vMax, Math.min(this.vMax, this.v));
      this.p += this.v * dt;
    }
    this.p = Math.min(1, Math.max(0, this.p));
    this.vLpf += (this.v - this.vLpf) * (1 - Math.exp(-dt / 0.14));
  }
}
