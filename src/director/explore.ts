// Explore — the held ending in the visitor's hands. Armed automatically on arrival at the ending
// (it settles with one gentle turn so the eye learns it can move), dragging on the canvas turns the standing gold block: yaw about its vertical axis,
// a little pitch about its horizontal one, with inertia and damping. Leaving the ending, or
// switching it off, eases the block back to its authored pose. Pure input state: the rig's
// capture/hold modes never arm it, so reference frames are unaffected.

const YAW_PER_PX = 0.0038; // radians per CSS pixel of drag
const PITCH_PER_PX = 0.0032;
const YAW_LIMIT = 1.22; // ±70° — a gilded plaque seen past edge-on is a dark sliver; keep it in the light
const PITCH_LIMIT = 0.45; // ±26°
const INERTIA_TAU = 0.22; // s — a short glide after release, never a spin
const V_LIMIT = 2.2; // rad/s
const RETURN_TAU = 0.32; // s — ease back to the authored pose

export class Explore {
  armed = false;
  yaw = 0;
  pitch = 0;
  private vy = 0;
  private vp = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private lastT = 0;
  private moved = 0;
  private onChange: (armed: boolean) => void;
  /** the settle: on arrival the block turns a few degrees and eases back, once — "I can be moved" */
  private nudgeT = -1; // seconds into the nudge; −1 = none
  private nudgeOn = true;
  private turnedOnce = false;
  onFirstTurn: (() => void) | null = null;

  constructor(private canvas: HTMLCanvasElement, onChange: (armed: boolean) => void) {
    this.onChange = onChange;
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.armed || e.button !== 0) return;
      this.dragging = true;
      this.nudgeT = -1; // a hand on it ends the settle
      this.moved = 0;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.lastT = performance.now();
      this.vy = 0;
      this.vp = 0;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const now = performance.now();
      const dt = Math.max(1e-3, (now - this.lastT) / 1000);
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.moved += Math.abs(dx) + Math.abs(dy);
      if (!this.turnedOnce && this.moved > 24) { this.turnedOnce = true; this.onFirstTurn?.(); }
      this.yaw = Math.max(-YAW_LIMIT, Math.min(YAW_LIMIT, this.yaw + dx * YAW_PER_PX));
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + dy * PITCH_PER_PX));
      this.vy = Math.max(-V_LIMIT, Math.min(V_LIMIT, (dx * YAW_PER_PX) / dt));
      this.vp = Math.max(-V_LIMIT, Math.min(V_LIMIT, (dy * PITCH_PER_PX) / dt));
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.lastT = now;
      e.preventDefault();
    });
    const end = () => {
      if (!this.dragging) return;
      this.dragging = false;
      canvas.style.cursor = this.armed ? 'grab' : '';
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  /** Arm or disarm; horizontal touch panning on the canvas is claimed while armed. */
  setArmed(on: boolean): void {
    if (this.armed === on) return;
    this.armed = on;
    this.nudgeT = on && this.nudgeOn ? 0 : -1;
    // pan-y: a sideways drag turns the block; a vertical swipe still scrolls (and leaving disarms)
    this.canvas.style.touchAction = on ? 'pan-y' : '';
    this.canvas.style.cursor = on ? 'grab' : '';
    if (!on) this.dragging = false;
    this.onChange(on);
  }

  /** Reduced motion: no settle nudge (the cue text still shows). */
  setNudge(on: boolean): void { this.nudgeOn = on; }

  /** Per frame. `atEnding` is false once the reader scrolls back, which disarms and returns. */
  update(dt: number, atEnding: boolean): void {
    if (this.armed && !atEnding) this.setArmed(false);
    if (this.armed && this.nudgeT >= 0) {
      // one slow breath: 0 → +9° → 0 over 2.6 s, soft at both ends
      const T = 2.6;
      this.nudgeT += dt;
      const u = Math.min(1, this.nudgeT / T);
      const e = u * u * (3 - 2 * u);
      this.yaw = 0.16 * Math.sin(Math.PI * e);
      this.pitch = 0;
      if (u >= 1) { this.nudgeT = -1; this.yaw = 0; }
      return;
    }
    if (this.armed) {
      if (!this.dragging) {
        const k = Math.exp(-dt / INERTIA_TAU);
        this.yaw = Math.max(-YAW_LIMIT, Math.min(YAW_LIMIT, this.yaw + this.vy * dt));
        this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + this.vp * dt));
        this.vy *= k;
        this.vp *= k;
      }
    } else if (this.yaw !== 0 || this.pitch !== 0) {
      const k = Math.exp(-dt / RETURN_TAU);
      this.yaw *= k;
      this.pitch *= k;
      if (Math.abs(this.yaw) < 1e-4 && Math.abs(this.pitch) < 1e-4) { this.yaw = 0; this.pitch = 0; }
    }
  }
}
