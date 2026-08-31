// §6/§14 glyph relief (M4) — the merged bevel-extrusion mesh, born ink-colored inside the
// geometry-handoff window. Geometry carries NO world positions: every vertex stores its
// sheet anchor (su, sv) + normalized profile height hn, and the vertex stage fetches the
// SAME surface-field textures the parchment reads (§14 z-guard: "the base ring fetches its
// position from the same surface-field posTex as the parchment — watertight by
// construction"). Interior field texels are identity params (silhouette inset reaches
// ~3 border rings; the text band is deep interior), so the anchor maps straight onto the
// field grid with a manual bilinear (4 textureLoads — the RTs are NearestFilter, and
// float32-linear sampling is a WebGPU feature gamble this project doesn't take).
//
// Height: worldOffset = hn · max(uGeoDepth, kindScale · uRise). uGeoDepth follows the §14
// handoff (0.00045 → 0.0012 over p ∈ [0.690, 0.730], drivers.geoDepth); uRise is the M5
// per-āyah stagger hook (0 in M4 — entry is kind-uniform, §6 depth ratios engage with the
// rise via the max()). The mesh is hidden below the window (applyFrame).
//
// Color: the same flat-ink composite the parchment runs (ink RT sample at suv, wet/dry
// explicit-lerp — the TSL mix() gotcha applies — fiber cavity), times the baked root AO,
// so at emergence the caps are indistinguishable from the flat layer beneath them.

import { BufferAttribute, BufferGeometry, Mesh, MeshPhysicalNodeMaterial, Sphere, Vector3 } from 'three/webgpu';
import { attribute, color, cross, dFdx, dFdy, float, ivec2, texture, textureLoad, transformNormalToView, uniform, varying, vec2 } from 'three/tsl';
import type { Field } from '../field/field';
import { GRID_H, GRID_W } from '../field/silhouette';
import { INK_DRY, INK_WET } from '../ink/ink';

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

export interface GlyphBin {
  meta: {
    version: number;
    counts: { verts: number; tris: number; groups: number };
    depth: number;
    bevel: number;
  };
  anchor: Uint16Array;
  nrm: Int8Array;
  aux: Uint8Array;
  auvQ: Uint16Array;
  index: Uint32Array;
}

export async function loadGlyphBin(url: string): Promise<GlyphBin> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`glyphs.bin: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'FGLY') throw new Error(`glyphs.bin: bad magic ${magic}`);
  const version = dv.getUint32(4, true);
  const jsonLen = dv.getUint32(8, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, jsonLen)));
  const bufs = meta.buffers as Record<string, { offset: number; length: number } | undefined>;
  const b = (name: string): { offset: number; length: number } => {
    const r = bufs[name];
    if (!r) throw new Error(`glyphs.bin: missing buffer ${name}`);
    return r;
  };
  return {
    meta: { version, ...meta },
    anchor: new Uint16Array(buf, b('anchor').offset, b('anchor').length / 2),
    nrm: new Int8Array(buf, b('nrm').offset, b('nrm').length),
    aux: new Uint8Array(buf, b('aux').offset, b('aux').length),
    auvQ: new Uint16Array(buf, b('auv').offset, b('auv').length / 2),
    index: new Uint32Array(buf, b('index').offset, b('index').length / 4),
  };
}

export interface GlyphRelief {
  mesh: Mesh;
  /** §14 handoff depth (world) — drivers.geoDepth(p); mesh hidden below the window */
  uGeoDepth: { value: number };
  /** M5 per-āyah rise stagger depth (world) — 0 through M4 */
  uRise: { value: number };
}

export function buildGlyphRelief(
  bin: GlyphBin,
  field: Field,
  fiberTex: import('three/webgpu').Texture,
  inkTex: import('three/webgpu').Texture,
): GlyphRelief {
  const geo = new BufferGeometry();
  const nVerts = bin.anchor.length / 4;
  geo.setAttribute('position', new BufferAttribute(new Float32Array(nVerts * 3), 3)); // zeros — positionNode owns it (same pattern as the parchment grid)
  geo.setAttribute('aAnchor', new BufferAttribute(bin.anchor, 4, true));
  geo.setAttribute('aNrm', new BufferAttribute(bin.nrm, 4, true));
  geo.setAttribute('aAux', new BufferAttribute(bin.aux, 4, true));
  geo.setAttribute('aAuv', new BufferAttribute(bin.auvQ, 2, true));
  geo.setIndex(new BufferAttribute(bin.index, 1));
  geo.boundingSphere = new Sphere(new Vector3(0, 0, 0), 1.2);

  const uGeoDepth = uniform(0.00045);
  const uRise = uniform(0);

  const m = new MeshPhysicalNodeMaterial();
  // §14 z-guard: depthBias −2 / slopeScale −0.5 on the glyph main pass (shadow/contact
  // pipelines stay unbiased — the mesh casts no shadow until the M5 rise)
  m.polygonOffset = true;
  m.polygonOffsetFactor = -0.5;
  m.polygonOffsetUnits = -2;

  const anc: N = attribute('aAnchor', 'vec4'); // su, sv, hn, kindScale
  const npl: N = attribute('aNrm', 'vec4'); // plan-frame relief normal
  const aux: N = attribute('aAux', 'vec4'); // ayah/8, root AO, roughness floor, 0
  void attribute('aAuv', 'vec2'); // atlas uv — reserved for the M5 gold stage

  // manual bilinear over the field textures at the anchor (grid = identity params interior)
  const gx: N = anc.x.mul(GRID_W - 1);
  const gy: N = anc.y.mul(GRID_H - 1);
  const i0: N = gx.floor();
  const j0: N = gy.floor();
  const fx: N = gx.sub(i0);
  const fy: N = gy.sub(j0);
  const fetch2 = (tex: import('three/webgpu').Texture): N => {
    const i1: N = i0.add(1).min(GRID_W - 1);
    const j1: N = j0.add(1).min(GRID_H - 1);
    const t00: N = textureLoad(tex, ivec2(i0.toInt(), j0.toInt())).xyz;
    const t10: N = textureLoad(tex, ivec2(i1.toInt(), j0.toInt())).xyz;
    const t01: N = textureLoad(tex, ivec2(i0.toInt(), j1.toInt())).xyz;
    const t11: N = textureLoad(tex, ivec2(i1.toInt(), j1.toInt())).xyz;
    const a: N = t00.mul(float(1).sub(fx)).add(t10.mul(fx));
    const b: N = t01.mul(float(1).sub(fx)).add(t11.mul(fx));
    return a.mul(float(1).sub(fy)).add(b.mul(fy));
  };
  const surfPos: N = fetch2(field.posRT.texture);
  const surfN: N = fetch2(field.nrmRT.texture).normalize();
  const surfT: N = fetch2(field.tanRT.texture).normalize();

  const depth: N = uGeoDepth.max(anc.w.mul(uRise));
  m.positionNode = surfPos.add(surfN.mul(anc.z.mul(depth)));

  // plan frame → object frame: x = +su = T, y = +sv (down-page) = cross(T, N), z = N
  const Bpage: N = cross(surfT, surfN);
  const nObj: N = surfT.mul(npl.x).add(Bpage.mul(npl.y)).add(surfN.mul(npl.z)).normalize();
  const nView: N = transformNormalToView(varying(nObj)).normalize();
  m.normalNode = nView;

  const suv: N = varying(vec2(anc.x, anc.y));
  const aoV: N = varying(aux.y);

  // flat-ink composite (explicit lerps — the TSL mix() gotcha) × baked root AO
  const inkT: N = texture(inkTex, suv);
  const wetF: N = inkT.g;
  const fib: N = texture(fiberTex, suv);
  const det: N = texture(fiberTex, suv.mul(6.0));
  const height: N = fib.z.mul(0.7).add(det.z.mul(0.3));
  const cavity: N = float(1).sub(height.sub(0.5).mul(0.24));
  const inkCol: N = color(INK_DRY).mul(float(1).sub(wetF)).add(color(INK_WET).mul(wetF));
  m.colorNode = inkCol.mul(cavity).mul(aoV);

  // ink roughness + §15 geometric specular AA (same law as the parchment)
  const rInk: N = float(0.52).sub(wetF.mul(0.24));
  const nDx: N = dFdx(nView);
  const nDy: N = dFdy(nView);
  const sigma2: N = nDx.dot(nDx).add(nDy.dot(nDy)).mul(0.25);
  m.roughnessNode = rInk.mul(rInk).add(sigma2.mul(2).min(0.18)).sqrt();

  const mesh = new Mesh(geo, m);
  mesh.frustumCulled = false;
  mesh.castShadow = false; // enabled with the M5 rise — during the handoff the emboss casts none either
  mesh.receiveShadow = true;
  mesh.visible = false;
  return { mesh, uGeoDepth, uRise };
}
