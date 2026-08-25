// M0 stage: gray-box sheet + provisional §8 light skeleton, and the AgX ramp scene.
// Light intensities here are eyeballed placeholders — M2 owns the 18%-gray calibration,
// shadows, materials, and the §16 background pre-compensation (background is naive sRGB
// #0D0906 for now).

import {
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SpotLight,
  Vector3,
} from 'three/webgpu';

export interface Stage {
  scene: Scene;
  sheetRoot: Group;
}

export function buildStage(): Stage {
  const scene = new Scene();
  scene.background = new Color('#0D0906');

  const sheetRoot = new Group();
  scene.add(sheetRoot);

  const geo = new PlaneGeometry(0.78, 1.0, 96, 128);
  geo.rotateX(-Math.PI / 2); // sheet in XZ, +Y up, top edge toward −Z (§2)
  const mat = new MeshStandardNodeMaterial();
  mat.color.setRGB(0.18, 0.18, 0.18); // 18% gray card — the §8 calibration anchor
  mat.roughness = 0.8;
  sheetRoot.add(new Mesh(geo, mat));

  const key = new SpotLight(0xffd2a0, 10, 0, (12 * Math.PI) / 180, 0.45, 2);
  key.position.set(-0.55, 1.3, 0.55);
  key.target.position.set(0, 0, 0);
  scene.add(key, key.target);

  const fill = new DirectionalLight(0xc7d8ee, 0.35);
  fill.position.set(0.85, 0.55, -0.45);
  scene.add(fill);

  return { scene, sheetRoot };
}

// --- AgX ramp scene (?scene=ramp) -------------------------------------------------------
// 13 neutral swatches at linear 0.18·2^k, k = −6…+6, rendered through the full output
// pipeline. The probe asserts monotonicity and neutrality; values are logged for the record.

export interface RampSwatch {
  input: number; // scene-linear value
  ndc: Vector3; // projected center, filled after camera setup
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
  for (const s of swatches) {
    s.ndc.copy(s.mesh.position).project(camera);
  }
  return { scene, camera, swatches };
}
