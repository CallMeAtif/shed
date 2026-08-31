/**
 * The build step: inline the module graph into a single runnable file.
 *
 * This is the job esbuild or rollup would normally do. Doing it by hand is
 * tractable because the input is not arbitrary JavaScript - it is this
 * repository, which uses a deliberately narrow subset of ESM (single-line named
 * imports, named exports only, no circular edges). The bundler asserts the
 * import and export *forms* it supports and fails loudly on anything else.
 * Circular edges are assumed, not verified: a cycle would recurse forever at
 * runtime rather than being caught here. Nothing in src/ has one, and the check
 * is not worth the risk of adding at this stage - but the claim should not be
 * broader than the code.
 *
 * Each module becomes a lazily-initialised function returning its exports, so
 * module scopes stay separate and identifiers cannot collide. That is what makes
 * the transform purely syntactic: no scope analysis, no renaming.
 *
 * The output is deterministic. Modules are emitted in sorted path order, no
 * timestamp or absolute path is written, and the header is fixed. Building twice
 * produces byte-identical output; `make build && sha256sum dist/shed.mjs` twice
 * is the proof.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';

const ENTRY = 'bin/shed.mjs';
const OUT = 'dist/shed.mjs';
// Anchored to this file, not the shell's working directory, so the build works
// from anywhere rather than only from the repository root under make.
const ROOT = resolve(import.meta.dirname, '..');

/** `import { a, b } from 'spec';` - the only import form this repository uses. */
const IMPORT_RE = /^import\s+\{([^}]*)\}\s+from\s+'([^']+)';?\s*$/;
/** `import 'spec';` */
const BARE_IMPORT_RE = /^import\s+'([^']+)';?\s*$/;
/** Anything else starting with `import` is outside the supported subset. */
const ANY_IMPORT_RE = /^\s*import\b/;

/** @param {string} path repo-relative */
function moduleId(path) {
  return `__m_${path.replace(/[^A-Za-z0-9]/g, '_')}`;
}

/**
 * Rewrite one module into a function body, and report what it needs and provides.
 * @param {string} path repo-relative path
 * @returns {{ body: string, deps: string[], builtins: Map<string, string[]>, exports: string[] }}
 */
function transform(path) {
  // The entry point carries its own shebang; the bundle supplies one of its own,
  // and a second copy partway down the file is a syntax error.
  const source = readFileSync(join(ROOT, path), 'utf8').replace(/^#![^\n]*\n/, '');
  /** @type {string[]} */
  const deps = [];
  /** Builtin specifier -> the names imported from it, merged across modules later. */
  /** @type {Map<string, string[]>} */
  const builtins = new Map();
  /** @type {string[]} */
  const exports = [];
  /** @type {string[]} */
  const out = [];

  for (const line of source.split('\n')) {
    const named = IMPORT_RE.exec(line);
    if (named) {
      const [, names, specifier] = named;
      if (specifier.startsWith('node:')) {
        // Two modules importing `join` from node:path would emit the binding
        // twice, so builtin imports are merged per specifier rather than copied.
        const existing = builtins.get(specifier) ?? [];
        existing.push(...names.split(',').map((n) => n.trim()).filter(Boolean));
        builtins.set(specifier, existing);
        continue;
      }
      const target = normalise(path, specifier);
      deps.push(target);
      out.push(`const {${names.trim()}} = ${moduleId(target)}();`);
      continue;
    }

    const bare = BARE_IMPORT_RE.exec(line);
    if (bare) {
      if (bare[1].startsWith('node:')) {
        if (!builtins.has(bare[1])) builtins.set(bare[1], []);
        continue;
      }
      const target = normalise(path, bare[1]);
      deps.push(target);
      out.push(`${moduleId(target)}();`);
      continue;
    }

    if (ANY_IMPORT_RE.test(line) && !line.trimStart().startsWith('*') && !line.includes('import.meta')) {
      throw new Error(`${path}: import form outside the supported subset:\n  ${line.trim()}`);
    }

    // `export function f(`, `export const X =`, `export class C`
    const decl = /^export\s+(async\s+)?(function|const|let|class)\s+([A-Za-z0-9_$]+)/.exec(line);
    if (decl) {
      exports.push(decl[3]);
      out.push(line.replace(/^export\s+/, ''));
      continue;
    }

    // `export { a, b };`
    const list = /^export\s+\{([^}]*)\};?\s*$/.exec(line);
    if (list) {
      for (const name of list[1].split(',').map((s) => s.trim()).filter(Boolean)) exports.push(name);
      continue;
    }

    if (/^export\s+default\b/.test(line)) {
      throw new Error(`${path}: default exports are not part of the supported subset`);
    }

    out.push(line);
  }

  return { body: out.join('\n'), deps, builtins, exports };
}

/** Resolve a relative specifier against the importing file, repo-relative. */
function normalise(fromPath, specifier) {
  const resolved = resolve(dirname(join(ROOT, fromPath)), specifier);
  return relative(ROOT, resolved).split(sep).join('/');
}

/** Walk the graph from the entry point. @returns {Map<string, ReturnType<transform>>} */
function collect(entry) {
  /** @type {Map<string, ReturnType<transform>>} */
  const modules = new Map();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.shift();
    if (modules.has(path)) continue;
    const module = transform(path);
    modules.set(path, module);
    queue.push(...module.deps);
  }
  return modules;
}

const modules = collect(ENTRY);

// Sorted emission order is what makes the build reproducible: Map iteration
// order follows discovery, which follows the filesystem, which is not stable.
const paths = [...modules.keys()].sort();

/** @type {Map<string, Set<string>>} */
const builtins = new Map();
for (const path of paths) {
  for (const [specifier, names] of modules.get(path).builtins) {
    if (!builtins.has(specifier)) builtins.set(specifier, new Set());
    for (const name of names) builtins.get(specifier).add(name);
  }
}

const builtinLines = [...builtins.entries()]
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([specifier, names]) =>
    names.size === 0
      ? `import '${specifier}';`
      : `import { ${[...names].sort().join(', ')} } from '${specifier}';`);

const chunks = [
  '#!/usr/bin/env node',
  '// shed - built by tools/bundle.mjs from the sources in src/ and bin/.',
  '// Single file, no dependencies, no build-time state: this output is byte-for-byte',
  '// reproducible from the same commit. See README.md for the published hashes.',
  '',
  builtinLines.join('\n'),
  '',
];

for (const path of paths) {
  if (path === ENTRY) continue;
  const module = modules.get(path);
  const id = moduleId(path);
  chunks.push(
    `let ${id}__c;`,
    `function ${id}() {`,
    `  if (${id}__c) return ${id}__c;`,
    module.body.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n'),
    `  return (${id}__c = { ${module.exports.join(', ')} });`,
    '}',
    '',
  );
}

// The entry point runs last, at top level, with its imports already rewritten.
chunks.push('// --- entry point ---', modules.get(ENTRY).body);

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const output = `${chunks.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
  .replace("const BAKED_VERSION = '0.0.0-dev';", `const BAKED_VERSION = '${version}';`);

mkdirSync(join(ROOT, 'dist'), { recursive: true });
writeFileSync(join(ROOT, OUT), output);

const hash = createHash('sha256').update(output).digest('hex');
process.stdout.write(
  `built ${OUT}\n` +
  `  ${paths.length} modules, ${output.length} bytes\n` +
  `  sha256 ${hash}\n`,
);
