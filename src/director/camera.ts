// Camera rig — §9. Position and look-at ride centripetal Catmull-Rom splines through the
// anchor table; the look-at consumes a separately lagged p (τ = 80 ms) so gaze trails the
// dolly. M0 maps p linearly inside each anchor segment; per-segment feel is tuned in M4,
// which owns the pose-tolerance validation.

import { CatmullRomCurve3, PerspectiveCamera, Vector3 } from 'three/webgpu';

interface Anchor {
  p: number;
  focal: number; // mm, 35mm-equivalent; vfov = 2·atan(12/f) at the 1440×900 reference
  pos: Vector3;
  look: Vector3;
}

const ANCHORS: readonly Anchor[] = [
  { p: 0.0, focal: 40, pos: new Vector3(0.44, 0.33, 0.64), look: new Vector3(0.01, 0.04, -0.05) },
  { p: 0.21, focal: 42, pos: new Vector3(0.27, 0.46, 0.55), look: new Vector3(0.0, 0.02, 0.01) },
  { p: 0.34, focal: 46, pos: new Vector3(0.1, 0.6, 0.42), look: new Vector3(0.0, 0.012, 0.03) },
  { p: 0.47, focal: 50, pos: new Vector3(0.02, 0.74, 0.26), look: new Vector3(0.0, 0.008, 0.045) },
  { p: 0.6, focal: 55, pos: new Vector3(0.0, 0.88, 0.09), look: new Vector3(0.0, 0.0, 0.018) },
  { p: 0.7, focal: 55, pos: new Vector3(0.0, 0.76, 0.24), look: new Vector3(0.0, 0.02, 0.01) },
  { p: 0.8, focal: 57, pos: new Vector3(0.0, 0.52, 0.47), look: new Vector3(0.0, 0.09, -0.01) },
  { p: 0.9, focal: 60, pos: new Vector3(0.0, 0.33, 0.6), look: new Vector3(0.0, 0.15, -0.03) },
  { p: 1.0, focal: 62, pos: new Vector3(0.0, 0.255, 0.66), look: new Vector3(0.0, 0.185, -0.045) },
];

/** Segment index + local 0..1 position for a given p. */
function segment(p: number): { i: number; u: number } {
  const n = ANCHORS.length;
  for (let i = n - 2; i >= 0; i--) {
    const a = ANCHORS[i];
    const b = ANCHORS[i + 1];
    if (a && b && p >= a.p) {
      const u = (p - a.p) / (b.p - a.p);
      return { i, u: Math.min(1, Math.max(0, u)) };
    }
  }
  return { i: 0, u: 0 };
}

function curveT(p: number): number {
  const { i, u } = segment(p);
  return (i + u) / (ANCHORS.length - 1);
}

function focalAt(p: number): number {
  const { i, u } = segment(p);
  const a = ANCHORS[i];
  const b = ANCHORS[i + 1];
  if (!a) return 40;
  if (!b) return a.focal;
  return a.focal + (b.focal - a.focal) * u;
}

export class CameraRig {
  readonly camera = new PerspectiveCamera(30, 16 / 9, 0.05, 4.0);

  private readonly posCurve = new CatmullRomCurve3(
    ANCHORS.map((a) => a.pos),
    false,
    'centripetal',
  );
  private readonly lookCurve = new CatmullRomCurve3(
    ANCHORS.map((a) => a.look),
    false,
    'centripetal',
  );
  private pLook = 0;
  private readonly lookTarget = new Vector3();

  update(p: number, dt: number): void {
    this.pLook += (p - this.pLook) * (dt > 0 ? 1 - Math.exp(-dt / 0.08) : 0);
    this.posCurve.getPoint(curveT(p), this.camera.position);
    this.lookCurve.getPoint(curveT(this.pLook), this.lookTarget);
    this.camera.lookAt(this.lookTarget);
    this.camera.fov = (2 * Math.atan(12 / focalAt(p)) * 180) / Math.PI;
    this.camera.updateProjectionMatrix();
  }

  /** Capture mode: no trailing gaze — pose must be a pure function of p. */
  snap(p: number): void {
    this.pLook = p;
    this.update(p, 0);
  }
}
