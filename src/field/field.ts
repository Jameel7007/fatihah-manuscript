// Surface field — §16/§17. Two render-to-texture passes shared verbatim by both backends
// (this is the spec's WebGL2 story applied everywhere; a WebGPU compute swap is an M7 perf
// option, not a correctness need at 192×256):
//   P1 eval: paramTex (silhouette-inset u,v) → pose (analytic curl, branchless) + residual
//            composed in the pose's tangent frame → posTex (rgba32f — half float is too
//            coarse for FD normals at these amplitudes).
//   P2 normals: central differences over the FINAL positions → nrmTex.
// The parchment mesh and edge ribbon fetch these textures in their vertex stage. The TSL
// node layer is typed loosely (N = node handle) — @types/three's TSL typings are not yet
// strict-friendly; the math is validated numerically by the probe harness instead.

import {
  DataTexture,
  FloatType,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RGFormat,
  RGBAFormat,
  RenderTarget,
  Scene,
  Vector2,
  Vector4,
  MeshBasicNodeMaterial,
  WebGPURenderer,
} from 'three/webgpu';
import {
  abs,
  clamp,
  cos,
  cross,
  float,
  floor,
  ivec2,
  max,
  normalize,
  sin,
  sqrt,
  step,
  texture,
  textureLoad,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Texture } from 'three/webgpu';
import { GRID_H, GRID_W, type SilhouetteData } from './silhouette';
import { THICKNESS, type DeformState } from './deform';

const SHEET_W = 0.78;

// TSL node handle — deliberately loose; see header note.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export class Field {
  readonly posRT = new RenderTarget(GRID_W, GRID_H, {
    format: RGBAFormat,
    type: FloatType,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: false,
  });
  readonly nrmRT = new RenderTarget(GRID_W, GRID_H, {
    format: RGBAFormat,
    type: FloatType,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: false,
  });

  // pose uniforms (CPU-evaluated per frame from DeformState)
  private uWt: N = uniform(0.34);
  private uWb: N = uniform(0.26);
  private uRc: N = uniform(0.0285);
  private uPhi: N = uniform(11.6);
  private uTopC: N = uniform(new Vector2(-0.16, 0.03));
  private uSag: N = uniform(-0.0118);
  private uCup: N = uniform(0.009);
  private uTwist: N = uniform(0.006);
  // bottom curl phases: (start z, start y, start angle, curvature) ×3
  private uB0: N = uniform(new Vector4(0.24, 0, 0, 1));
  private uB1: N = uniform(new Vector4(0.24, 0, 0, 1));
  private uB2: N = uniform(new Vector4(0.24, 0, 0, 1));
  // (len0, len1, len2, simEnabled)
  private uBLen: N = uniform(new Vector4(0.1, 0.1, 0.1, 1));

  private evalScene: Scene;
  private nrmScene: Scene;
  private cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private simNode: N;

  constructor(sil: SilhouetteData) {
    const paramTex = new DataTexture(sil.params, GRID_W, GRID_H, RGFormat, FloatType);
    paramTex.needsUpdate = true;

    // ---- P1: eval pass --------------------------------------------------------------
    const evalMat = new MeshBasicNodeMaterial();
    evalMat.toneMapped = false;
    evalMat.fog = false;

    // RTT rows land flipped relative to quad uv (fragment at uv.y=f writes row (1−f)·H),
    // so the param/read texel uses flipped v — output rows then align with param rows.
    const texel: N = ivec2(
      uv().x.mul(GRID_W).floor().toInt(),
      float(1).sub(uv().y).mul(GRID_H).floor().toInt(),
    );
    const par: N = textureLoad(paramTex, texel);
    const u: N = par.x;
    const v: N = par.y;

    const pose = this.poseNodes(u, v);

    // residual: bilinear frame-space sample, composed via the pose frame (§17).
    // Starts on a 1×1 zero texture — capture mode simply never binds the live sim.
    const zero = new DataTexture(new Float32Array([0, 0, 0, 0]), 1, 1, RGBAFormat, FloatType);
    zero.needsUpdate = true;
    this.simNode = texture(zero, vec2(u.add(0.5), v));
    const r: N = this.simNode.xyz.mul(this.uBLen.w);
    const T: N = vec3(1, 0, 0);
    const Nn: N = pose.normal;
    const B: N = cross(Nn, T);
    const composed: N = pose.position.add(T.mul(r.x)).add(B.mul(r.y)).add(Nn.mul(r.z));

    // outputNode = raw fragment output: bypasses the color pipeline, which clamps
    // negative components — these are data passes, not color.
    evalMat.outputNode = vec4(composed, 1.0);
    this.evalScene = passScene(evalMat);

    // ---- P2: normal pass ------------------------------------------------------------
    const nrmMat = new MeshBasicNodeMaterial();
    nrmMat.toneMapped = false;
    nrmMat.fog = false;

    const tx: N = uv().x.mul(GRID_W).floor();
    const ty: N = float(1).sub(uv().y).mul(GRID_H).floor(); // same write-row flip as P1
    const load = (dx: number, dy: number): N =>
      textureLoad(
        this.posRT.texture,
        ivec2(
          clamp(tx.add(dx), 0, GRID_W - 1).toInt(),
          clamp(ty.add(dy), 0, GRID_H - 1).toInt(),
        ),
      ).xyz;
    const dPdu: N = load(1, 0).sub(load(-1, 0));
    const dPdv: N = load(0, 1).sub(load(0, -1));
    nrmMat.outputNode = vec4(normalize(cross(dPdv, dPdu)), 0.0);
    this.nrmScene = passScene(nrmMat);
  }

  /** Branchless analytic pose: top Archimedean roll / sagging web / 3-arc bottom curl. */
  private poseNodes(u: N, v: N): { position: N; normal: N } {
    const Wt: N = this.uWt;
    const Wb: N = this.uWb;

    // --- top roll: arc length from the core is v itself; θ solves rc·θ + K/2·θ² = v
    const K: N = float(THICKNESS / (2 * Math.PI));
    const theta: N = this.uRc.negate().add(sqrt(this.uRc.mul(this.uRc).add(K.mul(2).mul(max(v, 0))))).div(K);
    const rho: N = this.uRc.add(K.mul(theta));
    const psi: N = this.uPhi.sub(theta);
    const zTop: N = this.uTopC.x.sub(rho.mul(sin(psi)));
    const yTop: N = this.uTopC.y.sub(rho.mul(cos(psi)));
    const aTop: N = psi.negate(); // profile tangent angle ≈ −ψ (spiral growth term ≪ ρ)

    // --- web: z = v − 0.5, y = sag·sin²(π·x̃) (zero slope at both curl lines)
    const webLen: N = float(1).sub(Wt).sub(Wb);
    const xw: N = clamp(v.sub(Wt).div(webLen), 0, 1);
    const zWeb: N = v.sub(0.5);
    const yWeb: N = this.uSag.mul(sin(xw.mul(Math.PI)).pow(2));
    const aWeb: N = this.uSag.mul(Math.PI).mul(sin(xw.mul(2 * Math.PI))).div(webLen);

    // --- bottom curl: chained circular arcs; phase-start poses precomputed on CPU
    const sB: N = clamp(v.sub(float(1).sub(Wb)), 0, 1);
    const seg = (ph: N, s: N): { z: N; y: N; a: N } => {
      const a1: N = ph.z.add(ph.w.mul(s));
      return {
        z: ph.x.add(sin(a1).sub(sin(ph.z)).div(ph.w)),
        y: ph.y.sub(cos(a1).sub(cos(ph.z)).div(ph.w)),
        a: a1,
      };
    };
    const l0: N = this.uBLen.x;
    const l1: N = this.uBLen.y;
    const g0 = seg(this.uB0, clamp(sB, float(0), l0));
    const g1 = seg(this.uB1, clamp(sB.sub(l0), float(0), l1));
    const g2 = seg(this.uB2, max(sB.sub(l0).sub(l1), 0));
    const in1: N = step(l0, sB);
    const in2: N = step(l0.add(l1), sB);
    const zBot: N = mix3(g0.z, g1.z, g2.z, in1, in2);
    const yBot: N = mix3(g0.y, g1.y, g2.y, in1, in2);
    const aBot: N = mix3(g0.a, g1.a, g2.a, in1, in2);

    // --- branch select (masks disjoint, seams exact by construction)
    const mTop: N = float(1).sub(step(Wt, v));
    const mBot: N = step(float(1).sub(Wb), v);
    const mWeb: N = float(1).sub(mTop).sub(mBot);
    const z: N = zTop.mul(mTop).add(zWeb.mul(mWeb)).add(zBot.mul(mBot));
    const y: N = yTop.mul(mTop).add(yWeb.mul(mWeb)).add(yBot.mul(mBot));
    const a: N = aTop.mul(mTop).add(aWeb.mul(mWeb)).add(aBot.mul(mBot));

    // profile normal in the z–y plane; cup/twist ride it, attenuated inside curls
    const nz: N = sin(a).negate();
    const ny: N = cos(a);
    const att: N = clamp(float(1).sub(abs(a).div(Math.PI).mul(0.6)), 0.3, 1);
    const lateral: N = u.mul(2);
    const dn: N = this.uCup
      .mul(lateral.mul(lateral))
      .add(this.uTwist.mul(lateral).mul(v.mul(2).sub(1)))
      .mul(att);

    const position: N = vec3(u.mul(SHEET_W), y.add(dn.mul(ny)), z.add(dn.mul(nz)));
    const normal: N = vec3(float(0), ny, nz);
    return { position, normal };
  }

  setDeform(d: DeformState, simEnabled: boolean): void {
    this.uWt.value = d.wTop;
    this.uWb.value = d.wBot;
    this.uRc.value = d.rCore;
    this.uPhi.value = d.phiTop;
    (this.uTopC.value as Vector2).set(d.topC[0], d.topC[1]);
    this.uSag.value = d.sag;
    this.uCup.value = d.cup;
    this.uTwist.value = d.twist;
    const uPh: N[] = [this.uB0, this.uB1, this.uB2];
    for (let i = 0; i < 3; i++) {
      const ph = d.bottom[Math.min(i, d.bottom.length - 1)];
      if (ph) (uPh[i].value as Vector4).set(ph.sz, ph.sy, ph.alpha, ph.kappa);
      else (uPh[i].value as Vector4).set(d.zBotCurl, 0, 0, 1);
    }
    (this.uBLen.value as Vector4).set(
      d.bottom[0]?.len ?? 1,
      d.bottom[1]?.len ?? 1,
      d.bottom[2]?.len ?? 1,
      simEnabled ? 1 : 0,
    );
  }

  /** Point the eval pass at the residual sim's freshest state (skip in capture mode). */
  bindResidual(tex: Texture): void {
    this.simNode.value = tex;
  }

  run(renderer: WebGPURenderer): void {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.posRT);
    renderer.render(this.evalScene, this.cam);
    renderer.setRenderTarget(this.nrmRT);
    renderer.render(this.nrmScene, this.cam);
    renderer.setRenderTarget(prev);
  }
}

function mix3(a: N, b: N, c: N, in1: N, in2: N): N {
  const ab: N = a.mul(float(1).sub(in1)).add(b.mul(in1));
  return ab.mul(float(1).sub(in2)).add(c.mul(in2));
}

function passScene(material: MeshBasicNodeMaterial): Scene {
  const scene = new Scene();
  const quad = new Mesh(new PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);
  return scene;
}
