// Quality tiers — §19. Initial heuristic only; runtime demotion (p95 frame-time monitor,
// state-boundary application, thermal guard) arrives in M7. `?tier=` overrides for QA.
// Note: iOS Safari exposes no deviceMemory, so phone-class refinement is deliberately
// coarse until the M7 device matrix calibrates it.

export type Tier = 1 | 2 | 3;

export const DPR_CAP: Readonly<Record<Tier, number>> = { 1: 1.75, 2: 2.2, 3: 1.25 };

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
