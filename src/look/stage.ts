// M1 stage: field-driven parchment grid + edge ribbon + provisional §8 light skeleton, and
// the AgX ramp scene. Geometry carries no real positions — the vertex stage fetches the
// field textures by texel index (nearest, exact 1:1). Light calibration and true materials
// are M2's; the grays here exist to read shape and normals.

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
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SpotLight,
  Sphere,
  Vector3,
} from 'three/webgpu';
import { attribute, ivec2, textureLoad, transformNormalToView, vec3, vec4, vertexIndex } from 'three/tsl';
import type { Field } from '../field/field';
import { GRID_H, GRID_W, type SilhouetteData } from '../field/silhouette';
import { THICKNESS } from '../field/deform';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export type DebugMode = 'none' | 'normal' | 'matcap';

export interface Stage {
  scene: Scene;
  sheetRoot: Group;
}

export function buildStage(field: Field, sil: SilhouetteData, debug: DebugMode): Stage {
  const scene = new Scene();
  scene.background = new Color('#0D0906');

  const sheetRoot = new Group();
  scene.add(sheetRoot);

  sheetRoot.add(buildSheet(field, debug));
  sheetRoot.add(buildRibbon(field, sil, debug));

  // Gray-box rig: §8's 24° key cone is authored for the presentation states and leaves the
  // rolled composition under-covered — M1 widens it for shape work; M2 owns calibration and
  // will restate the per-state cone in the spec.
  const key = new SpotLight(0xffd2a0, 10, 0, (26 * Math.PI) / 180, 0.5, 2);
  key.position.set(-0.55, 1.3, 0.55);
  key.target.position.set(0, 0, 0.08);
  scene.add(key, key.target);

  const fill = new DirectionalLight(0xc7d8ee, 0.5);
  fill.position.set(0.85, 0.55, -0.45);
  scene.add(fill);

  // gray-box base legibility only — removed when M2's HDRI environment lands
  const hemi = new HemisphereLight(0x8a7a5c, 0x14100a, 0.55);
  scene.add(hemi);

  return { scene, sheetRoot };
}

/** Shared vertex-stage fetch + debug/standard material wiring. */
function fieldMaterial(
  field: Field,
  debug: DebugMode,
  positionNode: N,
  normalObj: N,
  gray: number,
): MeshBasicNodeMaterial | MeshStandardNodeMaterial {
  if (debug !== 'none') {
    const m = new MeshBasicNodeMaterial();
    m.side = DoubleSide;
    m.positionNode = positionNode;
    m.colorNode =
      debug === 'normal'
        ? vec4(normalObj.mul(0.5).add(0.5), 1)
        : vec4(matcapShade(normalObj), 1);
    return m;
  }
  const m = new MeshStandardNodeMaterial();
  m.side = DoubleSide;
  m.color.setRGB(gray, gray, gray);
  m.roughness = 0.8;
  m.positionNode = positionNode;
  m.normalNode = transformNormalToView(normalObj);
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

  const mesh = new Mesh(geo, fieldMaterial(field, debug, pos, nrm, 0.18));
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

  const mesh = new Mesh(geo, fieldMaterial(field, debug, pos.add(offset), nrm, 0.1));
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
