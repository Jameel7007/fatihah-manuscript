// §15 dust — ≤ 900 motes crossing the key beam, #E8DCC2 at opacity 0.030–0.045, soft-disc
// sprites with size + opacity falloff (no DoF pass: quieting is done by size/opacity). The
// motion is a pure function of the dust clock (deterministic), hidden in capture mode and in
// reduced motion. "Two dust motes per second crossing the key beam" — the population drifts
// slowly through a volume above the sheet along the key's direction with a slight rise.

import { AdditiveBlending, InstancedBufferAttribute, PointsNodeMaterial, Sprite } from 'three/webgpu';
import { float, instancedBufferAttribute, uniform, uv, vec3, vec4 } from 'three/tsl';

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

const COUNT = 640;
const VOL: [number, number, number] = [1.1, 0.7, 1.2]; // world extent of the mote volume (x, y, z)

export class Dust {
  readonly points: Sprite;
  private uT: N = uniform(0);
  private uFade: N = uniform(0);

  constructor() {
    const pos = new Float32Array(COUNT * 3);
    const seed = new Float32Array(COUNT * 4); // phase, speed, size, opacity
    // deterministic pseudo-random (LCG) — same cloud on every load
    let s = 20260901;
    const rnd = (): number => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < COUNT; i++) {
      pos[i * 3] = (rnd() - 0.5) * VOL[0];
      pos[i * 3 + 1] = rnd() * VOL[1] + 0.02;
      pos[i * 3 + 2] = (rnd() - 0.5) * VOL[2];
      seed[i * 4] = rnd() * Math.PI * 2;
      seed[i * 4 + 1] = 0.6 + rnd() * 0.8;
      seed[i * 4 + 2] = 0.55 + rnd() * 0.9;
      seed[i * 4 + 3] = 0.03 + rnd() * 0.015;
    }

    const mat = new PointsNodeMaterial();
    // WebGPU point primitives are always one pixel and have no gl_PointCoord. Three's
    // supported larger-point path is a counted Sprite driven by instanced attributes.
    const base: N = instancedBufferAttribute(new InstancedBufferAttribute(pos, 3));
    const sd: N = instancedBufferAttribute(new InstancedBufferAttribute(seed, 4));
    const t: N = this.uT.mul(sd.y).add(sd.x);
    // slow drift along the key beam (−x, +z toward the viewer) with a gentle lift and sway
    const drift: N = vec3(
      t.mul(0.011).negate().add(t.mul(0.37).sin().mul(0.012)),
      t.mul(0.004).add(t.mul(0.23).cos().mul(0.006)),
      t.mul(0.013).add(t.mul(0.31).sin().mul(0.009)),
    );
    // wrap the drift inside the volume so the cloud never empties
    const wrapped: N = base.add(drift).add(vec3(VOL[0] / 2, 0, VOL[2] / 2)).mod(vec3(VOL[0], VOL[1], VOL[2])).sub(vec3(VOL[0] / 2, 0, VOL[2] / 2));
    mat.positionNode = wrapped;
    // With attenuation enabled this is a world-space diameter. Passing the old pixel-like
    // value (4.5) made every quad hundreds of pixels wide and overlapped into a white veil.
    mat.sizeNode = sd.z.mul(0.012);
    mat.sizeAttenuation = true;
    // soft disc
    const d: N = uv().sub(0.5).length().mul(2);
    const disc: N = float(1).sub(d).clamp(0, 1).pow(1.6);
    mat.colorNode = vec4(vec3(0.91, 0.863, 0.76).mul(disc), disc.mul(sd.w).mul(this.uFade));
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = AdditiveBlending;
    mat.fog = false;

    this.points = new Sprite(mat);
    this.points.count = COUNT;
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.visible = false;
  }

  /** Advance the dust clock (seconds) and set visibility fade 0..1. */
  update(dt: number, fade: number, population = 1): void {
    this.uT.value += dt;
    this.uFade.value = fade;
    this.points.count = Math.round(COUNT * population);
    this.points.visible = fade > 0.001 && this.points.count > 0;
  }
}
