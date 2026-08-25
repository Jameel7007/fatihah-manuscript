// Renderer boot — §16. WebGPURenderer with AgX + sRGB out; the WebGL2 path is the same
// node graph (forced via ?backend=webgl2, or automatic when WebGPU is unavailable).
// antialias: true → MSAA 4× on WebGPU, multisampled renderbuffer on WebGL2.

import { AgXToneMapping, SRGBColorSpace, WebGPURenderer } from 'three/webgpu';

export type Backend = 'webgpu' | 'webgl2';

export interface RendererBoot {
  renderer: WebGPURenderer;
  backend: Backend;
}

export async function createRenderer(
  canvas: HTMLCanvasElement,
  opts: { forceWebGL: boolean; dprCap: number },
): Promise<RendererBoot> {
  const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL: opts.forceWebGL });
  renderer.toneMapping = AgXToneMapping;
  renderer.outputColorSpace = SRGBColorSpace;
  await renderer.init();

  const backendObj = (renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend;
  const backend: Backend = backendObj?.isWebGPUBackend === true ? 'webgpu' : 'webgl2';
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, opts.dprCap));
  return { renderer, backend };
}
