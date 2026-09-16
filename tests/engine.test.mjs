import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyState, runFixture, compare, kstDate, validateReading } from '../lib/engine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', 'fixtures');

const files = {
  'normal-d1-a': 'normal-d1-a.json', 'normal-d1-b': 'normal-d1-b.json', 'normal-d2': 'normal-d2.json',
  timeout: 'timeout.json', auth: 'auth-401.json', rate_limit: 'rate-429.json', offline: 'offline.json',
  schema_error: 'schema-break.json', 'recover-d2': 'recover-d2.json',
};
const fixtures = {};
test.before(async () => {
  for (const [k, f] of Object.entries(files)) fixtures[k] = JSON.parse(await readFile(join(fixturesDir, f), 'utf8'));
});

function baseline() {
  return runFixture(runFixture(emptyState(), fixtures['normal-d1-a']), fixtures['normal-d1-b']);
}

test('D1-A creates the first daily row', () => {
  const s = runFixture(emptyState(), fixtures['normal-d1-a']);
  assert.equal(s.daily_readings.length, 1);
  assert.equal(s.current_reading.normalized_value, 100);
  assert.equal(s.status.freshness, 'fresh');
});

test('D1-B updates the same day in place (no duplicate row)', () => {
  const s = runFixture(runFixture(emptyState(), fixtures['normal-d1-a']), fixtures['normal-d1-b']);
  assert.equal(s.daily_readings.length, 1);
  assert.equal(s.current_reading.normalized_value, 105);
  assert.equal(s.daily_readings[0].record_id, `${fixtures['normal-d1-a'].payload.signal_id}:${fixtures['normal-d1-a'].payload.record_date}`);
});

test('D2 adds a new day and day-over-day delta is +15', () => {
  const s = runFixture(baseline(), fixtures['normal-d2']);
  assert.equal(s.daily_readings.length, 2);
  const delta = compare(s.daily_readings[1].reading, s.daily_readings[0].reading);
  assert.equal(delta.signed, 15);
  assert.equal(delta.consecutive, true);
});

for (const code of ['timeout', 'auth', 'rate_limit', 'offline', 'schema_error']) {
  test(`${code}: preserves last-good (105) and marks stale`, () => {
    const s = runFixture(baseline(), fixtures[code]);
    assert.equal(s.status.freshness, 'stale');
    assert.equal(s.status.error_code, code);
    assert.equal(s.current_reading.normalized_value, 105);
    assert.equal(s.daily_readings.length, 1);
  });
}

test('recover-d2 after timeout returns to fresh/none with a new row', () => {
  let s = baseline();
  s = runFixture(s, fixtures.timeout);
  s = runFixture(s, fixtures['recover-d2']);
  assert.equal(s.status.freshness, 'fresh');
  assert.equal(s.status.error_code, 'none');
  assert.equal(s.daily_readings.length, 2);
  assert.equal(s.current_reading.normalized_value, 120);
});

test('recover-d2 replayed twice does not create a duplicate row', () => {
  let s = baseline();
  s = runFixture(s, fixtures['recover-d2']);
  s = runFixture(s, fixtures['recover-d2']);
  assert.equal(s.daily_readings.length, 2);
});

test('kstDate converts a UTC instant to an Asia/Seoul calendar date', () => {
  assert.equal(kstDate('2026-08-23T15:30:00.000Z'), '2026-08-24');
  assert.equal(kstDate('2026-08-23T14:59:59.000Z'), '2026-08-23');
});

test('validateReading rejects a non-https source_url', () => {
  const bad = { ...fixtures['normal-d1-a'].payload, source_url: 'http://example.com' };
  assert.throws(() => validateReading(bad));
});

test('validateReading rejects a record_date that does not match fetched_at in KST', () => {
  const bad = { ...fixtures['normal-d1-a'].payload, record_date: '2099-01-01' };
  assert.throws(() => validateReading(bad));
});
