import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCaptureAssets } from '../src/qa/assets.ts';

test('capture retains both loaded assets', async () => {
  assert.deepEqual(await loadCaptureAssets(async () => 'ink', async () => 'glyph', true), { ink: 'ink', glyph: 'glyph' });
});
test('ink failure rejects capture without loading glyphs', async () => {
  let glyphCalled = false;
  await assert.rejects(loadCaptureAssets(async () => { throw Error('missing ink'); }, async () => { glyphCalled = true; }, true), /missing ink/);
  assert.equal(glyphCalled, false);
});
test('required glyph failure rejects capture', async () => {
  await assert.rejects(loadCaptureAssets(async () => 'ink', async () => { throw Error('missing glyph'); }, true), /missing glyph/);
});
test('ink-only pose does not request relief', async () => {
  const result = await loadCaptureAssets(async () => 'ink', async () => { throw Error('must not load'); }, false);
  assert.deepEqual(result, { ink: 'ink', glyph: undefined });
});
