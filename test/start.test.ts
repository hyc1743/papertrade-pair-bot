import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openingSchedule } from '../src/schedule.js';

test('one-click start fixes the official opening date and loads .env without inherited wallet overrides',()=>{
  // Inspect only: this test must never launch the live command or read .env.
  const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  const template=JSON.parse(readFileSync(new URL('../config.example.json',import.meta.url),'utf8'));
  const cmd=pkg.scripts.start as string;
  assert.match(cmd,/^env -u PAPERTRADE_WALLET_A_PRIVATE_KEY -u PAPERTRADE_WALLET_B_PRIVATE_KEY /);
  assert.match(cmd,/node --env-file=\.env --import tsx src\/cli\.ts run --live/);
  assert.match(cmd,/--config config\.example\.json/);
  const at=cmd.match(/--opening-at (\S+)$/)?.[1];
  assert.equal(at,'2026-10-10T14:00:00Z');
  assert.equal(template.openingCheckLeadMs,3000);
  assert.equal(template.openIntentTtlSeconds,3600);
  assert.equal(template.pollIntervalMs,1000);
  const schedule=openingSchedule(at!,template.openingCheckLeadMs,Date.parse('2026-10-10T13:28:00Z'));
  assert.equal(new Date(schedule.checkAt!).toISOString(),'2026-10-10T13:59:57.000Z');
  assert.equal(schedule.canCheck,false);
  assert.equal(new Date(schedule.openingAt!).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}),'2026-10-10 22:00:00');
});
