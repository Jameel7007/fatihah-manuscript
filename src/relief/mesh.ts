// §6/§14/§5 glyph relief (M4 → M5) — the merged bevel-extrusion mesh: born ink-colored
// inside the geometry-handoff window, then RISING per āyah in reading order and turning to
// aged gold as it takes form. Geometry carries NO world positions: every vertex stores its
// sheet anchor (su, sv) + normalized profile height hn, and the vertex stage fetches the
// SAME surface-field textures the parchment reads (§14 z-guard: watertight by construction).
// Interior field texels are identity params, so the anchor maps straight onto the field grid
// with a manual bilinear (4 textureLoads — the RTs are NearestFilter, and float32-linear
// sampling is a WebGPU feature gamble this project doesn't take).
//
// Depth law (§14): worldOffset = hn · max(uGeoDepth, kindScale · stagger) + seam clearance,
//   stagger = 0.0012 → 0.0115 over [start, start + 0.093] with E4 (= E2), gated at start,
//   start = 0.722 + 0.0115·(āyah − 1) + 0.0012·cluster   (§10: reading-order lead)
// Gold transmutation (§14/§7) lags each cluster's rise by 0.25 of its window (E2): base color,
// metalness and roughness blend from the flat-ink set to the §7 gold set — face (burnished
// leaf, wear → bole), sidewalls (darker, ×0.72 toward the root), markers +0.05 rough.
// Every lerp is explicit mul/add (the TSL mix() gotcha in the physical material).
//
// Determinism: the mesh draws AFTER the parchment (renderOrder 1) and its base sits a hair
// (1e-5 world, 0.01 px) above the surface — without both, the seam z-fight resolved by
// whichever pipeline compiled first, and R-0.710 flipped between two hashes across loads.

import { BufferAttribute, BufferGeometry, Mesh, MeshBasicNodeMaterial, MeshPhysicalNodeMaterial, Sphere, Vector3 } from 'three/webgpu';
import { attribute, color, cos, cross, dFdx, dFdy, float, ivec2, sin, step, texture, textureLoad, transformNormalToView, uniform, varying, vec2, vec3, vec4 } from 'three/tsl';
import type { Field } from '../field/field';
import { GRID_H, GRID_W } from '../field/silhouette';
import { INK_DRY, INK_WET } from '../ink/ink';
import { DEPTH_ENTRY, DEPTH_FULL, FACE_CENTER_ANCHOR, FACE_CENTER_REST, RISE_AYAH_DP, RISE_CLUSTER_DP, RISE_DUR, RISE_GOLD_LAG, RISE_START } from '../director/drivers';

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

const SEAM_EPS = 1e-5; // base-ring clearance above the surface (world)

// §7 gold set, scene-linear (sRGB → linear, 3 s.f.)
// v1.6.1 ("the text needs to be smoothed and a little brighter", user review 2026-09-01): the face
// moves from aged leaf #C29B52 (lin 0.548/0.335/0.082) toward real gold — #DDB768 (lin 0.723/0.478/0.142)
const GOLD_FACE: [number, number, number] = [0.723, 0.478, 0.142]; // #DDB768
const GOLD_BOLE: [number, number, number] = [0.197, 0.058, 0.025]; // #7A4630 wear → bole
const GOLD_SIDE: [number, number, number] = [0.28, 0.148, 0.023]; // #8F6B2E sidewall

export interface GlyphBin {
  meta: {
    version: number;
    counts: { verts: number; tris: number; groups: number };
    depth: number;
    bevel: number;
  };
  anchor: Uint16Array;
  nrm: Int8Array;
  aux: Uint8Array;
  auvQ: Uint16Array;
  index: Uint32Array;
}

export async function loadGlyphBin(url: string): Promise<GlyphBin> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`glyphs.bin: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'FGLY') throw new Error(`glyphs.bin: bad magic ${magic}`);
  const version = dv.getUint32(4, true);
  const jsonLen = dv.getUint32(8, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, jsonLen)));
  const bufs = meta.buffers as Record<string, { offset: number; length: number } | undefined>;
  const b = (name: string): { offset: number; length: number } => {
    const r = bufs[name];
    if (!r) throw new Error(`glyphs.bin: missing buffer ${name}`);
    return r;
  };
  return {
    meta: { version, ...meta },
    anchor: new Uint16Array(buf, b('anchor').offset, b('anchor').length / 2),
    nrm: new Int8Array(buf, b('nrm').offset, b('nrm').length),
    aux: new Uint8Array(buf, b('aux').offset, b('aux').length),
    auvQ: new Uint16Array(buf, b('auv').offset, b('auv').length / 2),
    index: new Uint32Array(buf, b('index').offset, b('index').length / 4),
  };
}

export interface GlyphRelief {
  mesh: Mesh;
  /** §14 handoff depth (world) — drivers.geoDepth(p); mesh hidden below the window */
  uGeoDepth: { value: number };
  /** scroll p — the per-cluster rise/transmutation clocks evaluate in the vertex stage */
  uP: { value: number };
  /** height-only material for the contact-shadow pass (same position node) */
  heightMaterial: MeshBasicNodeMaterial;
  /** §5 S7 facing: assembly pitch (radians) about the block center — drivers.facePitch(p) */
  uPitch: { value: number };
  /** §5 S7 facing: anchor → presentation center blend 0..1 — drivers.faceFactor(p) */
  uLift: { value: number };
}

/** cubic-bezier(0.22, 0, 0.18, 1) — the §13 E2/E4 curve — evaluated in-shader: five Newton
 *  steps on x(t) from t = x (x(t) is monotone with dx/dt ≥ 0.53 for this curve), then y(t). */
function bezierE2(x: N): N {
  const x1 = 0.22;
  const y1 = 0;
  const x2 = 0.18;
  const y2 = 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  let t: N = x;
  for (let i = 0; i < 5; i++) {
    const fx: N = t.mul(t.mul(t.mul(ax).add(bx)).add(cx)).sub(x);
    const dfx: N = t.mul(t.mul(3 * ax).add(2 * bx)).add(cx);
    t = t.sub(fx.div(dfx.max(1e-3))).clamp(0, 1);
  }
  return t.mul(t.mul(t.mul(ay).add(by)).add(cy)).clamp(0, 1);
}

export function buildGlyphRelief(
  bin: GlyphBin,
  field: Field,
  fiberTex: import('three/webgpu').Texture,
  burnishTex: import('three/webgpu').Texture,
  inkTex: import('three/webgpu').Texture,
): GlyphRelief {
  const geo = new BufferGeometry();
  const nVerts = bin.anchor.length / 4;
  geo.setAttribute('position', new BufferAttribute(new Float32Array(nVerts * 3), 3)); // zeros — positionNode owns it (same pattern as the parchment grid)
  geo.setAttribute('aAnchor', new BufferAttribute(bin.anchor, 4, true));
  geo.setAttribute('aNrm', new BufferAttribute(bin.nrm, 4, true));
  geo.setAttribute('aAux', new BufferAttribute(bin.aux, 4, true));
  geo.setAttribute('aAuv', new BufferAttribute(bin.auvQ, 2, true));
  geo.setIndex(new BufferAttribute(bin.index, 1));
  geo.boundingSphere = new Sphere(new Vector3(0, 0, 0), 1.2);

  const uGeoDepth = uniform(0.00045);
  const uP = uniform(0);
  const uPitch = uniform(0);
  const uLift = uniform(0);

  const anc: N = attribute('aAnchor', 'vec4'); // su, sv, hn, kindScale
  const npl: N = attribute('aNrm', 'vec4'); // plan-frame relief normal
  const aux: N = attribute('aAux', 'vec4'); // ayah/8, root AO, roughness floor, cluster/255
  void attribute('aAuv', 'vec2'); // atlas uv — reserved

  // manual bilinear over the field textures at the anchor (grid = identity params interior)
  const gx: N = anc.x.mul(GRID_W - 1);
  const gy: N = anc.y.mul(GRID_H - 1);
  const i0: N = gx.floor();
  const j0: N = gy.floor();
  const fx: N = gx.sub(i0);
  const fy: N = gy.sub(j0);
  const fetch2 = (tex: import('three/webgpu').Texture): N => {
    const i1: N = i0.add(1).min(GRID_W - 1);
    const j1: N = j0.add(1).min(GRID_H - 1);
    const t00: N = textureLoad(tex, ivec2(i0.toInt(), j0.toInt())).xyz;
    const t10: N = textureLoad(tex, ivec2(i1.toInt(), j0.toInt())).xyz;
    const t01: N = textureLoad(tex, ivec2(i0.toInt(), j1.toInt())).xyz;
    const t11: N = textureLoad(tex, ivec2(i1.toInt(), j1.toInt())).xyz;
    const a: N = t00.mul(float(1).sub(fx)).add(t10.mul(fx));
    const b: N = t01.mul(float(1).sub(fx)).add(t11.mul(fx));
    return a.mul(float(1).sub(fy)).add(b.mul(fy));
  };
  const surfPos: N = fetch2(field.posRT.texture);
  const surfN: N = fetch2(field.nrmRT.texture).normalize();
  const surfT: N = fetch2(field.tanRT.texture).normalize();

  // §10 rise clocks — per cluster, from the baked āyah + reading-order index
  const ayahIdx: N = aux.x.mul(8).add(0.5).floor(); // 1..7
  const clusterIdx: N = aux.w.mul(255).add(0.5).floor();
  const start: N = ayahIdx.sub(1).mul(RISE_AYAH_DP).add(clusterIdx.mul(RISE_CLUSTER_DP)).add(RISE_START);
  const tRise: N = uP.sub(start).div(RISE_DUR).clamp(0, 1);
  const stagger: N = bezierE2(tRise).mul(DEPTH_FULL - DEPTH_ENTRY).add(DEPTH_ENTRY).mul(step(start, uP));
  const depth: N = uGeoDepth.max(anc.w.mul(stagger));
  const worldH: N = anc.z.mul(depth);
  const anchorPos: N = surfPos.add(surfN.mul(worldH.add(SEAM_EPS)));
  // §5 S7 "anchor-frame → presentation-frame blend": a RIGID motion — pitch about the
  // text block's center (x axis through it) by uPitch, and carry the center toward the
  // rest pose (the p = 1 look-at). Rigid so the assembly never distorts while it lifts.
  const cA: N = vec3(...FACE_CENTER_ANCHOR);
  const cR: N = vec3(...FACE_CENTER_REST);
  const rel: N = anchorPos.sub(cA);
  const cp: N = cos(uPitch);
  const sp: N = sin(uPitch);
  const rotY: N = rel.y.mul(cp).sub(rel.z.mul(sp));
  const rotZ: N = rel.y.mul(sp).add(rel.z.mul(cp));
  const positionNode: N = vec3(rel.x, rotY, rotZ).add(cA).add(cR.sub(cA).mul(uLift));
  const tGold: N = uP.sub(start.add(RISE_GOLD_LAG * RISE_DUR)).div(RISE_DUR).clamp(0, 1);
  const vGold: N = varying(bezierE2(tGold));

  const m = new MeshPhysicalNodeMaterial();
  // v1.6: gilding lives on what it reflects — the gold takes the §8 room at 1.6× (the
  // parchment keeps 1×) so it stays luminous against the deep-blue universe ground
  m.envMapIntensity = 2.2; // v1.6.1: "a little brighter" (with the warm dome in the §8 env)
  // §14 z-guard: depthBias −2 / slopeScale −0.5 on the glyph main pass (shadow/contact
  // pipelines stay unbiased)
  m.polygonOffset = true;
  m.polygonOffsetFactor = -0.5;
  m.polygonOffsetUnits = -2;
  m.positionNode = positionNode;

  // plan frame → object frame: x = +su = T, y = +sv (down-page) = cross(T, N), z = N
  const Bpage: N = cross(surfT, surfN);
  const nAnchor: N = surfT.mul(npl.x).add(Bpage.mul(npl.y)).add(surfN.mul(npl.z)).normalize();
  const nObj: N = vec3(nAnchor.x, nAnchor.y.mul(cp).sub(nAnchor.z.mul(sp)), nAnchor.y.mul(sp).add(nAnchor.z.mul(cp)));
  const nView: N = transformNormalToView(varying(nObj)).normalize();
  m.normalNode = nView;

  const suv: N = varying(vec2(anc.x, anc.y));
  const aoV: N = varying(aux.y);
  const rFloorV: N = varying(aux.z);
  const hnV: N = varying(anc.z);
  const kindV: N = varying(anc.w);

  // flat-ink composite (explicit lerps — the TSL mix() gotcha) × baked root AO
  const inkT: N = texture(inkTex, suv);
  const wetF: N = inkT.g;
  const fib: N = texture(fiberTex, suv);
  const det: N = texture(fiberTex, suv.mul(6.0));
  const height: N = fib.z.mul(0.7).add(det.z.mul(0.3));
  const cavity: N = float(1).sub(height.sub(0.5).mul(0.24));
  const inkCol: N = color(INK_DRY).mul(float(1).sub(wetF)).add(color(INK_WET).mul(wetF));
  const inkBase: N = inkCol.mul(cavity);
  const rInk: N = float(0.52).sub(wetF.mul(0.24));

  // §7 gold: burnish pack (R burnish → roughness 0.21..0.47, G wear → bole ~8%, crown-biased)
  // v1.6.1 smooth gold: the burnish pack sampled at sheet scale (was ×7/×9 — a roughness
  // speckle finer than a stroke width that broke every highlight into dots), roughness
  // 0.18–0.34 (was 0.21–0.47), wear ≈ 3% (was ≈ 8%)
  const bp: N = texture(burnishTex, suv);
  const burnish: N = bp.r;
  const crown: N = hnV.smoothstep(0.55, 0.92); // top face vs wall/root
  const wearBias: N = rFloorV.greaterThan(0.2).select(float(0.04), float(0.0)); // crown-fillet ring wears first
  const wear: N = bp.g.add(wearBias).smoothstep(0.76, 0.82);
  const faceCol: N = vec3(...GOLD_FACE).mul(float(1).sub(wear)).add(vec3(...GOLD_BOLE).mul(wear));
  const sideDark: N = hnV.div(0.55).clamp(0, 1).mul(0.28).add(0.72); // ×0.72 toward the root
  const sideCol: N = vec3(...GOLD_SIDE).mul(sideDark);
  const goldCol: N = sideCol.mul(float(1).sub(crown)).add(faceCol.mul(crown));
  const faceRough: N = burnish.mul(0.16).add(0.18).mul(float(1).sub(wear)).add(float(0.62).mul(wear));
  const markerBias: N = kindV.lessThan(0.7).select(float(0.05), float(0.0)); // markers: +0.05 rough
  const goldRough: N = float(0.52).mul(float(1).sub(crown)).add(faceRough.mul(crown)).add(markerBias).max(rFloorV);
  const goldMetal: N = float(0.85).mul(float(1).sub(crown)).add(float(1).sub(wear.mul(0.88)).mul(crown));

  const g: N = vGold;
  m.colorNode = inkBase.mul(float(1).sub(g)).add(goldCol.mul(g)).mul(aoV);
  m.metalnessNode = goldMetal.mul(g);
  // roughness blend + §15 geometric specular AA (same law as the parchment)
  const rMix: N = rInk.mul(float(1).sub(g)).add(goldRough.mul(g));
  const nDx: N = dFdx(nView);
  const nDy: N = dFdy(nView);
  const sigma2: N = nDx.dot(nDx).add(nDy.dot(nDy)).mul(0.25);
  m.roughnessNode = rMix.mul(rMix).add(sigma2.mul(2).min(0.18)).sqrt();

  // contact-shadow height pass material — shares the position node; outputs coverage +
  // height above the sheet (world / 0.2, enough range for the S7 lift)
  const heightMaterial = new MeshBasicNodeMaterial();
  heightMaterial.toneMapped = false;
  heightMaterial.fog = false;
  heightMaterial.positionNode = positionNode;
  const vH: N = varying(worldH);
  heightMaterial.outputNode = vec4(1, vH.div(0.2), 0, 1);

  const mesh = new Mesh(geo, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1; // after the parchment — deterministic seam resolution
  mesh.castShadow = false; // enabled by applyFrame at the rise (§14: contact/shadow pipelines unbiased)
  mesh.receiveShadow = true;
  mesh.visible = false;
  return { mesh, uGeoDepth, uP, heightMaterial, uPitch, uLift };
}
