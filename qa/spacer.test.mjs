import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { INK_NEEDED_P, RELIEF_NEEDED_P, SCROLL_DENSITY_TOTAL, scrollToP } from '../src/director/scroll.ts';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('index.html spacer heights match the ones main.ts sets', () => {
  const fine = Math.round(8 * 100 * SCROLL_DENSITY_TOTAL) + 100;
  const coarse = Math.round(6.5 * 100 * SCROLL_DENSITY_TOTAL) + 100;
  assert.match(html, new RegExp(`#spacer \\{ width: 1px; height: ${fine}vh; \\}`));
  assert.match(html, new RegExp(`@media \\(pointer: coarse\\) \\{ #spacer \\{ height: ${coarse}vh; \\} \\}`));
});

test('the ink limit sits before the write span and the relief limit before the emboss', () => {
  assert.ok(INK_NEEDED_P < 0.3);
  assert.ok(INK_NEEDED_P > 0.25, 'the whole unroll stays scrollable without the ink');
  // drivers.ts uses extensionless imports node cannot resolve, so read its windows from source:
  // the earliest relief-driven window (emboss, rim lift) opens at 0.64
  const drivers = readFileSync(new URL('../src/director/drivers.ts', import.meta.url), 'utf8');
  const opens = [...drivers.matchAll(/span\(p, (0\.\d+), 0\.\d+\)/g)].map((m) => +m[1]).filter((x) => x > 0.6);
  assert.equal(Math.min(...opens), 0.64);
  assert.ok(RELIEF_NEEDED_P < Math.min(...opens));
  assert.ok(RELIEF_NEEDED_P > 0.62, 'the whole write span stays scrollable without the relief');
});

test('scrollToP stays monotone across the dwell', () => {
  let prev = -1;
  for (let i = 0; i <= 1000; i++) { const p = scrollToP(i / 1000); assert.ok(p >= prev); prev = p; }
  assert.equal(scrollToP(0), 0);
  assert.ok(Math.abs(scrollToP(1) - 1) < 1e-9);
});
