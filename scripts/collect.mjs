// collect.mjs — runs in GitHub Actions (Node 22+, global fetch built in).
// Fetches ONE real reading from Open-Meteo, normalizes it through the same
// engine.mjs the browser uses, and atomically updates public/data/records.json.
// No API key: nothing to put in an Actions secret, nothing to leak.
import { readFile, writeFile, rename, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySuccess } from '../lib/engine.mjs';
import { fetchWeather, recordsState, SIGNAL_ID } from '../lib/weather.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dataPath = join(here, '..', 'public', 'data', 'records.json');

async function loadExisting() {
  try {
    const text = await readFile(dataPath, 'utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.records) ? parsed.records : [];
  } catch {
    return [];
  }
}

async function atomicWrite(path, content) {
  const dir = await mkdtemp(join(tmpdir(), 'weather-board-'));
  const tmpFile = join(dir, 'records.json.tmp');
  await writeFile(tmpFile, content, 'utf8');
  await rename(tmpFile, path); // rename is atomic on the same filesystem
}

async function main() {
  const existingRecords = await loadExisting();
  // Reject the file up front if it was hand-edited into an inconsistent state.
  const baseline = recordsState(existingRecords);

  let collectionStatus = { error_code: 'none', attempted_at: new Date().toISOString() };
  let nextState = baseline;
  try {
    const { record } = await fetchWeather();
    nextState = applySuccess(baseline, record.reading, record.raw);
    console.log(`[collect] ok ${record.reading.record_date} ${record.reading.normalized_value}${record.reading.unit}`);
  } catch (e) {
    collectionStatus = { error_code: e?.code ?? 'network', attempted_at: new Date().toISOString() };
    console.error(`[collect] failed: ${collectionStatus.error_code} — keeping last good public record`);
  }

  const out = {
    signal_id: SIGNAL_ID,
    records: nextState.daily_readings.map((row) => ({ reading: row.reading, raw: row.raw })),
    collection_status: collectionStatus,
  };
  await atomicWrite(dataPath, JSON.stringify(out, null, 2) + '\n');

  if (collectionStatus.error_code !== 'none') process.exitCode = 1; // let the workflow surface the failure
}

main();
