import assert from 'node:assert/strict';
import test from 'node:test';
import { PerfAudit } from '../src/qa/perf.ts';

const state = (tier=1) => ({p:.76,tier,ss:1.5,dpr:2,width:1440,height:900});
test('retains long stalls and completes once', () => {
  const audit=new PerfAudit(1);
  assert.equal(audit.tick(0,state(),true),null);
  audit.tick(16,state(),true);
  audit.tick(500,state(),true);
  const result=audit.tick(1000,state(),true);
  assert.deepEqual(result.samples.map(s=>s[1]),[16,484,500]);
  assert.equal(result.max,500);
  assert.equal(result.stallsOver250ms,2);
  assert.equal(audit.tick(2000,state(),true),null);
});
test('demotion preserves earlier samples and original clock', () => {
  const audit=new PerfAudit(1);
  audit.tick(0,state(1),true);
  audit.tick(400,state(2),true);
  const result=audit.tick(1000,state(2),true);
  assert.equal(result.durationSeconds,1);
  assert.equal(result.frames,2);
  assert.equal(result.byTier[1].frames,1);
  assert.equal(result.byTier[2].frames,1);
  assert.equal(result.nominalTierMaintained,false);
});
test('hidden interval invalidates evidence without deleting measurements', () => {
  const audit=new PerfAudit(1);
  audit.tick(0,state(),true);
  audit.markHidden();
  const result=audit.tick(1000,state(),true);
  assert.equal(result.foregroundThroughout,false);
  assert.equal(result.usableForegroundSample,false);
  assert.equal(result.max,1000);
});
test('keeps supersample context and records resize changes', () => {
  const audit=new PerfAudit(1);
  audit.tick(0,state(),true);
  const result=audit.tick(1000,{...state(),ss:2,width:390},true);
  assert.equal(result.samples[0][4],1.5);
  assert.equal(result.configurations.length,2);
});

test('CPU update/submit is current-frame work, separate from prior-frame pacing', () => {
  const audit=new PerfAudit(1);
  audit.tick(0,state(1),true,2);
  const result=audit.tick(1000,state(2),true,5);
  assert.equal(result.byTier[1].max,1000);
  assert.equal(result.cpuUpdateSubmit.byTier[1].max,2);
  assert.equal(result.cpuUpdateSubmit.byTier[2].max,5);
  assert.equal(result.cpuUpdateSubmit.summary.frames,2);
  assert.deepEqual(result.cpuUpdateSubmit.samples.map(s=>s[3]),[1,2]);
});

test('missing and invalid CPU readings remain unavailable, not zero', () => {
  const audit=new PerfAudit(1);
  audit.tick(0,state(),true);
  audit.tick(250,state(),true,NaN);
  audit.tick(500,state(),true,-1);
  const result=audit.tick(1000,state(),true,Infinity);
  assert.equal(result.cpuUpdateSubmit.summary,null);
  assert.deepEqual(result.cpuUpdateSubmit.samples,[]);
  assert.equal(result.frames,3);
});
