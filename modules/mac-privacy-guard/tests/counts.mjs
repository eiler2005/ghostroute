import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const context=vm.createContext({Intl,Number,Math});
vm.runInContext(readFileSync(new URL('../extension/counts.js',import.meta.url),'utf8'),context);
const counts=context.GuardCounts;
for(const [n,label] of [[0,'0'],[999,'999'],[1000,'1k'],[1100,'1,1k'],[9999,'9,9k'],[10000,'10k'],[14494,'14k'],[999999,'999k'],[1000000,'1M'],[1100000,'1,1M'],[1000000000,'1B'],[Number.MAX_SAFE_INTEGER,'999+']]){
  assert.equal(counts.badge(n),label);assert(counts.badge(n).length<=4);
}
assert.equal(counts.compact(14494),'14,4k');
assert.equal(counts.compact(999999),'999,9k');
assert.equal(counts.exact(14494).replace(/\s/g,' '),'14 494');
for(const n of [-1,NaN,Infinity,undefined])assert.equal(counts.badge(n),'0');
console.log('PASS: four-character badge, decimal comma, bounded compact counters and exact grouped totals');
