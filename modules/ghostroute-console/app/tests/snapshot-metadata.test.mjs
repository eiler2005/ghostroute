import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('normalized-row snapshot lookup uses metadata without loading evidence payloads', () => {
  const store = fs.readFileSync(new URL('../src/lib/server/store.ts', import.meta.url), 'utf8');
  const source = store.match(/function latestSnapshotIdsByType\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source);
  const result = vm.runInNewContext(`${source}; latestSnapshotIdsByType()`, {
    latestSnapshotMetas: () => [{ id: 3 }, { id: 8 }, { id: 0 }],
    latestSnapshots: () => { throw new Error('request path loaded unrelated full traffic evidence'); },
  });
  assert.deepEqual(Array.from(result), [3, 8]);
});
