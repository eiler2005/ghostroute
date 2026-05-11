#!/usr/bin/env node
import assert from "node:assert/strict";
import { bucketStartUtc, mskWindowBounds, toMskKey, toUtcIsoFromMskKey } from "../src/lib/time/window.mjs";

const sample = "2026-05-09T10:17:42.000Z";
assert.equal(toMskKey(sample, "day"), "2026-05-09");
assert.equal(toMskKey(sample, "hour"), "2026-05-09T13");
assert.equal(toMskKey(sample, "5min"), "2026-05-09T13:15");
assert.equal(toUtcIsoFromMskKey("2026-05-09", "day"), "2026-05-08T21:00:00.000Z");
assert.equal(bucketStartUtc(sample, "5min"), "2026-05-09T10:15:00.000Z");

const today = mskWindowBounds("today", "2026-05-09T10:17:42.000Z");
assert.equal(today.startUtc, "2026-05-08T21:00:00.000Z");
assert.equal(today.endUtc, "2026-05-09T10:17:42.000Z");

const week = mskWindowBounds("week", "2026-05-09T10:17:42.000Z");
assert.equal(week.startMskKey, "2026-05-04");

const month = mskWindowBounds("month", "2026-05-09T10:17:42.000Z");
assert.equal(month.startMskKey, "2026-05-01");

console.log("timezone windows ok");
