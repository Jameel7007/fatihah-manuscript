// §15 idle micro-motion — arms after 4 s of stillness (no scroll velocity, no pointer
// motion), ramps in over 2 s, and is zeroed in reduced motion and in capture mode.
//   parchment breath via the residual field     amp 2.5e-4 world, 0.10 Hz
//   key intensity                                ±1.5 % over 9 s
//   environment yaw                              ±2° over 14 s
//   camera position drift                        0.002 world, ~0.07 Hz (sum of incommensurate sines — a
//                                                deterministic stand-in for simplex noise)
// Everything is a pure function of the idle clock, so the held ending is quiet and never
// accumulates: total luminance flux drift stays ≤ 2 % by construction (the key term).

export interface IdleState {
  /** 0..1 ramp — 0 while moving or before arming */
  ramp: number;
  /** signed breath amplitude (world) */
  breath: number;
  /** multiplicative key modulation (1 ± 0.015) */
  keyMod: number;
  /** additive env yaw (degrees) */
  yawDeg: number;
  /** camera position drift (world) */
  drift: [number, number, number];
}

const ARM_S = 4;
const RAMP_S = 2;

export class IdleController {
  private still = 0; // seconds of stillness
  private t = 0; // idle clock (runs only while armed, so re-arming restarts the phase softly)
  private enabled = true;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  /** `moving`: scroll velocity or pointer motion this frame. */
  update(dt: number, moving: boolean): IdleState {
    const zero: IdleState = { ramp: 0, breath: 0, keyMod: 1, yawDeg: 0, drift: [0, 0, 0] };
    if (!this.enabled) return zero;
    if (moving) {
      this.still = 0;
      return zero;
    }
    this.still += dt;
    if (this.still < ARM_S) return zero;
    this.t += dt;
    const ramp = Math.min(1, (this.still - ARM_S) / RAMP_S);
    const s = ramp * ramp * (3 - 2 * ramp);
    const w = 2 * Math.PI;
    return {
      ramp: s,
      breath: 2.5e-4 * s * Math.sin(w * 0.1 * this.t),
      keyMod: 1 + 0.015 * s * Math.sin((w * this.t) / 9),
      yawDeg: 2 * s * Math.sin((w * this.t) / 14),
      drift: [
        0.002 * s * (0.6 * Math.sin(w * 0.07 * this.t) + 0.4 * Math.sin(w * 0.043 * this.t + 1.3)),
        0.002 * s * (0.6 * Math.sin(w * 0.061 * this.t + 2.1) + 0.4 * Math.sin(w * 0.037 * this.t)),
        0.002 * s * (0.6 * Math.sin(w * 0.053 * this.t + 0.7) + 0.4 * Math.sin(w * 0.079 * this.t + 2.9)),
      ],
    };
  }
}
