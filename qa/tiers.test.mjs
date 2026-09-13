import assert from 'node:assert/strict';
import test from 'node:test';
import { TierMonitor } from '../src/core/tiers.ts';

test('T1 demotion cannot raise its DPR cap to T2 native 2.2', () => {
  const monitor = new TierMonitor(1);
  let change=null;
  for(let i=0;i<200&&!change;i++) change=monitor.update(.025,true);
  assert.equal(change.tier,2);
  assert.equal(change.dprCap,2);
});
test('native T2 retains its authored cap until demotion to T3', () => {
  const monitor = new TierMonitor(2);
  assert.equal(monitor.dprCap,2.2);
  let change=null;
  for(let i=0;i<200&&!change;i++) change=monitor.update(.025,true);
  assert.equal(change.tier,3);
  assert.equal(change.dprCap,1.25);
});
test('pending demotion waits for a state boundary', () => {
  const monitor = new TierMonitor(1);
  for(let i=0;i<200;i++) assert.equal(monitor.update(.025,false),null);
  assert.equal(monitor.tier,1);
  assert.equal(monitor.update(.025,true).tier,2);
});

test('one slow frame does not truncate three seconds of fast-frame history', () => {
  const monitor = new TierMonitor(1);
  for (let i=0;i<360;i++) assert.equal(monitor.update(1/120,true),null);
  assert.equal(monitor.update(.2,true),null);
  assert.ok(monitor.p95 < 9);
  assert.equal(monitor.tier,1);
});

test('sustained overload replaces old samples by elapsed time and demotes', () => {
  const monitor = new TierMonitor(1);
  for (let i=0;i<360;i++) monitor.update(1/120,true);
  let change=null;
  for (let i=0;i<150&&!change;i++) change=monitor.update(.025,true);
  assert.equal(change?.tier,2);
});

test('invalid or zero durations do not poison the monitor clock', () => {
  const monitor = new TierMonitor(1);
  for (const dt of [NaN,Infinity,-Infinity,-1,0]) assert.equal(monitor.update(dt,true),null);
  let change=null;
  for (let i=0;i<200&&!change;i++) change=monitor.update(.025,true);
  assert.equal(change?.tier,2);
});

test('60 Hz playback does not demote T1 or T2, and 30 Hz does not trip T3 thermal guard', () => {
  for (const tier of [1,2,3]) {
    const monitor=new TierMonitor(tier);
    const dt=tier===3 ? 1/30 : 1/60;
    for (let i=0;i<3600;i++) assert.equal(monitor.update(dt,true),null);
    assert.equal(monitor.tier,tier);
  }
});

test('sustained 20 fps at T3 still triggers the thermal reduction once', () => {
  const monitor=new TierMonitor(3);
  const changes=[];
  for(let i=0;i<1000;i++) { const change=monitor.update(.05,true); if(change) changes.push(change); }
  assert.equal(changes.length,1);
  assert.deepEqual(changes[0],{tier:3,dprCap:.625,reason:'thermal'});
});

// ---- v1.6.7 idle-supersample governor -------------------------------------------------
import { IdleSupersampleGovernor, PACING_BUDGET_MS } from '../src/core/tiers.ts';

test('idle governor keeps the 2x cap at a steady 60 Hz', () => {
  const g = new IdleSupersampleGovernor();
  for (let i = 0; i < 600; i++) g.update(1 / 60, true, PACING_BUDGET_MS[1]);
  assert.equal(g.cap, 2);
  assert.equal(g.history.length, 0);
});

test('idle governor steps 2 -> 1.5 -> 1.25 -> 1 under sustained overrun, one step per window', () => {
  const g = new IdleSupersampleGovernor();
  const caps = [];
  for (let i = 0; i < 40 * 20; i++) { // 20 s at 40 fps (25 ms > 1.25 x 16.7 ms)
    const before = g.cap;
    g.update(0.025, true, PACING_BUDGET_MS[1]);
    if (g.cap !== before) caps.push([+(i * 0.025).toFixed(2), g.cap]);
  }
  assert.deepEqual(caps.map((c) => c[1]), [1.5, 1.25, 1]);
  assert.ok(caps[0][0] >= 2.9, 'first step only after a full 3 s window');
  assert.ok(caps[1][0] - caps[0][0] >= 2.9, 'later steps spaced by at least a window');
  assert.equal(g.cap, 1);
  assert.equal(g.history.length, 3);
});

test('idle governor ignores frames rendered while the idle pass is not engaged', () => {
  const g = new IdleSupersampleGovernor();
  for (let i = 0; i < 400; i++) g.update(0.04, false, PACING_BUDGET_MS[1]); // 25 fps scrolling
  assert.equal(g.cap, 2);
  for (let i = 0; i < 60; i++) g.update(1 / 60, true, PACING_BUDGET_MS[1]); // 1 s engaged, fine
  assert.equal(g.cap, 2);
});

test('idle governor never raises the cap again and ignores an isolated stall', () => {
  const g = new IdleSupersampleGovernor();
  for (let i = 0; i < 300; i++) g.update(1 / 60, true, PACING_BUDGET_MS[1]);
  g.update(0.4, true, PACING_BUDGET_MS[1]); // one 400 ms stall is a gap, not a sample
  for (let i = 0; i < 300; i++) g.update(1 / 60, true, PACING_BUDGET_MS[1]);
  assert.equal(g.cap, 2);
  for (let i = 0; i < 100; i++) g.update(0.025, true, PACING_BUDGET_MS[1]); // 2.5 s overrun
  assert.ok(g.cap < 2 && g.cap >= 1.25, 'stepped down under overrun');
  for (let i = 0; i < 240; i++) g.update(1 / 60, true, PACING_BUDGET_MS[1]); // 4 s: the trailing window flushes
  const settled = g.cap;
  for (let i = 0; i < 1200; i++) g.update(1 / 60, true, PACING_BUDGET_MS[1]); // 20 s healthy
  assert.equal(g.cap, settled, 'no promotion during the session');
});
