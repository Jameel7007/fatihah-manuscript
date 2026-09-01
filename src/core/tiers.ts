// Quality tiers — §19. Initial heuristic (WebGPU/pointer/deviceMemory/physical resolution),
// then a RUNTIME monitor: demote when the p95 frame time exceeds 1.25× the tier's budget over
// a 3 s window, 10 s hysteresis, applied only at state-boundary crossings so nothing pops
// mid-composition; never auto-promote during a session. Thermal guard: two consecutive demote
// triggers at T3 → halve the DPR once more and stop measuring. `?tier=` overrides for QA.
// Note: iOS Safari exposes no deviceMemory, so phone-class refinement is deliberately
// coarse until the device matrix calibrates it.

export type Tier = 1 | 2 | 3;

export const DPR_CAP: Readonly<Record<Tier, number>> = { 1: 1.75, 2: 2.2, 3: 1.25 };
/** §19 frame-total budgets (ms, p95) */
export const FRAME_BUDGET_MS: Readonly<Record<Tier, number>> = { 1: 12, 2: 14, 3: 27 };
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
  private times: number[] = [];
  private windowS = 3;
  private lastDemoteAt = -1e9;
  private pending: TierChange | null = null;
  private demotesAtT3 = 0;
  private stopped = false;
  private clock = 0;

  constructor(initial: Tier) {
    this.tier = initial;
    this.dprCap = DPR_CAP[initial];
  }

  /** p95 of the current window (ms), for the HUD / perf harness. */
  get p95(): number {
    if (this.times.length < 8) return 0;
    const s = [...this.times].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0;
  }

  update(dtSeconds: number, atBoundary: boolean): TierChange | null {
    if (this.stopped) return null;
    this.clock += dtSeconds;
    const ms = dtSeconds * 1000;
    if (ms > 0 && ms < 250) this.times.push(ms); // ignore tab-hidden gaps
    // keep a 3 s window by frame count at the observed rate
    const frameEstimate = Math.max(8, Math.round(this.windowS / Math.max(1e-3, dtSeconds)));
    while (this.times.length > frameEstimate) this.times.shift();
    if (!this.pending && this.times.length >= 8 && this.clock - this.lastDemoteAt > 10) {
      const budget = FRAME_BUDGET_MS[this.tier];
      if (this.p95 > 1.25 * budget) {
        if (this.tier < 3) this.pending = { tier: (this.tier + 1) as Tier, dprCap: DPR_CAP[(this.tier + 1) as Tier], reason: 'demote' };
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
      if (c.reason === 'thermal') this.stopped = true; // "halve DPR once more and stop measuring"
      return c;
    }
    return null;
  }
}
