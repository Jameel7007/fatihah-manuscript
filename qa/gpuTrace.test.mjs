import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { installGPUTrace, gpuTraceSnapshot } from '../src/qa/gpuTrace.ts';

const hash = bytes => createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
function mockDevice() {
  const writes = [];
  return {
    writes,
    createShaderModule: descriptor => descriptor,
    createBuffer: descriptor => ({
      getMappedRange: (offset = 0, size = descriptor.size - offset) => new ArrayBuffer(size),
      unmap() {},
    }),
    queue: { writeBuffer: (...args) => writes.push(args) },
  };
}
test('trace freezes mapped vertex and index uploads before unmap', async () => {
  const device = mockDevice(); installGPUTrace(device);
  for (const usage of [16, 32]) {
    const buffer = device.createBuffer({ size: 8, usage, mappedAtCreation: true });
    const bytes = new Uint8Array(buffer.getMappedRange(4, 4));
    bytes.set([1, 2, 3, 4]); buffer.unmap(); bytes.fill(9);
  }
  assert.deepEqual(Object.values(await gpuTraceSnapshot()), [hash([0,0,0,0,1,2,3,4]), hash([0,0,0,0,1,2,3,4])]);
});
test('trace respects typed-array element offsets and forwards the original write', async () => {
  const device = mockDevice(); installGPUTrace(device);
  const buffer = device.createBuffer({ size: 8, usage: 64 });
  const data = new Uint16Array([9, 10, 11, 12]).subarray(1);
  device.queue.writeBuffer(buffer, 2, data, 1, 2);
  const expected = new Uint8Array(8); expected.set(new Uint8Array(new Uint16Array([11,12]).buffer), 2);
  assert.deepEqual(Object.values(await gpuTraceSnapshot()), [hash(expected)]);
  assert.deepEqual(device.writes[0], [buffer, 2, data, 1, 2]);
});
test('trace freezes snapshot before asynchronous hashing', async () => {
  const device = mockDevice(); installGPUTrace(device);
  const buffer = device.createBuffer({ size: 4, usage: 128 });
  const snapshot = gpuTraceSnapshot();
  device.queue.writeBuffer(buffer, 0, new Uint8Array([1,2,3,4]));
  assert.deepEqual(Object.values(await snapshot), [hash([0,0,0,0])]);
});
test('trace resets records for a new device and ignores non-render buffers', async () => {
  const first = mockDevice(); installGPUTrace(first);
  first.createShaderModule({ code: 'test' });
  const second = mockDevice(); installGPUTrace(second);
  second.createBuffer({ size: 4, usage: 1 });
  assert.deepEqual(await gpuTraceSnapshot(), {});
});
