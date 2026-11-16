import test from 'node:test';
import assert from 'node:assert/strict';
import { createSynchronousVersionScope } from '../src/lib/version-scope.mjs';

test('nested list builds reuse one version but later builds observe changes, including after errors', () => {
  let version = 'first', reads = 0;
  const scope = createSynchronousVersionScope(() => { reads++; return version; });
  scope.run(() => {
    assert.equal(scope.current(), 'first');
    version = 'second';
    scope.run(() => assert.equal(scope.current(), 'first'));
    assert.equal(reads, 1);
  });
  assert.equal(scope.current(), undefined);
  assert.throws(() => scope.run(() => { assert.equal(scope.current(), 'second'); throw Error('failure'); }));
  version = 'third';
  scope.run(() => assert.equal(scope.current(), 'third'));
  assert.equal(reads, 3);
});
