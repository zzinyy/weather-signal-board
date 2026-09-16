// weather.mjs — the one part of the app that actually knows about "weather".
// Everything else (engine.mjs, fixtures.mjs, app.mjs) is signal-agnostic.

import { kstDate, validateReading, emptyState, applySuccess } from './engine.mjs';

// Seoul City Hall coordinates. Open-Meteo needs no API key, supports CORS,
// and is a non-personal public source — so there is nothing secret to leak.
export const LAT = 37.5665;
export const LON = 126.978;
export const SIGNAL_ID = 'seoul-temp';
export const SOURCE_NAME = 'Open-Meteo';
export const SOURCE_URL =
  `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,weather_code,wind_speed_10m&timezone=UTC`;

export class SourceError extends Error {
  constructor(code, retryAfter = 0) {
    super(code);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function retrySeconds(header, now = Date.now()) {
  if (!header) return 30;
  const seconds = /^\d+$/.test(header) ? Number(header) : Math.ceil((Date.parse(header) - now) / 1000);
  return Number.isFinite(seconds) ? Math.max(3, seconds) : 30;
}

// Open-Meteo, with timezone=UTC, returns "current.time" as a naive
// (offset-less) UTC timestamp like "2026-09-16T06:00". Normalize it to a
// real ISO-8601 UTC instant so it passes validateReading's time check.
function toIsoUtc(naive) {
  if (typeof naive !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(naive)) return `${naive}:00Z`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(naive)) return `${naive}Z`;
  return naive; // already has an offset/Z, or unrecognized — let validateReading reject it
}

export const WMO = {
  0: '맑음', 1: '대체로 맑음', 2: '부분 흐림', 3: '흐림',
  45: '안개', 48: '착빙 안개',
  51: '이슬비 약함', 53: '이슬비', 55: '이슬비 강함',
  61: '비 약함', 63: '비', 65: '비 강함',
  71: '눈 약함', 73: '눈', 75: '눈 강함', 77: '싸락눈',
  80: '소나기 약함', 81: '소나기', 82: '소나기 강함',
  95: '뇌우', 96: '뇌우(우박 동반)', 99: '뇌우(강한 우박)',
};

export function normalize(raw, fetchedAt) {
  const current = raw && raw.current;
  const units = raw && raw.current_units;
  const sourceTime = toIsoUtc(current && current.time);
  if (
    !current || !units ||
    typeof current.temperature_2m !== 'number' || !Number.isFinite(current.temperature_2m) ||
    typeof units.temperature_2m !== 'string' || !units.temperature_2m.trim() ||
    !sourceTime
  ) {
    throw new Error('schema_error');
  }
  const reading = {
    signal_id: SIGNAL_ID,
    normalized_value: current.temperature_2m,
    unit: units.temperature_2m, // "°C"
    source_name: SOURCE_NAME,
    source_url: SOURCE_URL,
    source_time: sourceTime,
    fetched_at: fetchedAt,
    record_timezone: 'Asia/Seoul',
    record_date: kstDate(fetchedAt),
  };
  validateReading(reading);
  return reading;
}

export async function fetchWeather(options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  const clock = options.clock ?? (() => new Date());
  try {
    const response = await (options.fetcher ?? fetch)(SOURCE_URL, { signal: controller.signal, cache: 'no-store' });
    if (response.status === 401 || response.status === 403) throw new SourceError('auth');
    if (response.status === 429) throw new SourceError('rate_limit', retrySeconds(response.headers.get('retry-after'), clock().getTime()));
    if (!response.ok) throw new SourceError('upstream');
    const rawText = await response.text();
    let raw;
    try { raw = JSON.parse(rawText); } catch { throw new SourceError('schema_error'); }
    const fetchedAt = clock().toISOString();
    try { return { record: { raw, reading: normalize(raw, fetchedAt) }, rawText }; }
    catch { throw new SourceError('schema_error'); }
  } catch (e) {
    if (controller.signal.aborted) throw new SourceError('timeout');
    if (e instanceof SourceError) throw e;
    throw new SourceError('network');
  } finally {
    clearTimeout(timer);
  }
}

// Re-derives each stored record from its own raw payload and rejects the
// batch if a stored reading was hand-edited or corrupted. Used both to
// rebuild state from the public records.json and to verify the browser's
// own localStorage cache before trusting it.
export function recordsState(records) {
  return records.reduce((state, record) => {
    const verified = normalize(record.raw, record.reading.fetched_at);
    for (const key of Object.keys(verified)) {
      if (key === 'source_time' || key === 'fetched_at') {
        if (Date.parse(verified[key]) !== Date.parse(record.reading[key])) throw new Error('stored_reading_mismatch');
      } else if (verified[key] !== record.reading[key]) throw new Error('stored_reading_mismatch');
    }
    return applySuccess(state, record.reading, record.raw);
  }, emptyState());
}

export function restoreLive(published, cacheKey = 'weather:live-cache:v1') {
  const baseline = recordsState(published);
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (!cached || typeof cached !== 'object' || !Array.isArray(cached.daily_readings) || cached.daily_readings.length > 366) return baseline;
    const rows = cached.daily_readings.map((row) => ({ raw: row.raw, reading: row.reading }));
    const verified = recordsState(rows);
    return verified.daily_readings.reduce((state, row) => applySuccess(state, row.reading, row.raw), baseline);
  } catch {
    return baseline;
  }
}

export const ERRORS = {
  timeout: { title: '응답이 늦어지고 있습니다', detail: '제한 시간 안에 데이터를 받지 못했습니다. 마지막 정상값을 유지합니다.', action: '잠시 후 다시 시도해 주세요.' },
  auth: { title: '데이터 원천이 접근을 거절했습니다', detail: '외부 원천의 401/403 응답입니다. 이 정보판에 로그인할 필요는 없습니다.', action: '출처의 서비스 공지를 확인하고 다시 시도해 주세요.' },
  rate_limit: { title: '조회 요청이 너무 많습니다', detail: '외부 원천의 호출 제한에 도달했습니다. 마지막 정상값을 유지합니다.', action: '호출을 멈추고 대기한 뒤 다시 시도해 주세요.' },
  offline: { title: '인터넷에 연결되어 있지 않습니다', detail: '연결을 확인할 때까지 마지막 정상값을 표시합니다.', action: '인터넷 연결을 복구한 뒤 다시 시도해 주세요.' },
  schema_error: { title: '데이터 형식을 확인할 수 없습니다', detail: '필수 값이나 단위가 예상과 달라 새 값을 저장하지 않았습니다.', action: '출처 응답과 연동 형식을 확인한 뒤 다시 시도해 주세요.' },
  network: { title: '데이터 원천에 연결하지 못했습니다', detail: '네트워크 또는 브라우저 접근 제한으로 응답을 확인하지 못했습니다.', action: '연결과 출처의 상태를 확인하고 다시 시도해 주세요.' },
  upstream: { title: '외부 서비스에서 오류가 발생했습니다', detail: '새 값을 확인하지 못해 마지막 정상값을 유지합니다.', action: '출처의 서비스 상태를 확인하고 잠시 후 다시 시도해 주세요.' },
};
