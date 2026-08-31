/**
 * A blunt guard against shipping a hollowed-out document.
 *
 * This exists because a stray second argument to String.split - which is the
 * *limit*, not a replacement - silently emptied README.md and it was committed
 * and pushed twice before anyone noticed. The tests all passed the whole time,
 * because nothing tested the documentation.
 */
import { readFileSync } from 'node:fs';

/** @type {[string, number, string[]][]} path, minimum bytes, required substrings */
const REQUIRED = [
  ['README.md', 8000, ['## Quick start', '## Limits', 'STDLIB.md', 'dist/shed.mjs']],
  ['STDLIB.md', 6000, ['## The substitutions', 'Where the standard library ran out']],
  ['deps-proof.txt', 500, ['ZERO THIRD-PARTY DEPENDENCIES']],
  ['.zero-dep.toml', 50, ['track']],
  ['LICENSE', 500, ['MIT License']],
];

let failed = 0;
for (const [path, minBytes, needles] of REQUIRED) {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    console.error(`FAIL ${path}: missing`);
    failed++;
    continue;
  }
  if (text.length < minBytes) {
    console.error(`FAIL ${path}: ${text.length} bytes, expected at least ${minBytes}`);
    failed++;
    continue;
  }
  const missing = needles.filter((needle) => !text.includes(needle));
  if (missing.length > 0) {
    console.error(`FAIL ${path}: missing ${missing.join(', ')}`);
    failed++;
    continue;
  }
  console.log(`ok   ${path} (${text.length} bytes)`);
}
process.exitCode = failed > 0 ? 1 : 0;
