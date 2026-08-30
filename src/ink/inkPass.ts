// Ink RT pass (M3) — evaluates the §14 flat-ink layer into a sheet-space render target
// once per frame (pure f(p), deterministic). The parchment material then samples ONE
// ordinary texture. This indirection exists because the full grid/instance node graph
// inside MeshPhysicalNodeMaterial's color/roughness inputs silently breaks the material's
// light integration in three r185 WebGPU (all lights die, emissive survives — bisected
// 2026-08-27); the same node compiles and runs perfectly in a basic material, so the ink
// lives in its own pass. The §14 analytic fwidth AA happens here at RT resolution
// (2048-tall, above the display footprint of the sheet), R = coverage, G = wetness.

import { Mesh, MeshBasicNodeMaterial, OrthographicCamera, PlaneGeometry, RenderTarget, Scene, LinearFilter, RGBAFormat, UnsignedByteType, ClampToEdgeWrapping } from 'three/webgpu';
import { uv, vec2, vec4, float, texture } from 'three/tsl';
import { inkNode } from './ink';
import type { InkPack } from './atlas';

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

const RT_H = 2048;
const RT_W = Math.round(RT_H * 0.78); // sheet aspect

export class InkPass {
  readonly rt: RenderTarget;
  private scene = new Scene();
  private cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private lastP = NaN;
  private pack: InkPack;

  constructor(pack: InkPack, fiberTex: import('three/webgpu').Texture) {
    this.pack = pack;
    this.rt = new RenderTarget(RT_W, RT_H, {
      format: RGBAFormat,
      type: UnsignedByteType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
    });
    this.rt.texture.wrapS = ClampToEdgeWrapping;
    this.rt.texture.wrapT = ClampToEdgeWrapping;
    this.rt.texture.generateMipmaps = false;

    const mat = new MeshBasicNodeMaterial();
    mat.toneMapped = false;
    mat.fog = false;
    // sheet uv for this fragment: the quad's v FLIPS between RT write and texture read
    // on this backend (probed empirically 2026-08-27: a v-ramp written here reads back
    // inverted in the material), so the pass evaluates ink at 1 − uv().y
    const suv: N = vec2(uv().x, float(1).sub(uv().y));
    // §7 fiber height, same recipe as the parchment material (drives the bleed)
    const fib: N = texture(fiberTex, suv);
    const det: N = texture(fiberTex, suv.mul(6.0));
    const fiberH: N = fib.z.mul(0.7).add(det.z.mul(0.3));
    const ink = inkNode(this.pack, suv, fiberH);
    mat.colorNode = vec4(ink.cov, ink.wet, 0, 1);
    const quad = new Mesh(new PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  get texture(): import('three/webgpu').Texture {
    return this.rt.texture;
  }

  /** Render the ink layer for scroll position p. Outside [0.30, 0.64] the layer is
   *  constant in p (blank before the first window at 0.320; complete and dry after the
   *  last wet texel at ~0.625), so p clamps and unchanged clamps skip the pass. */
  run(renderer: import('three/webgpu').WebGPURenderer, p: number): void {
    const pc = Math.min(0.64, Math.max(0.3, p));
    if (pc === this.lastP) return;
    this.lastP = pc;
    this.pack.uP.value = pc;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.render(this.scene, this.cam);
    renderer.setRenderTarget(prev);
  }
}
