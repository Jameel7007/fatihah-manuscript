// §7/§11 background (v1.6): a deep-blue universe behind the gold. The §16-calibrated floor
// (the ?calibrate=bg solve makes the displayed floor the target hex exactly) is lifted by
// one broad, world-anchored nebular lobe behind the sheet and pricked with tiny stars.
// Everything is a pure function of the view direction — the sky sits at infinity: it turns
// with the camera and never parallaxes against the sheet — and of the angular size of one
// pixel, so captures stay deterministic and a star stays ~1 px at any resolution. The
// detail (lobe + nebula + stars) has a switch so the floor can be calibrated alone.
//
// Stars: one candidate per cell of a 6 × CELLS² cube-face grid, jittered inside the cell's
// central 56% so a star never crosses a cell (no neighbour search, no seams); brightness
// follows b⁶ (most stars a few × floor luminance, the rare one hundreds ×, white through the
// AgX shoulder); the core is a Gaussian in ANGLE, σ ≥ 0.65 px, so the faintest stars are
// (just) resolved rather than sub-pixel sparkle.

import { BackSide, Mesh, MeshBasicNodeMaterial, SphereGeometry, Vector3 } from 'three/webgpu';
import { cameraPosition, cross, dot, exp, float, fract, positionWorld, step, uniform, vec2, vec3 } from 'three/tsl';
// (dot is used by the hash and the lobe; the star unit is a constant since the third review pass)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const GLOW_DIR = new Vector3(0, 0.35, -1).normalize(); // behind the sheet, slightly above the S3–S7 gaze
// The lobe is world-anchored, so it is in view at p = 0 and p = 1 but not while reading
// (the camera looks down): review 2026-09-01 — "starts dark, then gets bright again" — so
// it is held to a whisper (×1.55 peak) and the ground reads as one darkness across the scroll.
const GLOW_AMP = 0.55; // lobe peak = floor × (1 + GLOW_AMP), falling as cos³
const NEBULA_AMP = 0.6; // ± modulation of the lobe by the 3-octave value noise
const CELLS = 104; // star cells per cube face — ≈ 500 stars in the 1440×900 S3 frame
const OCCUPANCY = 0.26;
const STAR_UNIT = 0.0047; // scene-linear luminance unit for the star law (see buildSky)

export interface Sky {
  mesh: Mesh;
  /** scene-linear floor (drives the calibrated §16 value) */
  uFloor: { value: Vector3 };
  /** 1 = lobe + nebula + stars, 0 = floor only (calibration) */
  uDetail: { value: number };
  /** angular size of one rendered pixel (rad) — vfov / drawing-buffer height, set per frame */
  uPxRad: { value: number };
}

/** Sinless 3D hash → [0,1). */
function hash3(p: N): N {
  const p3: N = fract(p.mul(vec3(0.1031, 0.103, 0.0973)));
  const q: N = p3.add(dot(p3, vec3(p3.y, p3.x, p3.z).add(33.33)));
  return fract(q.x.add(q.y).mul(q.z));
}

const lerp = (a: N, b: N, t: N): N => a.add(b.sub(a).mul(t));

function vnoise3(p: N): N {
  const i: N = p.floor();
  const f: N = fract(p);
  const u: N = f.mul(f).mul(f.mul(-2).add(3));
  const c = (x: number, y: number, z: number): N => hash3(i.add(vec3(x, y, z)));
  const x00: N = lerp(c(0, 0, 0), c(1, 0, 0), u.x);
  const x10: N = lerp(c(0, 1, 0), c(1, 1, 0), u.x);
  const x01: N = lerp(c(0, 0, 1), c(1, 0, 1), u.x);
  const x11: N = lerp(c(0, 1, 1), c(1, 1, 1), u.x);
  return lerp(lerp(x00, x10, u.y), lerp(x01, x11, u.y), u.z);
}

function fbm3(p: N): N {
  return vnoise3(p)
    .mul(0.5)
    .add(vnoise3(p.mul(2.07).add(11.3)).mul(0.25))
    .add(vnoise3(p.mul(4.13).add(23.7)).mul(0.125))
    .div(0.875);
}

export function buildSky(floor: [number, number, number]): Sky {
  const uFloor = uniform(new Vector3(floor[0], floor[1], floor[2]));
  const uDetail = uniform(1);
  const uPxRad = uniform(6.5e-4);

  const d: N = positionWorld.sub(cameraPosition).normalize();
  const floorC: N = uFloor;
  // Star brightness unit: pinned to the luminance of the #040617 floor (the pass whose star
  // brightness was approved), so darkening the ground further does not dim the stars
  const floorLum: N = float(STAR_UNIT);

  // nebular lobe: cos³ about GLOW_DIR, modulated ± by the noise, tinted violet where dense
  // and teal-blue where thin; a faint noise term also breathes over the bare floor
  const g: N = dot(d, vec3(GLOW_DIR.x, GLOW_DIR.y, GLOW_DIR.z)).max(0);
  const lobe: N = g.mul(g).mul(g);
  const neb: N = fbm3(d.mul(2.3).add(vec3(5.1, 2.7, 9.4))).sub(0.5).mul(2);
  const lift: N = lobe.mul(GLOW_AMP).mul(neb.mul(NEBULA_AMP).add(1)).add(neb.mul(0.12));
  const tint: N = lerp(vec3(0.9, 1.0, 1.08), vec3(1.15, 0.92, 1.05), neb.mul(0.5).add(0.5));
  let col: N = floorC.add(floorC.mul(lift).mul(tint).mul(uDetail));

  // stars — cube-face cell of the view direction
  const a: N = d.abs();
  const isX: N = step(a.y, a.x).mul(step(a.z, a.x));
  const isY: N = float(1).sub(isX).mul(step(a.z, a.y));
  const isZ: N = float(1).sub(isX).sub(isY);
  const dom: N = d.x.mul(isX).add(d.y.mul(isY)).add(d.z.mul(isZ));
  const inv: N = float(1).div(a.x.mul(isX).add(a.y.mul(isY)).add(a.z.mul(isZ)));
  const q: N = vec2(d.y, d.z).mul(isX).add(vec2(d.x, d.z).mul(isY)).add(vec2(d.x, d.y).mul(isZ)).mul(inv);
  const sign: N = step(0, dom).mul(2).sub(1);
  const faceId: N = isY.mul(2).add(isZ.mul(4)).add(step(dom, 0));
  const cell0: N = q.add(1).mul(0.5 * CELLS).floor();
  // 3×3 neighbourhood so a bright star's soft halo crosses cell borders unclipped (a
  // single-cell lookup truncated halos into 25-px squares); cells outside the face are
  // masked — their phantom centers would exist from one face only
  let stars: N = vec3(0);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cell: N = cell0.add(vec2(dx, dy));
      const cid: N = vec3(cell.x, cell.y, faceId);
      const hOcc: N = hash3(cid);
      const b: N = hash3(cid.add(vec3(17.1, 31.7, 57.3)));
      const temp: N = hash3(cid.add(vec3(71.3, 13.9, 29.5)));
      const jx: N = hash3(cid.add(vec3(3.7, 41.3, 5.9))).mul(0.56).add(0.22);
      const jy: N = hash3(cid.add(vec3(23.1, 7.7, 61.3))).mul(0.56).add(0.22);
      const qc: N = cell.add(vec2(jx, jy)).mul(2 / CELLS).sub(1);
      const c: N = vec3(sign, qc.x, qc.y).mul(isX).add(vec3(qc.x, sign, qc.y).mul(isY)).add(vec3(qc.x, qc.y, sign).mul(isZ)).normalize();
      const theta: N = cross(d, c).length(); // small-angle exact, no acos precision loss near 1
      const b2: N = b.mul(b);
      const b6: N = b2.mul(b2).mul(b2);
      // "stars a little smaller" (review 2026-09-01): σ 0.65–1.25 px (was 0.9–1.8), halo ×3 at 1.2%
      const sigma: N = uPxRad.mul(b2.mul(0.6).add(0.65));
      const peak: N = floorLum.mul(b6.mul(420).add(2.5));
      const core: N = exp(theta.mul(theta).div(sigma.mul(sigma).mul(-2)));
      const sigmaH: N = sigma.mul(3);
      const halo: N = exp(theta.mul(theta).div(sigmaH.mul(sigmaH).mul(-2))).mul(0.012).mul(b2.mul(b2));
      const inFace: N = step(-0.5, cell.x).mul(step(cell.x, float(CELLS - 0.5))).mul(step(-0.5, cell.y)).mul(step(cell.y, float(CELLS - 0.5)));
      const occ: N = step(hOcc, float(OCCUPANCY)).mul(inFace);
      const starCol: N = lerp(vec3(1.0, 0.86, 0.72), vec3(0.78, 0.86, 1.0), temp);
      stars = stars.add(starCol.mul(peak).mul(core.add(halo)).mul(occ));
    }
  }
  col = col.add(stars.mul(uDetail));

  const mat = new MeshBasicNodeMaterial();
  mat.colorNode = col;
  mat.side = BackSide;
  mat.fog = false;
  const mesh = new Mesh(new SphereGeometry(3.2, 24, 16), mat);
  mesh.frustumCulled = false;
  return { mesh, uFloor, uDetail, uPxRad };
}
