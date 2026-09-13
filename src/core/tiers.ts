// Quality tiers — §19. Initial heuristic (WebGPU/pointer/deviceMemory/physical resolution),
// then a RUNTIME pacing monitor: demote when p95 rAF interval exceeds 1.25× the playback interval over
// a 3 s window, 10 s hysteresis, applied only at state-boundary crossings so nothing pops
// mid-composition; never auto-promote during a session. Thermal guard: two consecutive demote
// triggers at T3 → halve the DPR once more and stop measuring. `?tier=` overrides for QA.
// Note: iOS Safari exposes no deviceMemory, so phone-class refinement is deliberately
// coarse until the device matrix calibrates it.

export type Tier = 1 | 2 | 3;

// v1.6.1: T1 cap 1.75 → 2.0 — on a DPR-2 laptop the gilding's crest highlights are 1–2 px
// wide, and shading is evaluated once per pixel (MSAA only supersamples edges); rendering
// at the native 2× is the cheapest smoothing there is. The monitor still demotes if it costs.
export const DPR_CAP: Readonly<Record<Tier, number>> = { 1: 2.0, 2: 2.2, 3: 1.25 };
/** §19 frame-total budgets (ms, p95) */
export const FRAME_BUDGET_MS: Readonly<Record<Tier, number>> = { 1: 12, 2: 14, 3: 27 };
/** §19 playback targets: display intervals include vsync wait, unlike frame-work budgets.
 * These govern runtime fallback only and never certify FRAME_BUDGET_MS. */
export const PACING_BUDGET_MS: Readonly<Record<Tier, number>> = { 1: 1000 / 60, 2: 1000 / 60, 3: 1000 / 30 };
/** §19 dust population per tier (fraction of the authored 640) */
export const DUST_SCALE: Readonly<Record<Tier, number>> = { 1: 1, 2: 0.55, 3: 0 };

export function detectTier(override: string | null): Tier {
  if (override === '1' || override === '2' || override === '3') return Number(override) as Tier;
  const coarse = matchMedia('(pointer: coarse)').matches;
  if (!coarse) return 1;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (mem !== undefined) return mem >= 6 ? 2 : 3;
  // iOS: no deviceMemory — use device-pixel budget as a proxy (iPhone 12+ class ≥ 2.5M px @3x).
  const px = screen.width * screen.height * devicePixelRatio * devicePixelRatio;
  return px >= 2_400_000 ? 2 : 3;
}

export interface TierChange {
  tier: Tier;
  dprCap: number;
  reason: 'demote' | 'thermal';
}

/** Runtime tier monitor (§19 "Tier logic"). Feed every live frame; apply the returned change
 *  only when `atBoundary` is true (a state-boundary crossing). Deterministic given the same
 *  frame-time sequence; disabled entirely in capture mode. */
export class TierMonitor {
  tier: Tier;
  dprCap: number;
  private times: Array<{ at: number; ms: number }> = [];
  private windowS = 3;
  private lastDemoteAt = -1e9;
  private pending: TierChange | null = null;
  private demotesAtT3 = 0;
  private stopped = false;
  private clock = 0;
  private windowElapsed = 0;

  constructor(initial: Tier) {
    this.tier = initial;
    this.dprCap = DPR_CAP[initial];
  }

  /** p95 of the current window (ms), for the HUD / perf harness. */
  get p95(): number {
    if (this.times.length < 8) return 0;
    const s = this.times.map(sample => sample.ms).sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0;
  }

  update(dtSeconds: number, atBoundary: boolean): TierChange | null {
    if (this.stopped) return null;
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return null;
    this.clock += dtSeconds;
    this.windowElapsed = Math.min(this.windowS, this.windowElapsed + dtSeconds);
    const ms = dtSeconds * 1000;
    if (ms < 250) this.times.push({ at: this.clock, ms }); // existing gap policy; visibility handling remains separate
    // Use elapsed time, not the latest frame's rate. A single slow frame must not
    // shrink three seconds of history to a handful of samples and inflate p95.
    while (this.times.length && this.times[0]!.at <= this.clock - this.windowS) this.times.shift();
    if (!this.pending && this.windowElapsed >= this.windowS && this.times.length >= 8 && this.clock - this.lastDemoteAt > 10) {
      const budget = PACING_BUDGET_MS[this.tier];
      if (this.p95 > 1.25 * budget) {
        if (this.tier < 3) this.pending = { tier: (this.tier + 1) as Tier, dprCap: Math.min(this.dprCap, DPR_CAP[(this.tier + 1) as Tier]), reason: 'demote' };
        else {
          this.demotesAtT3++;
          if (this.demotesAtT3 >= 2) {
            this.pending = { tier: 3, dprCap: this.dprCap / 2, reason: 'thermal' };
          }
        }
        this.lastDemoteAt = this.clock;
      }
    }
    if (this.pending && atBoundary) {
      const c = this.pending;
      this.pending = null;
      this.tier = c.tier;
      this.dprCap = c.dprCap;
      this.times.length = 0;
      this.windowElapsed = 0;
      if (c.reason === 'thermal') this.stopped = true; // "halve DPR once more and stop measuring"
      return c;
    }
    return null;
  }
}
