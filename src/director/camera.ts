// Camera rig — §9. Position and look-at ride centripetal Catmull-Rom splines through the
// anchor table; the look-at consumes a separately lagged p (τ = 80 ms) so gaze trails the
// dolly. Across states 1–2 the DISTANCE is not the anchors' — it is driven by the sheet's
// actual posed extent (§9 v1.3.2): a closed-form fit of the sampled sheet bounds inside the
// viewport at constant margin, along the anchors' ¾ direction, precomputed over p per
// aspect, running-max'd and Gaussian-smoothed so it reads as one slow pull-back. The rule
// blends back to the anchor distances across [0.38, 0.47]; states 3+ are pure anchors.
// M4 owns the final feel pass and the spec-table sync.

import { CatmullRomCurve3, PerspectiveCamera, Vector3 } from 'three/webgpu';
import { evalDeform, pchip } from '../field/deform';
import { cpuPose } from '../field/cpuPose';
import { poseTransform } from './drivers';
import { E1, clamp01 } from './easing';

// Authored per-side margin. Sampling interval, curve smoothing, and PCHIP interval lag eat
// ~3–4% of it, so 0.09 authored realizes ≥5% on screen everywhere (verified at p 0.20 on
// both aspects); d(0) grows ~3% vs the approved frame — imperceptible.
const DOLLY_MARGIN = 0.09;
const DOLLY_P_MAX = 0.5;
const DOLLY_SAMPLES = 64;
const BLEND_START = 0.38;
const BLEND_END = 0.47;

interface Anchor {
  p: number;
  focal: number; // mm, 35mm-equivalent; vfov = 2·atan(12/f) at the 1440×900 reference
  pos: Vector3;
  look: Vector3;
}

// M1-rebaked from the §9 table: the published table's focal/distance/framing triples were
// not mutually consistent against the implemented model's true extents (static web anchor
// z = v − 0.5; sheet long side 1.0). Directions and look-ats keep the §9 design; distances
// are scaled so each state meets its §9 FRAMING FRACTION (the fractions are the contract).
// M4 owns the designed pass, per-segment eases, mobile overrides, and the spec-table sync.
const ANCHORS: readonly Anchor[] = [
  // p=0 (v1.3.1): 82% wrapped — the roll is the object. Camera in at d ≈ 0.8 on a low
  // three-quarter, aimed at the roll axis; the near spiral end reads, the far end may
  // graze the frame edge (it should feel big).
  { p: 0.0, focal: 40, pos: new Vector3(0.42, 0.27, 1.13), look: new Vector3(0.0, 0.04, 0.34) },
  { p: 0.21, focal: 42, pos: new Vector3(0.36, 0.59, 1.05), look: new Vector3(0.0, 0.02, 0.18) },
  { p: 0.34, focal: 46, pos: new Vector3(0.33, 1.952, 1.317), look: new Vector3(0.0, 0.012, 0.03) },
  { p: 0.47, focal: 50, pos: new Vector3(0.06, 2.204, 0.69), look: new Vector3(0.0, 0.008, 0.045) },
  { p: 0.6, focal: 55, pos: new Vector3(0.0, 2.64, 0.234), look: new Vector3(0.0, 0.0, 0.018) },
  { p: 0.7, focal: 55, pos: new Vector3(0.0, 2.092, 0.654), look: new Vector3(0.0, 0.02, 0.01) },
  { p: 0.8, focal: 57, pos: new Vector3(0.0, 1.036, 1.046), look: new Vector3(0.0, 0.09, -0.01) },
  { p: 0.9, focal: 60, pos: new Vector3(0.0, 0.474, 1.104), look: new Vector3(0.0, 0.15, -0.03) },
  { p: 1.0, focal: 62, pos: new Vector3(0.0, 0.325, 1.365), look: new Vector3(0.0, 0.185, -0.045) },
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
  private readonly anchorPos = new Vector3();
  private readonly lookNow = new Vector3();
  private readonly dir = new Vector3();

  private dollyCurve: ((p: number) => number) | null = null;
  private dollyAspect = 0;

  update(p: number, dt: number): void {
    this.pLook += (p - this.pLook) * (dt > 0 ? 1 - Math.exp(-dt / 0.08) : 0);
    this.posCurve.getPoint(curveT(p), this.anchorPos);
    this.lookCurve.getPoint(curveT(p), this.lookNow);

    if (p < BLEND_END) {
      if (this.dollyAspect !== this.camera.aspect) {
        this.dollyCurve = buildDollyCurve(this.camera.aspect, this.posCurve, this.lookCurve);
        this.dollyAspect = this.camera.aspect;
      }
      const dAnchor = this.anchorPos.distanceTo(this.lookNow);
      const dRule = this.dollyCurve ? this.dollyCurve(Math.min(p, DOLLY_P_MAX)) : dAnchor;
      const blend = E1(clamp01((p - BLEND_START) / (BLEND_END - BLEND_START)));
      const d = dRule + (dAnchor - dRule) * blend;
      (window as unknown as { __dolly?: unknown }).__dolly = {
        p: +p.toFixed(3),
        dRule: +dRule.toFixed(3),
        dAnchor: +dAnchor.toFixed(3),
        blend: +blend.toFixed(3),
      };
      this.dir.copy(this.anchorPos).sub(this.lookNow).normalize();
      this.camera.position.copy(this.lookNow).addScaledVector(this.dir, d);
    } else {
      this.camera.position.copy(this.anchorPos);
    }

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

/** Closed-form extent fit: smallest distance along `dir` from the look point such that all
 *  sampled sheet points project inside the viewport with DOLLY_MARGIN per side. In the
 *  camera basis (z along dir), each point demands d ≥ r_z + |r_xy| / (T·(1 − margin)). */
function buildDollyCurve(
  aspect: number,
  posCurve: CatmullRomCurve3,
  lookCurve: CatmullRomCurve3,
): (p: number) => number {
  const ps: number[] = [];
  const ds: number[] = [];
  const pos = new Vector3();
  const look = new Vector3();
  const dir = new Vector3();
  const xAxis = new Vector3();
  const yAxis = new Vector3();
  const up = new Vector3(0, 1, 0);
  const rel = new Vector3();

  for (let i = 0; i < DOLLY_SAMPLES; i++) {
    const p = (i / (DOLLY_SAMPLES - 1)) * DOLLY_P_MAX;
    const d0 = evalDeform(p);
    const tr = poseTransform(p, d0.zTopCurl);
    const cosT = Math.cos(tr.rotX);
    const sinT = Math.sin(tr.rotX);

    posCurve.getPoint(curveT(p), pos);
    lookCurve.getPoint(curveT(p), look);
    dir.copy(pos).sub(look).normalize();
    xAxis.crossVectors(up, dir).normalize();
    yAxis.crossVectors(dir, xAxis);

    const Ty = 12 / focalAt(p);
    const Tx = Ty * aspect;
    // Portrait aspects: fitting a ¾-view sheet's full diagonal into a phone's width forces
    // absurd distances. §12's own mobile arc is "roll floats (fits) → sheet overflows the
    // sides (intentional)" — so on aspect < 1 a side-overflow allowance phases in with the
    // unroll: the roll fits fully at p = 0, the opening sheet may crop up to 35%/side by
    // p ≈ 0.25. Vertical stays strict; desktop (aspect ≥ 1) is unaffected.
    const sideAllow = aspect < 1 ? 0.35 * E1(clamp01((p - 0.1) / 0.15)) : 0;
    const kx = Tx * (1 - DOLLY_MARGIN + sideAllow);
    const ky = Ty * (1 - DOLLY_MARGIN);

    let dFit = 0.2;
    for (const u of [-0.5, -0.25, 0, 0.25, 0.5]) {
      for (let j = 0; j <= 32; j++) {
        const q = cpuPose(u, j / 32, d0);
        // object → world (tilt about the moving curl line)
        const wy = q.y * cosT - q.z * sinT + tr.offY;
        const wz = q.y * sinT + q.z * cosT + tr.offZ;
        rel.set(q.x - look.x, wy - look.y, wz - look.z);
        const rx = rel.dot(xAxis);
        const ry = rel.dot(yAxis);
        const rz = rel.dot(dir);
        dFit = Math.max(dFit, rz + Math.abs(rx) / kx, rz + Math.abs(ry) / ky);
      }
    }
    ps.push(p);
    ds.push(dFit);
  }

  // one slow pull-back: never dolly back in mid-unroll, then smooth the constraint kinks —
  // and floor the smoothed curve at the raw constraint so the ease never eats the margin
  for (let i = 1; i < ds.length; i++) ds[i] = Math.max(ds[i] ?? 0, ds[i - 1] ?? 0);
  const raw = [...ds];
  const K = [0.06, 0.24, 0.4, 0.24, 0.06];
  for (let pass = 0; pass < 2; pass++) {
    const src = [...ds];
    for (let i = 0; i < ds.length; i++) {
      let acc = 0;
      for (let k = -2; k <= 2; k++) {
        const idx = Math.min(ds.length - 1, Math.max(0, i + k));
        acc += (src[idx] ?? 0) * (K[k + 2] ?? 0);
      }
      ds[i] = acc;
    }
  }
  for (let i = 0; i < ds.length; i++) ds[i] = Math.max(ds[i] ?? 0, raw[i] ?? 0);
  return pchip(ps, ds);
}
