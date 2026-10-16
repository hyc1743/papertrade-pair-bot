import test from 'node:test';
import assert from 'node:assert/strict';
import { OiStabilityGate } from '../src/oi-guard.js';

test('paired openings require distinct fresh safe OI blocks over the configured interval',()=>{
  const gate=new OiStabilityGate();
  assert.deepEqual(gate.observe(100,true,0,3,2000),{ready:false,count:1,required:3,stableMs:0});
  assert.equal(gate.observe(100,true,1000,3,2000).count,1);
  assert.equal(gate.observe(101,true,1000,3,2000).ready,false);
  assert.equal(gate.observe(102,true,2000,3,2000).ready,true);
  assert.equal(gate.observe(103,false,3000,3,2000).count,0);
  assert.equal(gate.observe(104,true,4000,3,2000).count,1);
});
