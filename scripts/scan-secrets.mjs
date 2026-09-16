// scan-secrets.mjs — greps tracked source/deploy files for common secret
// shapes. Not exhaustive (no scanner can guarantee every secret format),
// but Open-Meteo needs no key at all, so there is nothing this app should
// ever need to hide in the first place.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.github']);
const TEXT_EXT = new Set(['.js', '.mjs', '.ts', '.tsx', '.html', '.css', '.json', '.md', '.yml', '.yaml']);

const PATTERNS = [
  { name: 'generic_api_key_assignment', re: /(api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/gi },
  { name: 'aws_access_key_id', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'bearer_token', re: /Bearer\s+[A-Za-z0-9._\-]{20,}/g },
  { name: 'private_key_block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

async function main() {
  const findings = [];
  for await (const file of walk(ROOT)) {
    if (!TEXT_EXT.has(extname(file))) continue;
    const s = await stat(file);
    if (s.size > 2_000_000) continue;
    const text = await readFile(file, 'utf8');
    for (const { name, re } of PATTERNS) {
      const matches = text.match(re);
      if (matches) findings.push({ file: file.replace(ROOT + '/', ''), pattern: name, count: matches.length });
    }
  }
  const result = { scanned_at: new Date().toISOString(), findings, clean: findings.length === 0, note_ko: '일반 비밀값 패턴 검색이며 모든 형식을 보장하지 않습니다. 이 앱의 외부 API(Open-Meteo)는 키가 필요 없습니다.' };
  console.log(JSON.stringify(result, null, 2));
  if (!result.clean) process.exitCode = 1;
}

main();
