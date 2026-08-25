// Easing registry — spec §13. Every curve used anywhere in the piece is named here.

/** CSS-compatible cubic-bezier(x1, y1, x2, y2) evaluator: x = time, returns eased value. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) return sampleY(t);
      const d = sampleDX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    while (hi - lo > 1e-6) {
      if (sampleX(t) < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

export const E1 = cubicBezier(0.65, 0, 0.35, 1); // camera glides, env yaw
export const E2 = cubicBezier(0.22, 0, 0.18, 1); // emboss, pose-tilt settle, gold
export const E3 = cubicBezier(0.4, 0, 1.0, 0.8); // lagging followers
export const E4 = E2; // extrusion rise — no overshoot by decree
export const E6 = cubicBezier(0.3, 0, 0.12, 1); // text pivot + lift
export const E7 = cubicBezier(0.37, 0, 0.63, 1); // emboss fade in handoff window
export const EUnroll = cubicBezier(0.42, 0, 0.16, 1);

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Normalized position of p inside [a, b], clamped. */
export const span = (p: number, a: number, b: number): number => clamp01((p - a) / (b - a));
