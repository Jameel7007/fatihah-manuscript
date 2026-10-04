import assert from 'node:assert/strict';
import test from 'node:test';

// minimal browser stubs for ScrollDriver (it reads the scroll position and the reduced-motion query)
globalThis.matchMedia = () => ({ matches: false });
globalThis.window = { scrollY: 0, innerHeight: 800 };
globalThis.document = { documentElement: { scrollHeight: 10800 } };
const { ScrollDriver, scrollToP } = await import('../src/director/scroll.ts');

test('a far scroll target glides at no more than vMax per second', () => {
  const s = new ScrollDriver();
  s.vMax = 0.3;
  window.scrollY = 10000; // the end of the page
  let maxStep = 0;
  let prev = s.p;
  for (let i = 0; i < 240; i++) { s.update(1 / 60); maxStep = Math.max(maxStep, s.p - prev); prev = s.p; }
  assert.ok(maxStep <= 0.3 / 60 + 1e-9, `step ${maxStep}`);
  assert.ok(s.p > 0.95, 'arrives within a few seconds');
});

test('a lifted asset limit releases as a glide, not a jump', () => {
  const s = new ScrollDriver();
  s.vMax = 0.3;
  s.limit = 0.295;
  window.scrollY = 6000;
  for (let i = 0; i < 120; i++) s.update(1 / 60);
  assert.ok(Math.abs(s.p - 0.295) < 1e-3, 'held at the limit');
  s.limit = 1;
  let maxStep = 0;
  let prev = s.p;
  for (let i = 0; i < 60; i++) { s.update(1 / 60); maxStep = Math.max(maxStep, s.p - prev); prev = s.p; }
  assert.ok(maxStep <= 0.3 / 60 + 1e-9);
});

test('snapToTarget lands on the reader position at once, within the limit', () => {
  const s = new ScrollDriver();
  window.scrollY = 3000;
  s.limit = 0.295;
  s.snapToTarget();
  assert.equal(s.p, Math.min(0.295, scrollToP(3000 / 10000)));
});

test('a stable viewport height keeps p still when innerHeight changes', () => {
  const s = new ScrollDriver();
  s.viewportHeight = () => 800;
  window.scrollY = 5000;
  s.update(1 / 60);
  const t1 = s.target;
  window.innerHeight = 700; // the toolbar slides
  s.update(1 / 60);
  assert.equal(s.target, t1);
  window.innerHeight = 800;
});
