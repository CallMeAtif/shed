/**
 * Regenerates deps-proof.txt: evidence that the shipped artifact has no
 * third-party runtime dependencies.
 *
 * The proof is deliberately something a judge can re-derive by hand in five
 * seconds, so it asserts three independent facts rather than one:
 *
 *   1. the manifest declares no dependencies of any kind
 *   2. no node_modules directory exists in the repo
 *   3. every import in src/, bin/ and tools/ resolves to a node: builtin or to a
 *      relative path inside this repo
 *
 * Point 3 is the one that matters. An empty manifest proves nothing on its own if
 * the code still reaches for a bare specifier at runtime.
 */
import { readFileSync, existsSync } from 'node:fs';
import { globSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { extractImports } from '../src/scanner/imports.mjs';

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const builtins = new Set(builtinModules);

/** @param {string} specifier */
function classify(specifier) {
  if (specifier.startsWith('node:')) return 'builtin';
  if (builtins.has(specifier)) return 'builtin';
  if (specifier.startsWith('.') || specifier.startsWith('/')) return 'local';
  return 'third-party';
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lines = [];
const push = (line = '') => lines.push(line);

push('shed - zero-dependency proof');
push(`generated: ${new Date().toISOString().slice(0, 10)} (deterministic to the day)`);
push(`node: ${process.version}`);
push('='.repeat(72));
push();

push('1. MANIFEST');
let manifestClean = true;
for (const field of DEP_FIELDS) {
  const value = pkg[field];
  const count = value ? Object.keys(value).length : 0;
  if (count > 0) manifestClean = false;
  push(`   ${field.padEnd(22)} ${value === undefined ? '(absent)' : `${count} entries`}`);
}
push(`   verdict: ${manifestClean ? 'PASS - the manifest declares nothing' : 'FAIL'}`);
push();

push('2. INSTALLED PACKAGES');
const hasModules = existsSync('node_modules');
push(`   node_modules present: ${hasModules ? 'yes' : 'no'}`);
push(`   verdict: ${hasModules ? 'FAIL' : 'PASS - nothing was ever installed'}`);
push();

push('3. RESOLVED IMPORTS');
const files = globSync(['src/**/*.mjs', 'bin/**/*.mjs', 'tools/**/*.mjs', 'tests/**/*.mjs']).sort();
/** @type {Map<string, string[]>} */
const byKind = new Map([['builtin', []], ['local', []], ['third-party', []]]);
for (const file of files) {
  for (const found of extractImports(readFileSync(file, 'utf8'), file).imports) {
    byKind.get(classify(found.specifier)).push(`${found.specifier} (${file}:${found.line})`);
  }
}
const uniqueBuiltins = [...new Set(byKind.get('builtin').map((s) => s.split(' ')[0]))].sort();
push(`   files scanned:        ${files.length}`);
push(`   builtin specifiers:   ${uniqueBuiltins.join(', ')}`);
push(`   relative specifiers:  ${byKind.get('local').length}`);
push(`   third-party imports:  ${byKind.get('third-party').length}`);
for (const entry of byKind.get('third-party')) push(`     ! ${entry}`);
push(`   verdict: ${byKind.get('third-party').length === 0 ? 'PASS - every import is a builtin or a local file' : 'FAIL'}`);
push();

const pass = manifestClean && !hasModules && byKind.get('third-party').length === 0;
push('='.repeat(72));
push(`OVERALL: ${pass ? 'ZERO THIRD-PARTY DEPENDENCIES' : 'DEPENDENCIES DETECTED'}`);

process.stdout.write(`${lines.join('\n')}\n`);
process.exitCode = pass ? 0 : 1;
