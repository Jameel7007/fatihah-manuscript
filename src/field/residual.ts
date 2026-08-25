// Residual inertia layer — §17 (v1.1). Frame-space residual on a 48×64 lattice, solved as
// Jacobi-relaxed position-based dynamics on ping-pong float textures — identical passes on
// WebGPU and WebGL2 (the spec's WebGL2 story, unified; a compute swap is an M7 perf option).
// State texture: rgb = (r_t, r_b, r_n), a = v_n. Only the normal component has dynamics —
// excitation acts along the pose frame's N near the two moving curl lines. Per frame:
//   predict: v' = (v + dt·(F − k_ret·r_n))·exp(−3.5·dt);  r_n' = r_n + dt·v'  (clamped)
//   relax ×6: r ← r + 0.5·(avg4(r) − r), border pinned      (rest-0 stretch + bend, Jacobi)
// The PBD velocity re-derivation after relaxation is folded into the damping constant — a
// solver simplification, not a behavior change: the field still provably decays to zero
// (return spring + damping + pinned-border diffusion).

import {
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  RenderTarget,
  Scene,
  WebGPURenderer,
} from 'three/webgpu';
import { clamp, exp, float, texture, uniform, uv, vec2, vec4 } from 'three/tsl';

export const SIM_W = 48;
export const SIM_H = 64;
const RELAX_ITERS = 6;
const K_RETURN = 90; // s⁻² — soft spring toward zero rest (bending-stiffness stand-in)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

function makeRT(): RenderTarget {
  return new RenderTarget(SIM_W, SIM_H, {
    format: RGBAFormat,
    type: HalfFloatType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
  });
}

export class Residual {
  private rtA = makeRT();
  private rtB = makeRT();
  private fresh: RenderTarget;
  private cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  private uDt: N = uniform(1 / 60);
  private uVel: N = uniform(0);
  private uWt: N = uniform(0.34);
  private uWb: N = uniform(0.26);

  private predictScene: Scene;
  private relaxScene: Scene;
  private predictSrc: N;
  private relaxSrcs: N[]; // center, +u, −u, +v, −v — .value swapped together

  constructor() {
    this.fresh = this.rtA;

    // ---- predict pass ------------------------------------------------------------------
    const pm = new MeshBasicNodeMaterial();
    pm.toneMapped = false;
    pm.fog = false;
    // RTT write rows are flipped vs quad uv; read at flipped uv so each fragment reads
    // the row it writes, and the force profile uses the written row's param v.
    const flipUV: N = vec2(uv().x, float(1).sub(uv().y));
    this.predictSrc = texture(this.rtA.texture, flipUV);
    const s: N = this.predictSrc;
    const v01: N = float(1).sub(uv().y);
    const g = (c: N): N => exp(v01.sub(c).div(0.06).pow(2).negate());
    const forceN: N = this.uVel.mul(-0.35).mul(g(this.uWt).add(g(float(1).sub(this.uWb))));
    const damp: N = exp(this.uDt.mul(-3.5));
    const vn1: N = s.w.add(forceN.sub(s.z.mul(K_RETURN)).mul(this.uDt)).mul(damp);
    const rn1: N = s.z.add(vn1.mul(this.uDt)).clamp(-0.0027, 0.0027);
    const m: N = interiorMask();
    pm.outputNode = vec4(
      s.x.clamp(-0.004, 0.004).mul(m),
      s.y.clamp(-0.004, 0.004).mul(m),
      rn1.mul(m),
      vn1.mul(m),
    );
    this.predictScene = passScene(pm);

    // ---- relax pass --------------------------------------------------------------------
    const rm = new MeshBasicNodeMaterial();
    rm.toneMapped = false;
    rm.fog = false;
    const du = 1 / SIM_W;
    const dv = 1 / SIM_H;
    const offsets: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    this.relaxSrcs = offsets.map(([dx, dy]) =>
      texture(
        this.rtA.texture,
        vec2(
          uv().x.add(dx * du).clamp(0.001, 0.999),
          float(1).sub(uv().y).add(dy * dv).clamp(0.001, 0.999),
        ),
      ),
    );
    const [c0, cpu, cmu, cpv, cmv] = this.relaxSrcs as [N, N, N, N, N];
    const avg: N = cpu.xyz.add(cmu.xyz).add(cpv.xyz).add(cmv.xyz).mul(0.25);
    const relaxed: N = c0.xyz.add(avg.sub(c0.xyz).mul(0.5));
    const m2: N = interiorMask();
    rm.outputNode = vec4(
      relaxed.x.mul(m2),
      relaxed.y.mul(m2),
      relaxed.z.mul(m2),
      c0.w.mul(m2),
    );
    this.relaxScene = passScene(rm);
  }

  setInputs(dt: number, vLpf: number, wTop: number, wBot: number): void {
    this.uDt.value = Math.min(dt, 1 / 30);
    this.uVel.value = Math.max(-2.0 / 0.35, Math.min(2.0 / 0.35, vLpf));
    this.uWt.value = wTop;
    this.uWb.value = wBot;
  }

  step(renderer: WebGPURenderer): void {
    const prev = renderer.getRenderTarget();
    this.predictSrc.value = this.rtA.texture;
    renderer.setRenderTarget(this.rtB);
    renderer.render(this.predictScene, this.cam);
    let read = this.rtB;
    let write = this.rtA;
    for (let i = 0; i < RELAX_ITERS; i++) {
      for (const n of this.relaxSrcs) n.value = read.texture;
      renderer.setRenderTarget(write);
      renderer.render(this.relaxScene, this.cam);
      [read, write] = [write, read];
    }
    // freshest state = last written = `read` after the final swap
    this.fresh = read;
    renderer.setRenderTarget(prev);
  }

  /** Render target holding the current state — for QA readback and field binding. */
  freshRT(): RenderTarget {
    return this.fresh;
  }
}

function interiorMask(): N {
  const x: N = uv().x.mul(SIM_W);
  const y: N = uv().y.mul(SIM_H);
  return clamp(x, 0, 1)
    .mul(clamp(float(SIM_W).sub(x), 0, 1))
    .mul(clamp(y, 0, 1))
    .mul(clamp(float(SIM_H).sub(y), 0, 1));
}

function passScene(material: MeshBasicNodeMaterial): Scene {
  const scene = new Scene();
  const quad = new Mesh(new PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);
  return scene;
}
