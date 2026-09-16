// engine.mjs — signal-agnostic core (works for any "값 하나": weather, FX, traffic...)
// Ported 1:1 from the reference T04 engine.ts. Real live fetch, the daily
// collector script, and the synthetic fixture replay all call the exact
// same functions here, so error handling can't quietly diverge between them.

/**
 * @typedef {Object} Reading
 * @property {string} signal_id
 * @property {number} normalized_value
 * @property {string} unit
 * @property {string} source_name
 * @property {string} source_url
 * @property {string|null} source_time
 * @property {string} fetched_at
 * @property {'Asia/Seoul'} record_timezone
 * @property {string} record_date
 */

export function kstDate(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) throw new Error('invalid_date');
  return new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 10);
}

export function validateReading(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('schema_error');
  const r = value;
  const keys = ['signal_id', 'normalized_value', 'unit', 'source_name', 'source_url', 'source_time', 'fetched_at', 'record_timezone', 'record_date'];
  const validTime = (t) => typeof t === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(t) && Number.isFinite(Date.parse(t));
  if (
    Object.keys(r).length !== keys.length || keys.some((k) => !Object.hasOwn(r, k)) ||
    typeof r.signal_id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(r.signal_id) ||
    typeof r.normalized_value !== 'number' || !Number.isFinite(r.normalized_value) ||
    typeof r.unit !== 'string' || !r.unit.trim() || r.unit.length > 24 ||
    typeof r.source_name !== 'string' || !r.source_name.trim() || r.source_name.length > 120 ||
    typeof r.source_url !== 'string' || !URL.canParse(r.source_url) || new URL(r.source_url).protocol !== 'https:' ||
    !(r.source_time === null || validTime(r.source_time)) || !validTime(r.fetched_at) ||
    r.record_timezone !== 'Asia/Seoul' || r.record_date !== kstDate(r.fetched_at)
  ) throw new Error('schema_error');
}

export function emptyState() {
  return {
    daily_readings: [],
    current_reading: null,
    current_raw: null,
    status: { freshness: 'empty', error_code: 'none' },
    last_run: { fixture_id: null, fetched_at: null, retry_after_seconds: null },
  };
}

// Both the live weather collector and the synthetic fixture replay call this
// immutable, atomic upsert. Same signal_id + record_date never creates a
// second row; a later fetched_at always wins over an earlier one.
export function applySuccess(input, reading, raw = null) {
  validateReading(reading);
  const state = structuredClone(input);
  const index = state.daily_readings.findIndex(
    (row) => row.reading.signal_id === reading.signal_id && row.reading.record_date === reading.record_date
  );
  const existing = state.daily_readings[index];
  if (existing && Date.parse(existing.reading.fetched_at) > Date.parse(reading.fetched_at)) return state;
  const row = {
    record_id: existing?.record_id ?? `${reading.signal_id}:${reading.record_date}`,
    first_fetched_at: existing?.first_fetched_at ?? reading.fetched_at,
    reading: structuredClone(reading),
    raw: structuredClone(raw),
  };
  if (index >= 0) state.daily_readings[index] = row;
  else state.daily_readings.push(row);
  state.daily_readings.sort((a, b) => a.reading.record_date.localeCompare(b.reading.record_date));
  // A late/slow response must never replace a newer last-good observation.
  if (!state.current_reading || Date.parse(reading.fetched_at) >= Date.parse(state.current_reading.fetched_at)) {
    state.current_reading = structuredClone(reading);
    state.current_raw = structuredClone(raw);
    state.status = { freshness: 'fresh', error_code: 'none' };
    state.last_run = { fixture_id: null, fetched_at: reading.fetched_at, retry_after_seconds: null };
  }
  return state;
}

export function applyError(input, error, fetchedAt = null) {
  const state = structuredClone(input);
  state.status = { freshness: state.current_reading ? 'stale' : 'empty', error_code: error };
  state.last_run = { fixture_id: null, fetched_at: fetchedAt, retry_after_seconds: null };
  return state;
}

export function compare(current, previous) {
  if (!previous || current.signal_id !== previous.signal_id) return null;
  if (current.unit !== previous.unit || current.record_date <= previous.record_date) return null;
  const days = (Date.parse(current.record_date) - Date.parse(previous.record_date)) / 86400000;
  return { signed: current.normalized_value - previous.normalized_value, unit: current.unit, consecutive: days === 1, days };
}

export function runFixture(input, fixture) {
  const t = fixture.transport;
  let state;
  if (t.mode === 'timeout' || (t.delay_ms ?? 0) > (t.deadline_ms ?? Infinity)) state = applyError(input, 'timeout');
  else if (t.mode === 'offline') state = applyError(input, 'offline');
  else if (t.status === 401 || t.status === 403) state = applyError(input, 'auth');
  else if (t.status === 429) state = applyError(input, 'rate_limit');
  else if (t.status && t.status >= 200 && t.status < 300) {
    try {
      validateReading(fixture.payload);
      state = applySuccess(input, fixture.payload, fixture.payload);
    } catch {
      state = applyError(input, 'schema_error');
    }
  } else state = applyError(input, 'upstream');
  state.last_run = {
    fixture_id: fixture.fixture_id,
    fetched_at: fixture.virtual_now,
    retry_after_seconds: t.headers?.['retry-after'] ? Number(t.headers['retry-after']) : null,
  };
  return state;
}
