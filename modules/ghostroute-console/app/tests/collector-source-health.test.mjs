import test from 'node:test';
import assert from 'node:assert/strict';
import {assertFreshSourceSnapshot} from '../scripts/lib/post-deploy-verify.mjs';

test('fresh summary cannot mask a stalled detailed source or an old successful run',()=>{
 const now=Date.parse('2026-11-21T12:00:00Z');
 assert.doesNotThrow(()=>assertFreshSourceSnapshot({type:'traffic_summary',collected_at:'2026-11-21T11:55:00Z'},now));
 for(const type of ['traffic_facts','traffic_evidence','router_rollups']) {
  assert.throws(()=>assertFreshSourceSnapshot({type,collected_at:'2026-11-20T12:00:00Z'},now),/stale/);
  assert.doesNotThrow(()=>assertFreshSourceSnapshot({type,collected_at:'2026-11-21T14:55:00+03:00'},now));
 }
});

test('source gate rejects missing invalid and future timestamps',()=>{
 const now=Date.parse('2026-11-21T12:00:00Z');
 for(const collected_at of ['',undefined,'invalid','2026-11-21T13:00:00Z']) {
  assert.throws(()=>assertFreshSourceSnapshot({type:'traffic_facts',collected_at},now));
 }
});
