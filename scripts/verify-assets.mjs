// verify-assets.mjs — hashes the 17 files under reference/ (everything the
// package lists except asset-manifest.json itself, which can't hash itself)
// and diffs against asset-manifest.json. Card 3's "첫 행동" step.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..', 'reference', 't04-real-information-board-public-v1');
const manifestPath = join(pkgDir, 'asset-manifest.json');

async function sha256(path) {
  const data = await readFile(path);
  return createHash('sha256').update(data).digest('hex');
}

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const results = [];
  for (const file of manifest.files) {
    const path = join(pkgDir, file.path);
    let actual;
    try { actual = await sha256(path); } catch { actual = null; }
    results.push({ path: file.path, expected: file.sha256, actual, bytes_expected: file.bytes, match: actual === file.sha256 });
  }
  const ok = results.every((r) => r.match);
  console.log(JSON.stringify({ package_id: manifest.package_id, file_count: results.length, all_match: ok, results }, null, 2));
  if (!ok) process.exitCode = 1;
}

main();
