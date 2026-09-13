// Materialize actual cold captures; never writes the blessed reference manifest.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const source = process.argv[2] ?? 'qa/review/fallback-plates-source.png';
const bundle = JSON.parse(readFileSync(source, 'utf8'));
const poses = [0, .21, .45, .60, .685, .884, 1];
assert.equal(bundle.blessed, false);
assert.equal(bundle.plates.length, 7);
const output = bundle.plates.map((plate, i) => {
  assert.equal(plate.p, poses[i]);
  assert.equal(plate.backend, 'webgl2');
  assert.equal(plate.hashes.length, 2);
  assert.match(plate.hashes[0], /^[a-f0-9]{64}$/);
  assert.equal(plate.hashes[0], plate.hashes[1], 'Cold source captures must agree');
  assert.ok(plate.jpeg.startsWith('data:image/jpeg;base64,'));
  const bytes = Buffer.from(plate.jpeg.split(',')[1], 'base64');
  assert.equal(bytes.readUInt16BE(0), 0xffd8);
  assert.equal(bytes.readUInt16BE(bytes.length - 2), 0xffd9);
  return { bytes, path: `public/fallback/plate-${i + 1}.jpg`, p: plate.p,
    sourceRawPixelHashes: plate.hashes, jpegSha256: createHash('sha256').update(bytes).digest('hex') };
});
const total = output.reduce((sum, plate) => sum + plate.bytes.length, 0);
assert.ok(total <= 280000, `Seven-plate budget exceeded: ${total} > 280000 B`);
mkdirSync('public/fallback', { recursive: true });
for (const plate of output) writeFileSync(plate.path, plate.bytes);
const report = { version: bundle.version, status: 'unblessed fallback assets; not regression references',
  generatedAt: new Date().toISOString(), source, backend: 'webgl2',
  width: bundle.width, height: bundle.height, ss: bundle.ss, jpegQuality: .70,
  totalBytes: total, budgetBytes: 280000,
  plates: output.map(({ bytes, ...plate }) => ({ ...plate, bytes: bytes.length })) };
writeFileSync('build/fallback-plates.json', JSON.stringify(report, null, 2) + '\n');
console.log(`PASS: seven real plates, ${total} / 280000 B. Nothing blessed.`);
