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
