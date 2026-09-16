// fixtures.mjs — loads the 9 public, deterministic ALEPH fixtures and
// replays them through the exact same engine.mjs functions the live
// collector uses. Fixture values are synthetic ("pt") and never written
// into the real weather signal's storage.

import { emptyState, runFixture } from './engine.mjs';

const NAMES = {
  'normal-d1-a': 'normal-d1-a.json',
  'normal-d1-b': 'normal-d1-b.json',
  'normal-d2': 'normal-d2.json',
  timeout: 'timeout.json',
  auth: 'auth-401.json',
  rate_limit: 'rate-429.json',
  offline: 'offline.json',
  schema_error: 'schema-break.json',
  'recover-d2': 'recover-d2.json',
};

export const failureKeys = ['timeout', 'auth', 'rate_limit', 'offline', 'schema_error'];

let cache = null;
export async function loadFixtures(base = './fixtures/') {
  if (cache) return cache;
  const entries = await Promise.all(
    Object.entries(NAMES).map(async ([key, file]) => {
      const res = await fetch(base + file, { cache: 'no-store' });
      if (!res.ok) throw new Error(`fixture_load_failed:${file}`);
      return [key, await res.json()];
    })
  );
  cache = Object.fromEntries(entries);
  return cache;
}

export function baseline(fixtures) {
  return runFixture(runFixture(emptyState(), fixtures['normal-d1-a']), fixtures['normal-d1-b']);
}

export function replayAction(fixtures, state, action) {
  if (action === 'reset') return emptyState();
  if (!Object.hasOwn(fixtures, action)) throw new Error('unknown_fixture');
  return runFixture(failureKeys.includes(action) ? baseline(fixtures) : state, fixtures[action]);
}
