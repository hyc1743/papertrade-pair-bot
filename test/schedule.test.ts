import test from 'node:test';
import assert from 'node:assert/strict';
import { openingSchedule, parseOpeningAt } from '../src/schedule.js';
import { configSchema } from '../src/config.js';

test('one-off UTC schedule checks three seconds early but never opens early',()=>{
  const at='2026-10-10T14:00:00Z',t=Date.parse(at);
  assert.equal(openingSchedule(at,3000,t-3001).canCheck,false);
  assert.equal(openingSchedule(at,3000,t-3000).canCheck,true);
  assert.equal(openingSchedule(at,3000,t-1).canOpen,false);
  assert.equal(openingSchedule(at,3000,t).canOpen,true);
  assert.equal(openingSchedule(at,3000,t+86400000).canOpen,true);
  assert.equal(openingSchedule(null,3000,t).canOpen,true);
});
test('UTC timestamps require a date and reject implicit timezone or normalized invalid dates',()=>{
  for(const invalid of ['14:00','2026-10-10T14:00:00','2026-10-10T14:00:00+00:00','2026-02-30T14:00:00Z','2026-10-10T24:00:00Z']) {
    assert.throws(()=>parseOpeningAt(invalid));
    assert.equal(configSchema.safeParse({marginUsdc:'200',leverage:50,openingAtUtc:invalid}).success,false);
  }
  assert.equal(parseOpeningAt('2026-10-10T14:00:00.123Z'),Date.parse('2026-10-10T14:00:00.123Z'));
  assert.equal(configSchema.parse({marginUsdc:'200',leverage:50}).openingAtUtc,null);
});
