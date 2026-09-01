// §8 contact-shadow blob (M5) — "the signature moment, named". A height-field pass over the
// glyphs only, orthographic over the sheet (frustum 0.9 × 1.15, 512²), storing coverage +
// height-above-sheet; then two separable blur passes whose radius follows the caster's
// height (radius_texels = 2 + 640·h), composited into the parchment BRDF as
//   × (1 − 0.75 · C · exp(−h / 0.12) · ramp)
// Authored blur, zero sampling noise — the part of the contact shadow that survives a 390 px
// viewport where PCSS alone dissolves into its filter. Pure f(p): re-rendered whenever the
// scroll position changes inside the rise.
//
// Storage is RGBA8 (R = coverage, G = height / 0.2): the physical material samples it, and
// float render targets sampled there are a known three r185 WebGPU hazard.

import { Color, LinearFilter, Mesh, MeshBasicNodeMaterial, OrthographicCamera, PlaneGeometry, RGBAFormat, RenderTarget, Scene, UnsignedByteType, ClampToEdgeWrapping, Vector2 } from 'three/webgpu';
import { float, texture, uniform, uv, vec2, vec4 } from 'three/tsl';

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

export const BLOB_W = 0.9; // ortho frustum, world (sheet is 0.78 × 1.0)
export const BLOB_H = 1.15;
const SIZE = 512;

function makeRT(): RenderTarget {
  const rt = new RenderTarget(SIZE, SIZE, {
    format: RGBAFormat,
    type: UnsignedByteType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: true,
  });
  rt.texture.wrapS = ClampToEdgeWrapping;
  rt.texture.wrapT = ClampToEdgeWrapping;
  rt.texture.generateMipmaps = false;
  return rt;
}

export class ContactBlob {
  private rtH = makeRT();
  private rtA = makeRT();
  private rtB = makeRT();
  private cam = new OrthographicCamera(-BLOB_W / 2, BLOB_W / 2, BLOB_H / 2, -BLOB_H / 2, 0.01, 2.0);
  private heightScene = new Scene();
  private blurScene = new Scene();
  private uDir: N = uniform(new Vector2(1, 0));
  private lastP = NaN;
  private mesh: Mesh;
  private heightMat: MeshBasicNodeMaterial;
  private blurMat: MeshBasicNodeMaterial;
  private blurQuad: Mesh;
  private blurSrc: N;
  private taps: N[] = [];
  private cam2 = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private savedClear = new Color();

  constructor(mesh: Mesh, heightMat: MeshBasicNodeMaterial) {
    this.mesh = mesh;
    this.heightMat = heightMat;
    // camera above the sheet, looking straight down; +z (down the page) maps to −v of the
    // RT, which the composite accounts for (it maps object position → blob uv explicitly)
    this.cam.position.set(0, 1.0, 0);
    this.cam.up.set(0, 0, -1);
    this.cam.lookAt(0, 0, 0);
    this.cam.updateProjectionMatrix();

    // separable blur with height-driven radius: 13 taps across ±radius, Gaussian weights
    this.blurMat = new MeshBasicNodeMaterial();
    this.blurMat.toneMapped = false;
    this.blurMat.fog = false;
    const dirU: N = this.uDir;
    const srcTex = texture(this.rtH.texture, uv()); // rebound per pass via .value
    this.blurSrc = srcTex;
    const center: N = srcTex;
    const hWorld: N = center.g.mul(0.2);
    const radius: N = hWorld.mul(640).add(2).div(SIZE); // texels → uv
    let accC: N = float(0);
    let accH: N = float(0);
    let wsum = 0;
    const TAPS = 13;
    for (let k = 0; k < TAPS; k++) {
      const o = (k - (TAPS - 1) / 2) / ((TAPS - 1) / 2); // −1..1
      const w = Math.exp(-2.2 * o * o);
      wsum += w;
      const s: N = texture(this.rtH.texture, uv().add(vec2(dirU.x, dirU.y).mul(radius.mul(o))));
      this.taps.push(s);
      accC = accC.add(s.r.mul(w));
      accH = accH.add(s.g.mul(w));
    }
    this.blurMat.outputNode = vec4(accC.div(wsum), accH.div(wsum), 0, 1);
    this.blurQuad = new Mesh(new PlaneGeometry(2, 2), this.blurMat);
    this.blurQuad.frustumCulled = false;
    this.blurScene.add(this.blurQuad);
  }

  get texture(): import('three/webgpu').Texture {
    return this.rtB.texture;
  }

  /** Render the blob for p (the rise + facing states). Skips unchanged p. */
  run(renderer: import('three/webgpu').WebGPURenderer, p: number): void {
    if (p === this.lastP) return;
    this.lastP = p;
    const prevRT = renderer.getRenderTarget();
    const savedAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.savedClear);
    // 1. height pass — the glyph mesh alone with the height material
    const savedMat = this.mesh.material;
    const savedVisible = this.mesh.visible;
    const savedParent = this.mesh.parent;
    this.mesh.material = this.heightMat;
    this.mesh.visible = true;
    this.heightScene.add(this.mesh); // reparent for the pass (world transform is identity during the rise)
    renderer.setRenderTarget(this.rtH);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(this.heightScene, this.cam);
    if (savedParent) savedParent.add(this.mesh);
    this.mesh.material = savedMat;
    this.mesh.visible = savedVisible;
    // 2. blur H → A, 3. blur V → B
    this.setSource(this.rtH.texture);
    (this.uDir.value as Vector2).set(1, 0);
    renderer.setRenderTarget(this.rtA);
    renderer.render(this.blurScene, this.cam2);
    this.setSource(this.rtA.texture);
    (this.uDir.value as Vector2).set(0, 1);
    renderer.setRenderTarget(this.rtB);
    renderer.render(this.blurScene, this.cam2);
    renderer.setClearColor(this.savedClear, savedAlpha);
    renderer.setRenderTarget(prevRT);
  }

  private setSource(tex: import('three/webgpu').Texture): void {
    this.blurSrc.value = tex;
    for (const t of this.taps) t.value = tex;
  }
}
