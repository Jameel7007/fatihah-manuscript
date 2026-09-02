// Grade pass — §16 P8: AgX → saturation 1.05 → black lift +0.004 → vignette −0.35 EV at
// r > 0.55 → luminance-adaptive grain (IGN stand-in for blue-noise, 8 Hz phase, frozen at
// seed 0 in capture) → 1/255 dither → sRGB encode. The renderer's own tone mapping is set
// to None; PostProcessing's output transform then applies only the colorspace encode, and
// AgX is applied explicitly inside the chain (compensating AgX's mid desaturation with the
// +0.05 saturation is the §1 commitment). There is NO bloom pass.

import { AgXToneMapping, NoToneMapping, PostProcessing, WebGPURenderer } from 'three/webgpu';
import type { Camera, Scene } from 'three/webgpu';
import {
  dot,
  float,
  interleavedGradientNoise,
  mix,
  pass,
  saturation,
  screenCoordinate,
  screenUV,
  smoothstep,
  toneMapping,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export interface Grade {
  render(): void;
  /** 8 Hz grain phase — call with floor(t·8) in live mode; stays 0 in capture. */
  setGrainSeed(seed: number): void;
  setAspect(aspect: number): void;
  /** beauty-pass supersample factor (1 = native); the chain samples it down bilinearly */
  setSupersample(s: number): void;
  readonly supersample: number;
}

export function createGrade(renderer: WebGPURenderer, scene: Scene, camera: Camera): Grade {
  renderer.toneMapping = NoToneMapping; // AgX moves into the chain below

  // pass() does not render scene.background — the stage provides a physical background
  // sphere instead (ordinary scene content survives every chain), so nothing to composite.
  scene.background = null;

  const uSeed: N = uniform(0);
  const uAspect: N = uniform(16 / 9);

  const scenePass: N = pass(scene, camera);
  // v1.6.1 supersampling knob (?ss=1.5): the beauty pass renders at ss× the canvas
  // resolution and the chain samples it bilinearly at output resolution — shading (not just
  // edges) is averaged over ss² samples per pixel. Costs ss² fill; T1-only by policy.
  const SS = Number(new URLSearchParams(location.search).get('ss') ?? '1');
  let ssNow = 1;
  const setSupersample = (s: number): void => {
    const v = Math.max(1, Math.min(2, s));
    if (v === ssNow || typeof scenePass.setResolution !== 'function') return;
    ssNow = v;
    scenePass.setResolution(v);
  };
  if (SS > 1) setSupersample(SS);
  let c: N = (toneMapping as N)(AgXToneMapping, 1, scenePass.rgb);

  // saturation 1.05 (§1: compensate AgX mid desaturation) — TSL's saturation node; the
  // hand-rolled luma-mix zeroed dark pixels through the tone-mapping node graph
  c = (saturation as N)(c, 1.05);

  // black lift — §16's "+0.004" is display-REFERRED (post-encode ≈ +1/255); in the
  // display-linear domain of this chain that is 0.0004 (0.004 here floored the whole
  // frame ~18 counts above the background target)
  c = c.mul(0.9997).add(0.0003);

  const luma: N = dot(c, vec3(0.2126, 0.7152, 0.0722));

  // vignette: −0.35 EV toward corners, engaging past r = 0.55
  const rad: N = screenUV.sub(0.5).mul(vec2(uAspect, 1)).length();
  c = c.mul(mix(float(1), float(0.784), smoothstep(0.55, 1.0, rad)));

  // grain 1.2%, luminance-proportional with a small floor (display-linear absolute grain
  // washes the near-black field), deterministic per (pixel, seed); the floor term doubles
  // as the anti-banding dither — no separate dither pass
  const g: N = interleavedGradientNoise(screenCoordinate.xy.add(uSeed.mul(vec2(37.0, 17.0)))).sub(0.5);
  c = c.add(g.mul(luma.mul(0.012).add(0.0006)));

  const post = new PostProcessing(renderer);
  // TEMP diagnostic (?gb=): 1 raw, 2 AgX, 4 AgX+sat, 5 AgX+lift, 6 AgX+vignette, 0/absent full
  const BYPASS = Number(new URLSearchParams(location.search).get('gb') ?? '0');
  const agx: N = (toneMapping as N)(AgXToneMapping, 1, scenePass.rgb).toVar();
  const l3: N = dot(agx, vec3(0.2126, 0.7152, 0.0722));
  const satOnly: N = mix(vec3(l3), agx, 1.05);
  const liftOnly: N = agx.mul(0.996).add(0.004);
  const vigOnly: N = agx.mul(mix(float(1), float(0.784), smoothstep(0.55, 1.0, screenUV.sub(0.5).mul(vec2(uAspect, 1)).length())));
  const outv: N =
    BYPASS === 1 ? scenePass.rgb :
    BYPASS === 2 ? agx :
    BYPASS === 4 ? satOnly :
    BYPASS === 5 ? liftOnly :
    BYPASS === 6 ? vigOnly : c;
  post.outputNode = vec4(outv.x, outv.y, outv.z, 1);

  return {
    render: () => post.render(),
    setGrainSeed: (s: number) => {
      uSeed.value = s;
    },
    setAspect: (a: number) => {
      uAspect.value = a;
    },
    setSupersample,
    get supersample() {
      return ssNow;
    },
  };
}
