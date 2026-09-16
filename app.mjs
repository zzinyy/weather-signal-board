import { applySuccess, applyError, compare, kstDate } from './lib/engine.mjs';
import { fetchWeather, SourceError, ERRORS, WMO, restoreLive, recordsState, SOURCE_URL, SOURCE_NAME } from './lib/weather.mjs';
import { loadFixtures, baseline as testBaseline, replayAction, failureKeys } from './lib/fixtures.mjs';

// TODO: edit before you deploy — used only for the footer "소스 저장소" link.
const REPO_URL = 'https://github.com/YOUR-GITHUB-USERNAME/weather-signal-board';

const STALE_AFTER_SECONDS = 1800; // Open-Meteo's current block refreshes roughly every 15–60 min.
const CACHE_KEY = 'weather:live-cache:v1';
const $ = (id) => document.getElementById(id);
const num = (v, d = 1) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const kstClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const kstDateTime = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const timeKst = (iso) => (iso ? `${kstDateTime.format(new Date(iso))} KST` : '—');

// ---------- Real weather state ----------
let published = { signal_id: 'seoul-temp', records: [], collection_status: null };
let liveState;
let inFlight = false;
let cooldownUntil = 0;
let lastLiveError = '';
let selectedDate = null; // null = current reading

async function loadPublished() {
  try {
    const res = await fetch('./public/data/records.json', { cache: 'no-store' });
    if (res.ok) published = await res.json();
  } catch { /* falls back to empty published state */ }
}

function currentInspected() {
  if (selectedDate) {
    const row = published.records.find((r) => r.reading.record_date === selectedDate);
    if (row) return row;
  }
  return { reading: liveState.current_reading, raw: liveState.current_raw };
}

function renderLive() {
  const { current_reading: reading, current_raw: raw, status } = liveState;
  const now = Date.now();
  const hasReading = !!reading;
  $('refresh-btn').disabled = inFlight || now < cooldownUntil;
  $('refresh-btn').textContent = inFlight ? '조회 중…' : now < cooldownUntil ? `${Math.ceil((cooldownUntil - now) / 1000)}초 후 재시도` : lastLiveError ? '다시 시도' : '새로 고침';

  if (!hasReading) {
    $('value-number').textContent = '—';
    $('value-unit').textContent = '';
    $('weather-desc').textContent = lastLiveError ? ERRORS[lastLiveError]?.title ?? '' : '아직 조회하지 않았습니다.';
  } else {
    $('value-number').textContent = num(reading.normalized_value);
    $('value-unit').textContent = reading.unit;
    $('weather-desc').textContent = raw?.current?.weather_code != null ? (WMO[raw.current.weather_code] ?? '') : '';
  }

  const ageSec = hasReading ? Math.max(0, Math.floor((now - Date.parse(reading.source_time)) / 1000)) : null;
  const stale = !!lastLiveError || (ageSec != null && ageSec > STALE_AFTER_SECONDS);
  const strip = $('status-strip');
  strip.classList.toggle('has-error', !!lastLiveError);
  $('status-title').textContent = lastLiveError ? ERRORS[lastLiveError].title : stale ? '저장된 관측 데이터' : hasReading ? '실제 조회 완료' : '대기 중';
  $('status-detail').textContent = lastLiveError ? ERRORS[lastLiveError].action : hasReading ? `출처 기준 ${ageSec < 60 ? ageSec + '초 전' : ageSec < 3600 ? Math.floor(ageSec / 60) + '분 전' : Math.floor(ageSec / 3600) + '시간 전'}` : '오른쪽 버튼으로 첫 조회를 시작하세요.';
  $('status-pill').textContent = stale ? '오래된 값' : hasReading ? '최근 값' : '—';
  $('status-pill').classList.toggle('amber', stale);
  $('error-detail').hidden = !lastLiveError;
  if (lastLiveError) $('error-detail').textContent = `${ERRORS[lastLiveError].detail} 이 표시는 앱의 데이터 수신 상태이며 실제 날씨의 이상을 뜻하지 않습니다.`;

  $('meta-source').innerHTML = `<a href="${SOURCE_URL}" target="_blank" rel="noreferrer">${SOURCE_NAME}</a>`;
  $('meta-source-time').textContent = hasReading ? timeKst(reading.source_time) : '—';
  $('meta-fetch-time').textContent = hasReading ? timeKst(reading.fetched_at) : '—';
  $('meta-tz').textContent = 'Asia/Seoul (KST, UTC+9)';

  renderRecordsTable();
  renderEvidence();
}

function renderRecordsTable() {
  const rows = published.records;
  const tbody = $('records-body');
  tbody.innerHTML = '';
  rows.forEach((row, i) => {
    const delta = i > 0 ? compare(row.reading, rows[i - 1].reading) : null;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono">${row.reading.record_date}</td>
      <td class="mono">${num(row.reading.normalized_value)} ${row.reading.unit}</td>
      <td>${delta && delta.consecutive ? `${delta.signed > 0 ? '+' : ''}${num(delta.signed)} ${delta.unit}` : '—'}</td>
      <td><button class="link-btn" data-inspect="${row.reading.record_date}">원자료 보기</button></td>`;
    tbody.appendChild(tr);
  });
  if (rows.length === 0) {
    tbody.innerHTML = '<tr class="pending-row"><td colspan="4">아직 공개 보존 기록이 없습니다. 첫 실제 날짜의 수집을 기다리는 중입니다.</td></tr>';
  } else if (rows.length < 2) {
    tbody.innerHTML += '<tr class="pending-row"><td>다음 실제 날짜</td><td>—</td><td>—</td><td>수집 대기</td></tr>';
  }
  $('records-count').textContent = `${String(rows.length).padStart(2, '0')} / 02일`;
  if (published.collection_status && published.collection_status.error_code !== 'none') {
    $('collection-note').hidden = false;
    $('collection-note').textContent = `공개 일별 수집 실패: ${ERRORS[published.collection_status.error_code]?.title ?? '응답 확인 불가'}. 마지막 성공 기록은 보존했습니다. 수집 시도: ${timeKst(published.collection_status.attempted_at)}.`;
  } else {
    $('collection-note').hidden = true;
  }
}

function renderEvidence() {
  const select = $('evidence-select');
  select.innerHTML = '<option value="">현재 관측값</option>' + published.records.map((r) => `<option value="${r.reading.record_date}">${r.reading.record_date} · 공개 보존 기록</option>`).join('');
  select.value = selectedDate ?? '';
  const inspected = currentInspected();
  if (!inspected.reading) {
    $('evidence-body').hidden = true;
    return;
  }
  $('evidence-body').hidden = false;
  $('evidence-url').innerHTML = `<a href="${inspected.reading.source_url}" target="_blank" rel="noreferrer">${inspected.reading.source_url}</a>`;
  $('evidence-source-time').textContent = timeKst(inspected.reading.source_time);
  $('evidence-fetch-time').textContent = timeKst(inspected.reading.fetched_at);
  $('evidence-tz').textContent = inspected.reading.record_timezone;
  $('evidence-raw').textContent = inspected.raw?.current?.temperature_2m ?? '—';
  $('evidence-normalized').textContent = inspected.reading.normalized_value;
  $('evidence-displayed').textContent = `${num(inspected.reading.normalized_value)} ${inspected.reading.unit}`;
  $('evidence-json').textContent = JSON.stringify(inspected.raw, null, 2);
}

async function refresh() {
  if (inFlight || Date.now() < cooldownUntil) return;
  inFlight = true; cooldownUntil = Date.now() + 3000; renderLive();
  try {
    if (!navigator.onLine) throw new SourceError('offline');
    const { record } = await fetchWeather();
    liveState = applySuccess(liveState, record.reading, record.raw);
    lastLiveError = '';
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(liveState)); } catch { /* storage may be blocked; not fatal */ }
  } catch (e) {
    const code = !navigator.onLine ? 'offline' : e instanceof SourceError ? e.code : 'network';
    liveState = applyError(liveState, code, new Date().toISOString());
    lastLiveError = code;
    if (e instanceof SourceError && e.retryAfter) cooldownUntil = Date.now() + e.retryAfter * 1000;
  } finally {
    inFlight = false; renderLive();
  }
}

function download(inspected) {
  const blob = new Blob([JSON.stringify(inspected, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `weather-${inspected.reading.record_date}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Synthetic test lab (never touches real weather state) ----------
let fixtures = null;
let testState = { daily_readings: [], current_reading: null, status: { freshness: 'empty', error_code: 'none' } };

function renderTestLab() {
  const s = testState;
  $('test-status-title').textContent = s.status.error_code !== 'none' ? (ERRORS[s.status.error_code]?.title ?? s.status.error_code) : s.status.freshness === 'fresh' ? '정상' : '초기화됨';
  $('test-status-pill').textContent = s.status.freshness;
  $('test-status-pill').className = `pill ${s.status.freshness === 'stale' ? 'amber' : s.status.freshness === 'fresh' ? 'green' : ''}`;
  $('test-error-code').textContent = s.status.error_code;
  $('test-value').textContent = s.current_reading ? `${s.current_reading.normalized_value} ${s.current_reading.unit}` : '—';
  $('test-rows').textContent = String(s.daily_readings.length);
  const delta = s.daily_readings.length > 1 ? compare(s.daily_readings.at(-1).reading, s.daily_readings.at(-2).reading) : null;
  $('test-delta').textContent = delta ? `${delta.signed > 0 ? '+' : ''}${delta.signed} ${delta.unit}` : '—';
  $('test-fixture').textContent = s.last_run?.fixture_id ?? '—';
}

async function runTestAction(action) {
  try {
    if (!fixtures) fixtures = await loadFixtures('./fixtures/');
    testState = replayAction(fixtures, testState, action);
  } catch (e) {
    console.error(e);
  }
  renderTestLab();
}

// ---------- Wire up ----------
async function setSourceLink() {
  const link = $('source-link');
  link.href = REPO_URL;
  try {
    const res = await fetch('./public/data/build.json', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (typeof data.revision === 'string' && /^[a-f0-9]{40}$/.test(data.revision)) {
      link.href = `${REPO_URL}/tree/${data.revision}`;
      link.textContent = '이 배포의 소스';
    }
  } catch { /* build.json only exists after the Actions workflow has run once */ }
}

async function main() {
  await loadPublished();
  liveState = restoreLive(published.records, CACHE_KEY);
  renderLive();
  renderTestLab();
  setSourceLink();

  $('refresh-btn').addEventListener('click', refresh);
  $('evidence-select').addEventListener('change', (e) => { selectedDate = e.target.value || null; renderEvidence(); });
  $('evidence-download').addEventListener('click', () => download(currentInspected()));
  $('records-body').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-inspect]');
    if (!btn) return;
    selectedDate = btn.dataset.inspect;
    renderEvidence();
    $('evidence-panel').open = true;
    $('evidence-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  document.querySelectorAll('[data-test-action]').forEach((btn) => {
    btn.addEventListener('click', () => runTestAction(btn.dataset.testAction));
  });

  setInterval(() => { $('clock').textContent = kstClock.format(Date.now()); renderLive(); }, 1000);
  $('clock').textContent = kstClock.format(Date.now());
}

main();
