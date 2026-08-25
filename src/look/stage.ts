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
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SpotLight,
  Sphere,
  Vector3,
} from 'three/webgpu';
import { attribute, faceDirection, ivec2, textureLoad, transformNormalToView, vec3, vec4, vertexIndex } from 'three/tsl';
import type { Field } from '../field/field';
import { GRID_H, GRID_W, type SilhouetteData } from '../field/silhouette';
import { THICKNESS } from '../field/deform';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export type DebugMode = 'none' | 'normal' | 'matcap' | 'graycard';

// §16 background pre-compensation — scene-linear clear color that the live AgX pipeline
// displays as exactly #0D0906. Baked from `?calibrate=bg` (secant solve against readback);
// re-run the harness whenever the tone/grade chain changes.
// Solved 2026-08-25: displays rgb(13, 9, 6) exactly. Note the values are ~6–15× the naive
// hex→linear conversion — AgX's toe crushes near-black, which is the §16 premise.
export const BG_LINEAR: [number, number, number] = [0.00798, 0.00648, 0.00504];

// §8 key intensity — 18% gray card at sheet center under key alone displays 128/255.
// Baked from `?calibrate=key`; re-run when key geometry/cone changes or the HDRI lands.
export const KEY_INTENSITY = 9.99; // solved 2026-08-25: 18% card displays R=128 exactly

export interface Stage {
  scene: Scene;
  sheetRoot: Group;
  key: SpotLight;
}

export function buildStage(field: Field, sil: SilhouetteData, debug: DebugMode): Stage {
  const scene = new Scene();
  scene.background = new Color().setRGB(BG_LINEAR[0], BG_LINEAR[1], BG_LINEAR[2]);

  const sheetRoot = new Group();
  scene.add(sheetRoot);

  sheetRoot.add(buildSheet(field, debug));
  sheetRoot.add(buildRibbon(field, sil, debug));

  // §8 rig — positions, colors, and ratios per the table; the key cone stays widened to 26°
  // for the rolled states (the spec's 24° is restated per-state when PCSS lands). Shadows,
  // HDRI environment, and the rim's state schedule are the remaining M2 lighting work.
  const key = new SpotLight(0xffd2a0, KEY_INTENSITY, 0, (26 * Math.PI) / 180, 0.5, 2);
  key.position.set(-0.55, 1.3, 0.85);
  key.target.position.set(0, 0.04, 0.2);
  scene.add(key, key.target);

  const fill = new DirectionalLight(0xc7d8ee, 0.13 * 2.2); // §8 ratio 0.13 vs key ≈ 1.0 (directional-vs-spot units differ; ratio re-anchored at HDRI time)
  fill.position.set(0.85, 0.55, -0.45);
  scene.add(fill);

  const rim = new SpotLight(0xffbe83, KEY_INTENSITY * 0.3, 0, (28 * Math.PI) / 180 / 2, 0.6, 2);
  rim.position.set(-0.35, 0.18, -1.05);
  rim.target.position.set(0, 0, 0);
  scene.add(rim, rim.target);

  // stand-in ambience until the authored HDRI lands (then removed)
  const hemi = new HemisphereLight(0x8a7a5c, 0x14100a, 0.35);
  scene.add(hemi);

  return { scene, sheetRoot, key };
}

/** Shared vertex-stage fetch + debug/material wiring. `kind` picks the §7 material row. */
function fieldMaterial(
  field: Field,
  debug: DebugMode,
  positionNode: N,
  normalObj: N,
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
  // §7 parchment recto base: color/rough/sheen; fiber maps, verso tint, wear, and the wrap
  // translucency land with the texture + PCSS passes of M2
  const m = new MeshPhysicalNodeMaterial();
  m.side = DoubleSide;
  m.color.set('#E6D5AF');
  m.roughness = 0.62;
  m.sheen = 0.18;
  m.sheenColor.set('#E8DCC0');
  m.sheenRoughness = 0.55;
  m.positionNode = positionNode;
  m.normalNode = transformNormalToView(normalObj).mul(faceDirection);
  return m;
}

/** Simple two-band shading purely from the object normal — faceting inspection (§20 M1). */
function matcapShade(n: N): N {
  const l1: N = n.dot(vec3(0.42, 0.78, 0.46)).mul(0.5).add(0.5);
  const l2: N = n.dot(vec3(-0.6, 0.2, -0.77)).max(0).mul(0.25);
  return vec3(l1.mul(l1).add(l2));
}

function buildSheet(field: Field, debug: DebugMode): Mesh {
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
  const texel: N = ivec2(vi.sub(tj.mul(GRID_W)), tj);
  const pos: N = textureLoad(field.posRT.texture, texel).xyz;
  const nrm: N = textureLoad(field.nrmRT.texture, texel).xyz;

  const mesh = new Mesh(geo, fieldMaterial(field, debug, pos, nrm, 'parchment'));
  mesh.frustumCulled = false;
  return mesh;
}

function buildRibbon(field: Field, sil: SilhouetteData, debug: DebugMode): Mesh {
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
  const offset: N = nrm.mul(-THICKNESS).mul(attribute('side', 'float'));

  const mesh = new Mesh(geo, fieldMaterial(field, debug, pos.add(offset), nrm, 'edge'));
  mesh.frustumCulled = false;
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
