// Capture rig — §20. A capture run is a pure function of its URL parameters: fixed canvas
// size, DPR 1, p pinned (no spring, no gaze trail), dynamics flags off. The frame hash is
// SHA-256 over raw RGBA of the presented canvas (via 2D readback — WebGPU canvases keep
// their bitmap readable, and raw pixels avoid PNG-encoder variance).

export interface CaptureFrame {
  hash: string;
  width: number;
  height: number;
  dataUrl: string;
  imageData: ImageData;
}

export function readCanvas(canvas: HTMLCanvasElement): { imageData: ImageData; dataUrl: string } {
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D readback context unavailable');
  ctx.drawImage(canvas, 0, 0);
  return { imageData: ctx.getImageData(0, 0, c.width, c.height), dataUrl: c.toDataURL('image/png') };
}

export async function sha256Hex(data: Uint8ClampedArray): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function captureFrame(canvas: HTMLCanvasElement): Promise<CaptureFrame> {
  const { imageData, dataUrl } = readCanvas(canvas);
  const hash = await sha256Hex(imageData.data);
  return { hash, width: imageData.width, height: imageData.height, dataUrl, imageData };
}

/** Sample one pixel (RGBA 0–255) at CSS-pixel coordinates of a captured frame. */
export function samplePixel(frame: CaptureFrame, x: number, y: number): [number, number, number, number] {
  const xi = Math.min(frame.width - 1, Math.max(0, Math.round(x)));
  const yi = Math.min(frame.height - 1, Math.max(0, Math.round(y)));
  const i = (yi * frame.width + xi) * 4;
  const d = frame.imageData.data;
  return [d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0, d[i + 3] ?? 0];
}
