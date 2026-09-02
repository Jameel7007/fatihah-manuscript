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
import { FACE_CENTER_ANCHOR, FACE_CENTER_REST, FACE_START, RECEDE_REST, faceFactor, facePitch, poseTransform } from './drivers';
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
  readonly camera = new PerspectiveCamera(30, 16 / 9, 0.05, 8.0); // far covers the background sphere from every pose

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

  // §9 pointer/gyro parallax: an orbit gimbal of ±0.35° driven by a critically-ish damped
  // spring (ω 12.6 rad/s, ζ 0.9) toward the pointer's normalized offset; applied after the
  // spline and before the look-at damper. Off in reduced motion and in capture.
  private gimbal = { x: 0, y: 0, vx: 0, vy: 0 };
  private pointerTarget = { x: 0, y: 0 };
  /** §15 idle camera drift (world), set per frame by the idle controller */
  drift: [number, number, number] = [0, 0, 0];
  parallaxEnabled = true;

  setPointer(nx: number, ny: number): void {
    this.pointerTarget.x = Math.max(-1, Math.min(1, nx));
    this.pointerTarget.y = Math.max(-1, Math.min(1, ny));
  }

  private stepGimbal(dt: number): void {
    if (!this.parallaxEnabled || dt <= 0) return;
    const w = 12.6;
    const z = 0.9;
    const g = this.gimbal;
    for (const axis of ['x', 'y'] as const) {
      const v = axis === 'x' ? 'vx' : 'vy';
      const target = this.pointerTarget[axis];
      const a = w * w * (target - g[axis]) - 2 * z * w * g[v];
      g[v] += a * dt;
      g[axis] += g[v] * dt;
    }
  }

  update(p: number, dt: number): void {
    this.pLook += (p - this.pLook) * (dt > 0 ? 1 - Math.exp(-dt / 0.08) : 0);
    this.posCurve.getPoint(curveT(p), this.anchorPos);
    this.lookCurve.getPoint(curveT(p), this.lookNow);
    this.stepGimbal(dt);

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
    } else if (p > FACE_START || this.camera.aspect < 1) {
      // §12 mobile overrides (portrait aspects): distance × 0.94 in S3 (the writing reads
      // larger on a phone), × 1.00 through S4–5, × 1.12 from the rise (S6–7) — blended so
      // the dolly never steps. Desktop aspects keep the pure anchors until the S7 fit.
      if (p <= FACE_START) {
        const mul = this.mobileDistMul(p);
        this.dir.copy(this.anchorPos).sub(this.lookNow).normalize();
        const d = this.anchorPos.distanceTo(this.lookNow) * mul;
        this.camera.position.copy(this.lookNow).addScaledVector(this.dir, d);
      } else {
      // S7 (M6): the gaze TRACKS the lifting assembly center (blended from the anchor look-at
      // by the facing factor), and the distance comes from the ASSEMBLY-extent fit — the v1.5
      // seven-line block is 0.72 world tall and, pitched toward the camera, overflows the §9
      // anchor distance vertically. Same rule as the S1–2 sheet fit: the smallest distance
      // along the anchor direction such that the pitched block's corners project inside the
      // viewport with the authored margin; blends in over [0.84, 0.88], never dollies in.
      const e = faceFactor(p);
      const cA = new Vector3(...FACE_CENTER_ANCHOR);
      const cR = new Vector3(...FACE_CENTER_REST);
      const center = cA.clone().lerp(cR, e);
      this.dir.copy(this.anchorPos).sub(this.lookNow).normalize();
      this.lookNow.lerp(center, e);
      const dAnchor = this.anchorPos.distanceTo(this.lookNow) * (this.camera.aspect < 1 ? this.mobileDistMul(p) : 1);
      const dFit = this.fitAssembly(p, this.dir, this.lookNow);
      const blend = E1(clamp01((p - FACE_START) / 0.04));
      const d = dAnchor + (Math.max(dAnchor, dFit) - dAnchor) * blend;
      (window as unknown as { __s7fit?: unknown }).__s7fit = { p: +p.toFixed(3), dAnchor: +dAnchor.toFixed(3), dFit: +dFit.toFixed(3), d: +d.toFixed(3) };
      this.camera.position.copy(this.lookNow).addScaledVector(this.dir, d);
      }
    } else {
      this.camera.position.copy(this.anchorPos);
    }

    // parallax orbit about the look point (±0.35° gimbal) + idle drift
    if (this.parallaxEnabled && (this.gimbal.x !== 0 || this.gimbal.y !== 0)) {
      const rel = this.camera.position.clone().sub(this.lookNow);
      const yaw = (0.35 * Math.PI / 180) * this.gimbal.x;
      const pitch = (0.35 * Math.PI / 180) * this.gimbal.y;
      rel.applyAxisAngle(new Vector3(0, 1, 0), yaw);
      const right = new Vector3().crossVectors(rel, new Vector3(0, 1, 0)).normalize();
      rel.applyAxisAngle(right, pitch);
      this.camera.position.copy(this.lookNow).add(rel);
    }
    this.camera.position.x += this.drift[0];
    this.camera.position.y += this.drift[1];
    this.camera.position.z += this.drift[2];

    this.lookCurve.getPoint(curveT(this.pLook), this.lookTarget);
    if (p > FACE_START) {
      // the trailing gaze also tracks the assembly center in S7
      const e = faceFactor(this.pLook);
      this.lookTarget.lerp(new Vector3(...FACE_CENTER_ANCHOR).lerp(new Vector3(...FACE_CENTER_REST), e), e);
    }
    this.camera.lookAt(this.lookTarget);
    this.camera.fov = (2 * Math.atan(12 / focalAt(p)) * 180) / Math.PI;
    this.camera.updateProjectionMatrix();
  }

  /** §12 portrait distance multiplier: 1.00 → 0.94 across the writing (S3), back to 1.00 by the
   *  presenting state, 1.12 from the rise on (E1 blends, so the dolly never steps). */
  private mobileDistMul(p: number): number {
    const s3 = E1(clamp01((p - 0.3) / 0.06)) * (1 - E1(clamp01((p - 0.5) / 0.1)));
    const s67 = E1(clamp01((p - 0.7) / 0.06));
    return 1 - 0.06 * s3 + 0.12 * s67;
  }

  /** Smallest distance along `dir` from `look` such that the text block — pitched and lifted
   *  per the S7 drivers — projects inside the viewport with DOLLY_MARGIN per side. Block
   *  bbox on the sheet: x ±0.28, the §3 text band v ∈ [0.15, 0.865] (z = v − 0.5). */
  private fitAssembly(p: number, dir: Vector3, look: Vector3): number {
    const pitch = facePitch(p);
    const lift = faceFactor(p);
    const cA = new Vector3(...FACE_CENTER_ANCHOR);
    const cR = new Vector3(...FACE_CENTER_REST);
    const center = cA.clone().lerp(cR, lift);
    const up = new Vector3(0, 1, 0);
    const xAxis = new Vector3().crossVectors(up, dir).normalize();
    const yAxis = new Vector3().crossVectors(dir, xAxis);
    const Ty = 12 / focalAt(p); // the true focal for this p (camera.fov lags one frame / is stale on snap)
    const Tx = Ty * this.camera.aspect;
    const kx = Tx * (1 - DOLLY_MARGIN);
    const ky = Ty * (1 - DOLLY_MARGIN);
    let dFit = 0.2;
    const rel = new Vector3();
    for (const x of [-0.28, 0.28]) {
      for (const z of [-0.35, 0.365]) {
        // rigid pitch about the block center (x axis), then the carry — same law as the vertex stage
        const rz = z - cA.z;
        const ry = 0;
        const py = ry * Math.cos(pitch) - rz * Math.sin(pitch);
        const pz = ry * Math.sin(pitch) + rz * Math.cos(pitch);
        rel.set(x, py + center.y, pz + center.z).sub(look);
        const rx = rel.dot(xAxis);
        const ryy = rel.dot(yAxis);
        const rzz = rel.dot(dir);
        dFit = Math.max(dFit, rzz + Math.abs(rx) / kx, rzz + Math.abs(ryy) / ky);
      }
    }
    // v1.6.1: the receded page stays in frame BELOW the standing block (user review
    // 2026-09-01 — the last line read as still lying on the paper). The page drops to
    // RECEDE_REST.y with the lift; its far edge (z −0.5 + recede) plus a 0.06 band of page
    // beneath must project inside the frame (to the edge, no margin — the page is cropped by
    // the frame anyway; vertical only — the page's width may crop at the sides), so the block
    // floats over a visible strip of page. A 0.06 band costs ≈ 16% distance at 16:10.
    {
      rel.set(0, RECEDE_REST[1] * lift - 0.06, -0.5 + RECEDE_REST[2] * lift).sub(look);
      const ryy = rel.dot(yAxis);
      const rzz = rel.dot(dir);
      dFit = Math.max(dFit, rzz + Math.abs(ryy) / Ty);
    }
    return dFit;
  }

  /** Capture mode: no trailing gaze, no parallax, no drift — pose must be a pure function of p. */
  snap(p: number): void {
    this.pLook = p;
    this.parallaxEnabled = false;
    this.drift = [0, 0, 0];
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
