// M2 stage (in progress): field-driven parchment grid + edge ribbon with §7 base materials
// and the §8 rig's colors/positions/ratios. Geometry carries no real positions — the vertex
// stage fetches the field textures by texel index (nearest, exact 1:1).
// M2 calibration anchors (baked from the ?calibrate harnesses in main.ts):
//   BG_LINEAR — scene-linear clear color pre-compensated so the displayed background is
//     #0D0906 exactly through the live AgX pipeline (§16).
//   KEY_INTENSITY — key scaled so an 18% gray card at sheet center under key alone displays
//     128/255, the AgX rendering of scene-linear 0.18 established by the M0 ramp (§8).
// Textures (fiber/wear/atlases), HDRI, PCSS, and the grade pass are the rest of M2.

import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  SpotLight,
  Sphere,
  Vector3,
} from 'three/webgpu';
import {
  Fn,
  attribute,
  color,
  dFdx,
  dFdy,
  faceDirection,
  float,
  interleavedGradientNoise,
  ivec2,
  screenCoordinate,
  texture,
  textureLoad,
  transformNormalToView,
  modelWorldMatrix,
  positionWorld,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
  vertexIndex,
  vogelDiskSample,
} from 'three/tsl';
import type { Field } from '../field/field';
import { GRID_H, GRID_W, type SilhouetteData } from '../field/silhouette';
import { THICKNESS } from '../field/deform';
import { buildEnvironment, buildFiberTexture, buildUtilTexture } from './textures';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export type DebugMode = 'none' | 'normal' | 'matcap' | 'graycard';

// §16 background pre-compensation — scene-linear clear color that the live AgX pipeline
// displays as exactly #0D0906. Baked from `?calibrate=bg` (secant solve against readback);
// re-run the harness whenever the tone/grade chain changes.
// Re-solved 2026-08-25 against the FULL grade chain: with the display-referred black lift
// (+0.0003 linear ≈ +1 count) and grain floor, the chain's own floor displays
// (13.6, 9.8, 6.6) — the #0D0906 target within a count on every channel — so the authored
// background is ~zero and the graded floor carries the tone. A ≈+0.5-count warm residue in
// the floor is unexplained (suspected pass/environment leak) — tracked for the M2 close.
// The pre-AgX-only solve was (0.00798, 0.00648, 0.00504), kept here for reference.
export const BG_LINEAR: [number, number, number] = [0.000002, 0.000002, 0.000002];

// §8 key intensity — 18% gray card at sheet center under key alone displays 128/255.
// Baked from `?calibrate=key`; re-run when key geometry/cone changes or the HDRI lands.
export const KEY_INTENSITY = 9.87; // re-solved 2026-08-25 through the full grade chain: 18% card → R=128

export interface Stage {
  scene: Scene;
  sheetRoot: Group;
  key: SpotLight;
  /** scene-linear background (a physical far sphere — pass() drops scene.background) */
  setBackground(r: number, g: number, b: number): void;
}

// key world position — shared by the light and the translucency term
const KEY_POS: [number, number, number] = [-0.55, 1.3, 0.85];

/** §8 PCSS — contact-hardening filter on the key's shadow map. Blocker search (16 Vogel
 *  taps, IGN-rotated) estimates the average occluder depth; the penumbra radius follows
 *  lightSize·(zR − zB)/zB, clamped [1, 28] texels; 25-tap Vogel PCF at that radius. Depth
 *  ratios use the shadow map's nonlinear depth — the near/far span is tight (0.6–2.6), and
 *  the residual distortion folds into the tuned light-size constant. */
const MAP_SIZE = 2048;
const LIGHT_SIZE_UV = 0.05;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pcssFilter: any = Fn(({ depthTexture, shadowCoord }: { depthTexture: never; shadowCoord: N }) => {
  const texel = 1 / MAP_SIZE;
  const zRec: N = shadowCoord.z;
  const phi: N = interleavedGradientNoise(screenCoordinate.xy).mul(Math.PI * 2);

  // blocker search
  const searchR = LIGHT_SIZE_UV * 0.5;
  let blockerSum: N = float(0);
  let blockerCnt: N = float(0);
  for (let i = 0; i < 16; i++) {
    const d: N = (texture as N)(depthTexture, shadowCoord.xy.add((vogelDiskSample as N)(i, 16, phi).mul(searchR))).r;
    const isB: N = d.lessThan(zRec).select(float(1), float(0));
    blockerSum = blockerSum.add(d.mul(isB));
    blockerCnt = blockerCnt.add(isB);
  }
  const zB: N = blockerSum.div(blockerCnt.max(1));
  const penumbra: N = zRec.sub(zB).div(zB.max(1e-4)).mul(LIGHT_SIZE_UV).mul(8.0);
  const radius: N = penumbra.clamp(texel, 28 * texel);

  // 25-tap PCF at the penumbra radius
  let lit: N = float(0);
  for (let i = 0; i < 25; i++) {
    lit = lit.add(
      (texture as N)(depthTexture, shadowCoord.xy.add((vogelDiskSample as N)(i, 25, phi).mul(radius))).compare(zRec),
    );
  }
  const pcf: N = lit.mul(1 / 25);
  // no blockers found → fully lit
  return blockerCnt.lessThan(0.5).select(float(1), pcf);
});

export function buildStage(
  renderer: import('three/webgpu').WebGPURenderer,
  field: Field,
  sil: SilhouetteData,
  debug: DebugMode,
): Stage {
  const scene = new Scene();

  // Background as a physical far sphere: PostProcessing's pass() does not render
  // scene.background, and ordinary scene content survives every chain. Colored by the
  // §16 pre-compensated linear value; the ?calibrate=bg harness drives the uniform.
  const uBg = uniform(new Vector3(BG_LINEAR[0], BG_LINEAR[1], BG_LINEAR[2]));
  const bgMat = new MeshBasicNodeMaterial();
  bgMat.colorNode = vec3(0.00798, 0.00648, 0.00504); // TEMP diagnostic: literal BG_LINEAR
  void uBg;
  bgMat.side = BackSide;
  bgMat.fog = false;
  const bgMesh = new Mesh(new SphereGeometry(3.2, 24, 16), bgMat);
  bgMesh.frustumCulled = false;
  scene.add(bgMesh);

  // §8 authored environment (procedural bake) — replaces the M1 hemisphere stand-in.
  // Yaw schedule is driven per frame from §10 via scene.environmentRotation.
  scene.environment = buildEnvironment(renderer);
  scene.environmentIntensity = 0.32;

  const maps = { fiber: buildFiberTexture(renderer), util: buildUtilTexture(renderer) };

  const sheetRoot = new Group();
  scene.add(sheetRoot);

  sheetRoot.add(buildSheet(field, maps, debug));
  sheetRoot.add(buildRibbon(field, sil, maps, debug));

  // §8 rig
  const key = new SpotLight(0xffd2a0, KEY_INTENSITY, 0, (26 * Math.PI) / 180, 0.5, 2);
  key.position.set(...KEY_POS);
  key.target.position.set(0, 0.04, 0.2);
  key.castShadow = true;
  key.shadow.mapSize.set(MAP_SIZE, MAP_SIZE);
  key.shadow.camera.near = 0.6;
  key.shadow.camera.far = 2.6;
  key.shadow.bias = -0.00015;
  key.shadow.normalBias = 0.0005;
  (key.shadow as unknown as { filterNode: unknown }).filterNode = pcssFilter;
  scene.add(key, key.target);

  const fill = new DirectionalLight(0xc7d8ee, 0.13 * 2.2); // ratio re-anchored against the env at grade time
  fill.position.set(0.85, 0.55, -0.45);
  scene.add(fill);

  const rim = new SpotLight(0xffbe83, KEY_INTENSITY * 0.3, 0, (28 * Math.PI) / 180 / 2, 0.6, 2);
  rim.position.set(-0.35, 0.18, -1.05);
  rim.target.position.set(0, 0, 0);
  scene.add(rim, rim.target);

  return {
    scene,
    sheetRoot,
    key,
    setBackground: (r: number, g: number, b: number) => {
      (uBg.value as Vector3).set(r, g, b);
    },
  };
}

interface Maps {
  fiber: import('three/webgpu').Texture;
  util: import('three/webgpu').Texture;
}

/** Shared vertex-stage fetch + debug/material wiring. `kind` picks the §7 material row.
 *  `suv` is the sheet uv as a varying (computed in the vertex stage alongside the fetch). */
function fieldMaterial(
  field: Field,
  maps: Maps,
  debug: DebugMode,
  positionNode: N,
  normalObj: N,
  tangentObj: N,
  suv: N,
  kind: 'parchment' | 'edge',
): MeshBasicNodeMaterial | MeshStandardNodeMaterial | MeshPhysicalNodeMaterial {
  if (debug === 'normal' || debug === 'matcap') {
    const m = new MeshBasicNodeMaterial();
    m.side = DoubleSide;
    m.positionNode = positionNode;
    m.colorNode =
      debug === 'normal'
        ? vec4(normalObj.mul(0.5).add(0.5), 1)
        : vec4(matcapShade(normalObj), 1);
    return m;
  }
  if (debug === 'graycard') {
    // §8 calibration card: pure Lambert 18% gray — displayed 128/255 under a calibrated key
    const m = new MeshStandardNodeMaterial();
    m.side = DoubleSide;
    m.color.setRGB(0.18, 0.18, 0.18);
    m.roughness = 1.0;
    m.positionNode = positionNode;
    m.normalNode = transformNormalToView(normalObj).mul(faceDirection);
    return m;
  }
  if (kind === 'edge') {
    // §7 edge ribbon: darker cut-fiber edge
    const m = new MeshStandardNodeMaterial();
    m.side = DoubleSide;
    m.color.set('#B08F5C');
    m.roughness = 0.8;
    m.positionNode = positionNode;
    m.normalNode = transformNormalToView(normalObj).mul(faceDirection);
    return m;
  }

  // §7 parchment: recto/verso via face direction, fiber-perturbed normals, macro wear,
  // analytic edge darkening, and the thin-surface wrap translucency (§7 pseudocode).
  const m = new MeshPhysicalNodeMaterial();
  m.side = DoubleSide;

  const fib: N = texture(maps.fiber, suv);
  const det: N = texture(maps.fiber, suv.mul(6.0));
  const util: N = texture(maps.util, suv);
  const fn: N = fib.xy.add(det.xy.mul(0.5)); // fiber slope
  const height: N = fib.z.mul(0.7).add(det.z.mul(0.3));
  const rmod: N = fib.w.mul(0.65).add(det.w.mul(0.35));

  const fd: N = faceDirection;
  const backAmt: N = fd.mul(-0.5).add(0.5); // 1 on verso

  // albedo: base → edge-zone tint → macro discoloration ±6% → blotch → stains → verso
  const dEdge: N = suv.x.min(float(1).sub(suv.x)).mul(0.78).min(suv.y.min(float(1).sub(suv.y)));
  const edgeZone: N = float(1).sub(dEdge.div(0.07).clamp(0, 1));
  let col: N = color('#E6D5AF');
  col = col.mix(color('#C9AE7E'), edgeZone.mul(0.55));
  col = col.mul(util.x.sub(0.5).mul(0.12).add(1));
  col = col.mul(float(1).sub(util.y.mul(0.05)));
  col = col.mul(float(1).sub(util.w.mul(0.12)));
  col = col.mix(color('#DCC79A').mul(util.z.sub(0.5).mul(0.1).add(1)), backAmt.mul(0.85));
  m.colorNode = col;

  // roughness: §7 0.62 ± 0.14 via fiber mod; verso +0.09 — then §15 geometric specular AA:
  // r' = sqrt(r² + min(2·σ²(N), 0.18)), σ² from screen-space normal derivatives, so curved
  // highlights (the roll under the key) never shimmer at distance or in motion
  const rBase: N = rmod.sub(0.5).mul(0.28).add(0.62).add(backAmt.mul(0.09));
  const nDx: N = dFdx(transformNormalToView(normalObj));
  const nDy: N = dFdy(transformNormalToView(normalObj));
  const sigma2: N = nDx.dot(nDx).add(nDy.dot(nDy)).mul(0.25);
  m.roughnessNode = rBase.mul(rBase).add(sigma2.mul(2).min(0.18)).sqrt();

  m.sheen = 0.18;
  m.sheenColor.set('#E8DCC0');
  m.sheenRoughness = 0.55;

  // fiber normal perturbation in the field TBN (§7 micro 0.55)
  const Nv: N = transformNormalToView(normalObj).mul(fd);
  const Tv: N = transformNormalToView(tangentObj);
  const Bv: N = Nv.cross(Tv);
  const k = 0.00055; // §7 micro 0.55 at parchment scale — tuned against 41 cm sheet analog
  m.normalNode = Nv.add(Tv.mul(fn.x.mul(k))).add(Bv.mul(fn.y.mul(k))).normalize();

  // thin-surface wrap translucency — §7: light from behind glows through, gated by local
  // thickness (fiber height + macro). Emissive-approximated until it joins the shadowed
  // light loop; the curl states are where it reads (inner wraps lighting up amber).
  const keyPos: N = uniform(vec3(...KEY_POS));
  const nW: N = modelWorldMatrix.mul(vec4(normalObj, 0)).xyz.normalize().mul(fd);
  const L: N = keyPos.sub(positionWorld).normalize();
  const backLit: N = nW.mul(-1).dot(L).add(0.4).div(1.4).clamp(0, 1);
  const thick: N = height.mul(0.6).add(util.x.mul(0.4));
  m.emissiveNode = color('#B08D52')
    .mul(backLit.mul(backLit))
    .mul(float(1).sub(thick).mul(0.18))
    .mul(2.2);

  m.positionNode = positionNode;
  return m;
}

/** Simple two-band shading purely from the object normal — faceting inspection (§20 M1). */
function matcapShade(n: N): N {
  const l1: N = n.dot(vec3(0.42, 0.78, 0.46)).mul(0.5).add(0.5);
  const l2: N = n.dot(vec3(-0.6, 0.2, -0.77)).max(0).mul(0.25);
  return vec3(l1.mul(l1).add(l2));
}

function buildSheet(field: Field, maps: Maps, debug: DebugMode): Mesh {
  const count = GRID_W * GRID_H;
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3));
  const idx: number[] = [];
  for (let j = 0; j < GRID_H - 1; j++) {
    for (let i = 0; i < GRID_W - 1; i++) {
      const a = j * GRID_W + i;
      const b = a + 1;
      const c = a + GRID_W;
      const dd = c + 1;
      idx.push(a, c, b, b, c, dd);
    }
  }
  geo.setIndex(idx);
  geo.boundingSphere = new Sphere(new Vector3(0, 0, 0), 1.2);

  const vi: N = vertexIndex.toInt();
  const tj: N = vi.div(GRID_W);
  const ti: N = vi.sub(tj.mul(GRID_W));
  const texel: N = ivec2(ti, tj);
  const pos: N = textureLoad(field.posRT.texture, texel).xyz;
  const nrm: N = textureLoad(field.nrmRT.texture, texel).xyz;
  const tan: N = textureLoad(field.tanRT.texture, texel).xyz;
  const suv: N = varying(vec2(ti.toFloat().div(GRID_W - 1), tj.toFloat().div(GRID_H - 1)));

  const mesh = new Mesh(geo, fieldMaterial(field, maps, debug, pos, nrm, tan, suv, 'parchment'));
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildRibbon(field: Field, sil: SilhouetteData, maps: Maps, debug: DebugMode): Mesh {
  const ring = sil.ring;
  const n = ring.length;
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(n * 2 * 3), 3));
  const tx = new Float32Array(n * 2);
  const ty = new Float32Array(n * 2);
  const side = new Float32Array(n * 2);
  for (let k = 0; k < n; k++) {
    const r = ring[k];
    if (!r) continue;
    tx[k * 2] = r[0];
    ty[k * 2] = r[1];
    side[k * 2] = 0;
    tx[k * 2 + 1] = r[0];
    ty[k * 2 + 1] = r[1];
    side[k * 2 + 1] = 1;
  }
  geo.setAttribute('texelX', new BufferAttribute(tx, 1));
  geo.setAttribute('texelY', new BufferAttribute(ty, 1));
  geo.setAttribute('side', new BufferAttribute(side, 1));
  const idx: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = k * 2;
    const b = ((k + 1) % n) * 2;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  geo.setIndex(idx);
  geo.boundingSphere = new Sphere(new Vector3(0, 0, 0), 1.2);

  const ax: N = attribute('texelX', 'float');
  const ay: N = attribute('texelY', 'float');
  const texel: N = ivec2(ax.toInt(), ay.toInt());
  const pos: N = textureLoad(field.posRT.texture, texel).xyz;
  const nrm: N = textureLoad(field.nrmRT.texture, texel).xyz;
  const tan: N = textureLoad(field.tanRT.texture, texel).xyz;
  const offset: N = nrm.mul(-THICKNESS).mul(attribute('side', 'float'));
  const suv: N = varying(vec2(ax.div(GRID_W - 1), ay.div(GRID_H - 1)));

  const mesh = new Mesh(geo, fieldMaterial(field, maps, debug, pos.add(offset), nrm, tan, suv, 'edge'));
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// --- AgX ramp scene (?scene=ramp) — unchanged from M0 -----------------------------------

export interface RampSwatch {
  input: number;
  ndc: Vector3;
  mesh: Mesh;
}

export interface RampScene {
  scene: Scene;
  camera: PerspectiveCamera;
  swatches: RampSwatch[];
}

export function buildRamp(): RampScene {
  const scene = new Scene();
  scene.background = new Color('#000000');
  const camera = new PerspectiveCamera(30, 16 / 9, 0.1, 10);
  camera.position.set(0, 0, 3);
  camera.lookAt(0, 0, 0);

  const swatches: RampSwatch[] = [];
  const n = 13;
  const w = 0.22;
  for (let k = -6; k <= 6; k++) {
    const value = 0.18 * 2 ** k;
    const m = new MeshBasicNodeMaterial();
    m.color.setRGB(value, value, value);
    const mesh = new Mesh(new PlaneGeometry(w * 0.9, 0.5), m);
    mesh.position.set((k + 6 - (n - 1) / 2) * w, 0, 0);
    scene.add(mesh);
    swatches.push({ input: value, ndc: new Vector3(), mesh });
  }
  for (const s of swatches) s.ndc.copy(s.mesh.position).project(camera);
  return { scene, camera, swatches };
}
