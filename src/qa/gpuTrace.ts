// Opt-in diagnostic: record the exact CPU inputs supplied to WebGPU, without changing them.
const shaders: string[] = [];
const uploads = new Map<GPUBuffer, { label: string; usage: number; bytes: Uint8Array }>();

export function installGPUTrace(device: GPUDevice): void {
  shaders.length = 0;
  uploads.clear();
  const createShader = device.createShaderModule.bind(device);
  device.createShaderModule = (d) => { shaders.push(d.code); return createShader(d); };
  const createBuffer = device.createBuffer.bind(device);
  device.createBuffer = (d) => {
    const buffer = createBuffer(d);
    // CPU upload history only: GPU-written storage contents are not observed here.
    if (d.usage & 0xf0 /* INDEX | VERTEX | UNIFORM | STORAGE */) {
      const rec = { label: d.label ?? '', usage: d.usage, bytes: new Uint8Array(d.size) };
      uploads.set(buffer, rec);
      const ranges: Array<{ offset: number; data: ArrayBuffer }> = [];
      const getMappedRange = buffer.getMappedRange.bind(buffer);
      buffer.getMappedRange = (offset = 0, size) => {
        const data = getMappedRange(offset, size);
        ranges.push({ offset, data });
        return data;
      };
      const unmap = buffer.unmap.bind(buffer);
      buffer.unmap = () => {
        // Mapped ArrayBuffers detach on unmap: freeze bytes before forwarding it.
        for (const range of ranges) rec.bytes.set(new Uint8Array(range.data), range.offset);
        ranges.length = 0;
        unmap();
      };
    }
    return buffer;
  };
  const write = device.queue.writeBuffer.bind(device.queue);
  device.queue.writeBuffer = (buffer, offset, data, dataOffset = 0, size) => {
    const rec = uploads.get(buffer);
    if (rec) {
      const view = ArrayBuffer.isView(data);
      const unit = view && 'BYTES_PER_ELEMENT' in data ? Number(data.BYTES_PER_ELEMENT) : 1;
      const start = (view ? data.byteOffset : 0) + dataOffset * unit;
      const length = size === undefined ? data.byteLength - dataOffset * unit : size * unit;
      rec.bytes.set(new Uint8Array(view ? data.buffer : data, start, length), offset);
    }
    write(buffer, offset, data, dataOffset, size);
  };
}

export async function gpuTraceSnapshot(): Promise<Record<string, string>> {
  const hash = async (data: Uint8Array): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
    return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2,'0')).join('');
  };
  const out: Record<string,string> = {};
  // Freeze all bytes synchronously; readback and hashing must not move the sample time.
  const snapshot = [...uploads.values()].map(r => ({...r,bytes:r.bytes.slice()}));
  for (let i=0;i<shaders.length;i++) out['shader'+i] = await hash(new TextEncoder().encode(shaders[i]));
  for (let i=0;i<snapshot.length;i++) {
    const r = snapshot[i]!;
    out['cpuBuffer'+i+':'+r.label+':usage'+r.usage+':'+r.bytes.length] = await hash(r.bytes);
  }
  return out;
}
