// M2 procedural maps — deterministic, generated on-GPU once at boot. These stand in for
// the authored KTX2 assets (§7/§18) with the same channel contracts, so the material code
// is unchanged when authored maps land:
//   fiber (1024², repeat): R,G = fiber normal slope xy · B = height · A = roughness-mod
//   util  (512²):          R = macro discoloration · G = blotch · B = verso mottle · A = stains
//   env   (512×256 equirect, HDR): §8's authored room — near-black walls, one tall warm
//     window 35° left of +Z at +20° elevation (6× diffuse white), cool floor-bounce card,
//     three warm pinpoints on the right hemisphere for bevel sparkle variety.
// Noise is a sinless hash (large sin() args band on some GPUs); everything is a pure
// function of uv — capture-safe.

import {
  EquirectangularReflectionMapping,
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  RenderTarget,
  RepeatWrapping,
  Scene,
  Texture,
  WebGPURenderer,
} from 'three/webgpu';
import { cos, dot, float, fract, mix, sin, smoothstep, uv, vec2, vec3, vec4 } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** Sinless 2D hash → [0,1). */
function hash2(p: N): N {
  const p3: N = fract(vec3(p.x, p.y, p.x).mul(0.1031));
  const q: N = p3.add(dot(p3, vec3(p3.y, p3.z, p3.x).add(33.33)));
  return fract(q.x.add(q.y).mul(q.z));
}

/** Value noise. */
function vnoise(p: N): N {
  const i: N = p.floor();
  const f: N = fract(p);
  const u2: N = f.mul(f).mul(f.mul(-2).add(3));
  const a: N = hash2(i);
  const b: N = hash2(i.add(vec2(1, 0)));
  const c: N = hash2(i.add(vec2(0, 1)));
  const d: N = hash2(i.add(vec2(1, 1)));
  return mix(mix(a, b, u2.x), mix(c, d, u2.x), u2.y);
}

/** 4-octave fBm, normalized to ~[0,1]. */
function fbm4(p: N): N {
  const s: N = vnoise(p)
    .mul(0.5)
    .add(vnoise(p.mul(2.03).add(17.1)).mul(0.25))
    .add(vnoise(p.mul(4.01).add(31.7)).mul(0.125))
    .add(vnoise(p.mul(8.09).add(57.3)).mul(0.0625));
  return s.div(0.9375);
}

function bake(
  renderer: WebGPURenderer,
  w: number,
  h: number,
  outputNode: N,
  opts?: { repeat?: boolean; equirect?: boolean },
): Texture {
  const rt = new RenderTarget(w, h, {
    format: RGBAFormat,
    type: HalfFloatType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
  });
  if (opts?.repeat) {
    rt.texture.wrapS = RepeatWrapping;
    rt.texture.wrapT = RepeatWrapping;
  }
  if (opts?.equirect) rt.texture.mapping = EquirectangularReflectionMapping;
  rt.texture.generateMipmaps = true;
  const mat = new MeshBasicNodeMaterial();
  mat.toneMapped = false;
  mat.fog = false;
  mat.outputNode = outputNode;
  const scene = new Scene();
  const quad = new Mesh(new PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  scene.add(quad);
  const cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prev);
  return rt.texture;
}

export function buildFiberTexture(renderer: WebGPURenderer): Texture {
  const heightAt = (p: N): N => {
    const grain: N = fbm4(p.mul(vec2(340, 280)));
    const undul: N = fbm4(p.mul(vec2(36, 30)).add(7.7));
    const dots: N = smoothstep(0.8, 0.88, vnoise(p.mul(170).add(3.9))); // follicle character
    return grain.mul(0.6).add(undul.mul(0.32)).add(dots.mul(0.08));
  };
  const p: N = uv();
  const e = 1 / 1024;
  const h: N = heightAt(p);
  const nx: N = heightAt(p.add(vec2(e, 0))).sub(heightAt(p.sub(vec2(e, 0)))).mul(0.5 / e);
  const ny: N = heightAt(p.add(vec2(0, e))).sub(heightAt(p.sub(vec2(0, e)))).mul(0.5 / e);
  const rough: N = fbm4(p.mul(vec2(22, 18)).add(3.3));
  return bake(renderer, 1024, 1024, vec4(nx, ny, h, rough), { repeat: true });
}

export function buildUtilTexture(renderer: WebGPURenderer): Texture {
  const p: N = uv();
  const macro: N = fbm4(p.mul(3.1));
  const blotch: N = fbm4(p.mul(7.0).add(11.7));
  const verso: N = fbm4(p.mul(5.2).add(23.1));
  // §15 historic stains — two fixed soft spots, lower-left quadrant
  const s1: N = smoothstep(0.062, 0.0, p.sub(vec2(0.26, 0.71)).length());
  const s2: N = smoothstep(0.09, 0.0, p.sub(vec2(0.37, 0.79)).length());
  const stains: N = s1.max(s2.mul(0.8));
  return bake(renderer, 512, 512, vec4(macro, blotch, verso, stains));
}

export function buildEnvironment(renderer: WebGPURenderer): Texture {
  const p: N = uv();
  // equirect direction: azimuth from +Z, elevation up
  const az: N = p.x.mul(Math.PI * 2).sub(Math.PI);
  const el: N = p.y.sub(0.5).mul(Math.PI);

  // near-black room with a warm lift toward the floor
  const base: N = vec3(0.02, 0.016, 0.012).add(
    vec3(0.06, 0.045, 0.03).mul(smoothstep(0.1, -0.9, sin(el))),
  );

  // tall warm window: az −35°, el +20°, ~13° × 28°, soft 4° edges, 6× diffuse white
  const azW = (-35 * Math.PI) / 180;
  const elW = (20 * Math.PI) / 180;
  const dAz: N = az.sub(azW);
  const dEl: N = el.sub(elW);
  const winX: N = smoothstep(0.155, 0.085, dAz.abs());
  const winY: N = smoothstep(0.31, 0.175, dEl.abs());
  const window_: N = winX.mul(winY);
  const winCol: N = vec3(6.0, 3.9, 2.1); // 3200 K at 6× diffuse white

  // cool floor-bounce card opposite the window, ~3% of window luminance
  const dAzB: N = az.sub((145 * Math.PI) / 180);
  const bounce: N = smoothstep(0.8, 0.2, dAzB.abs()).mul(smoothstep(0.15, -0.55, el));
  const bounceCol: N = vec3(0.1, 0.13, 0.17);

  // three warm pinpoints, right hemisphere — bevel sparkle variety (§8)
  const pin = (a: number, e2: number, s: number): N => {
    const d: N = az.sub(a).mul(cos(float(e2))).pow(2).add(el.sub(e2).pow(2));
    return d.mul(-1 / (s * s)).exp();
  };
  const pins: N = pin((60 * Math.PI) / 180, (5 * Math.PI) / 180, 0.035)
    .add(pin((100 * Math.PI) / 180, (15 * Math.PI) / 180, 0.03))
    .add(pin((140 * Math.PI) / 180, (-5 * Math.PI) / 180, 0.03));
  const pinCol: N = vec3(2.5, 1.5, 0.7);

  const col: N = base
    .add(winCol.mul(window_))
    .add(bounceCol.mul(bounce))
    .add(pinCol.mul(pins));
  return bake(renderer, 512, 256, vec4(col, 1), { equirect: true });
}
