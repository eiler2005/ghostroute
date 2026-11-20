import test from 'node:test';
import assert from 'node:assert/strict';
import { newestSourceTimestamp } from '../src/lib/time/window.mjs';

test('freshness compares UTC and offset sources by instant rather than wall-clock text', () => {
  const oldOffset='2026-11-20T11:08:55+0300';
  const freshUtc='2026-11-20T08:18:42.915Z';
  for(const values of [[oldOffset,freshUtc],[freshUtc,oldOffset]]) assert.equal(newestSourceTimestamp(values),freshUtc);
  assert.equal(newestSourceTimestamp(['2026-11-20T01:30:00+0300','2026-11-19T23:00:00Z']),'2026-11-19T23:00:00Z');
});

test('missing or invalid source times cannot replace a real observation', () => {
  assert.equal(newestSourceTimestamp([undefined,'','invalid']), '');
  assert.equal(newestSourceTimestamp(['invalid','2026-11-20T08:00:00Z',undefined]), '2026-11-20T08:00:00Z');
});
