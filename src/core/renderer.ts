// Renderer boot — §16. WebGPURenderer with AgX + sRGB out; the WebGL2 path is the same
// node graph (forced via ?backend=webgl2, or automatic when WebGPU is unavailable).
// antialias: true → MSAA 4× on WebGPU, multisampled renderbuffer on WebGL2.

import { AgXToneMapping, SRGBColorSpace, WebGPURenderer } from 'three/webgpu';
import { installGPUTrace } from '../qa/gpuTrace';

export type Backend = 'webgpu' | 'webgl2';

export interface RendererBoot {
  renderer: WebGPURenderer;
  backend: Backend;
}

export async function createRenderer(
  canvas: HTMLCanvasElement,
  opts: { forceWebGL: boolean; dprCap: number },
): Promise<RendererBoot> {
  if (new URLSearchParams(location.search).has('failRenderer')) {
    throw new Error('Forced renderer initialization failure (QA)');
  }
  const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL: opts.forceWebGL });
  renderer.toneMapping = AgXToneMapping;
  renderer.outputColorSpace = SRGBColorSpace;
  await renderer.init();
  if (new URLSearchParams(location.search).has('gpuTrace')) {
    const device = (renderer.backend as unknown as { device?: GPUDevice }).device;
    if (device) installGPUTrace(device);
  }

  const backendObj = (renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend;
  const backend: Backend = backendObj?.isWebGPUBackend === true ? 'webgpu' : 'webgl2';
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, opts.dprCap));
  return { renderer, backend };
}
