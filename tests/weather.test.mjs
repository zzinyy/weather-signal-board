import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, fetchWeather, SourceError, SIGNAL_ID } from '../lib/weather.mjs';

const samplePayload = {
  latitude: 37.56, longitude: 126.99, timezone: 'UTC',
  current_units: { time: 'iso8601', interval: 'seconds', temperature_2m: '°C', weather_code: 'wmo code', wind_speed_10m: 'km/h' },
  current: { time: '2026-09-16T06:00', interval: 900, temperature_2m: 23.4, weather_code: 1, wind_speed_10m: 8.3 },
};

test('normalize() converts an Open-Meteo payload into a valid Reading', () => {
  const reading = normalize(samplePayload, '2026-09-16T06:03:12.000Z');
  assert.equal(reading.signal_id, SIGNAL_ID);
  assert.equal(reading.normalized_value, 23.4);
  assert.equal(reading.unit, '°C');
  assert.equal(reading.source_time, '2026-09-16T06:00:00Z');
  assert.equal(reading.record_timezone, 'Asia/Seoul');
  assert.equal(reading.record_date, '2026-09-16'); // 06:03 UTC = 15:03 KST, same day
});

test('normalize() throws schema_error on a missing temperature field', () => {
  const broken = { ...samplePayload, current: { time: '2026-09-16T06:00' } };
  assert.throws(() => normalize(broken, '2026-09-16T06:03:12.000Z'), /schema_error/);
});

function fakeFetcher(status, body, headers = {}) {
  return async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

test('fetchWeather() maps HTTP 401 to SourceError("auth")', async () => {
  await assert.rejects(
    () => fetchWeather({ fetcher: fakeFetcher(401, {}) }),
    (err) => err instanceof SourceError && err.code === 'auth'
  );
});

test('fetchWeather() maps HTTP 429 with retry-after to SourceError("rate_limit")', async () => {
  await assert.rejects(
    () => fetchWeather({ fetcher: fakeFetcher(429, {}, { 'retry-after': '12' }) }),
    (err) => err instanceof SourceError && err.code === 'rate_limit' && err.retryAfter === 12
  );
});

test('fetchWeather() maps invalid JSON to SourceError("schema_error")', async () => {
  await assert.rejects(
    () => fetchWeather({ fetcher: fakeFetcher(200, 'not json') }),
    (err) => err instanceof SourceError && err.code === 'schema_error'
  );
});

test('fetchWeather() maps an aborted (slow) request to SourceError("timeout")', async () => {
  const slowFetcher = (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await assert.rejects(
    () => fetchWeather({ fetcher: slowFetcher, timeoutMs: 20 }),
    (err) => err instanceof SourceError && err.code === 'timeout'
  );
});

test('fetchWeather() succeeds end-to-end with a valid mock response', async () => {
  const { record } = await fetchWeather({ fetcher: fakeFetcher(200, samplePayload), clock: () => new Date('2026-09-16T06:05:00.000Z') });
  assert.equal(record.reading.normalized_value, 23.4);
  assert.equal(record.reading.fetched_at, '2026-09-16T06:05:00.000Z');
});
