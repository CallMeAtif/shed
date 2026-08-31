/**
 * Reading a project off disk: its manifest, its Node floor, and its source files.
 *
 * Everything here is filesystem-only. shed never spawns `npm`, `git` or anything
 * else to learn about a project - it reads the files those tools already wrote,
 * which is what keeps the artifact honestly dependency-free.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Diagnostic } from './errors.mjs';
import { lowerBound } from './semver.mjs';

/** Source extensions worth scanning for imports. */
export const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts']);

/** Directories never worth walking, whatever .gitignore says. */
const ALWAYS_PRUNE = new Set(['node_modules', '.git', '.hg', '.svn']);

/**
 * Files above this size are almost always bundles or vendored blobs. Scanning
 * them is slow and their imports are not the project's own, so they are skipped
 * and counted rather than parsed.
 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** @typedef {{ range: string, field: string }} Declared */

/**
 * @param {string} dir
 * @returns {{ pkg: object, path: string }}
 * @throws {Diagnostic} when the manifest is missing or unparseable
 */
export function loadManifest(dir) {
  const path = join(dir, 'package.json');
  if (!existsSync(path)) {
    throw new Diagnostic('no package.json here - point shed at a JavaScript project', {
      file: path, line: 1, col: 1, offset: 0,
    });
  }
  const text = readFileSync(path, 'utf8');
  try {
    return { pkg: JSON.parse(text), path };
  } catch (err) {
    // V8 reports a character offset; turn it into a line and column so the
    // failure reads like every other diagnostic shed prints.
    const at = /position (\d+)/.exec(/** @type {Error} */ (err).message);
    const offset = at ? Number(at[1]) : 0;
    const before = text.slice(0, offset);
    const line = before.split('\n').length;
    const col = offset - before.lastIndexOf('\n');
    throw new Diagnostic(`package.json is not valid JSON: ${/** @type {Error} */ (err).message}`, {
      file: path, line, col, offset,
    }, text.split('\n')[line - 1]);
  }
}

/**
 * Every dependency the manifest declares, across all four dependency fields.
 *
 * peerDependencies are excluded: they are a contract with the consumer rather
 * than something this project installs.
 *
 * @param {object} pkg
 * @returns {Map<string, Declared>}
 */
export function declaredDependencies(pkg) {
  /** @type {Map<string, Declared>} */
  const deps = new Map();
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const block = pkg[field];
    if (!block || typeof block !== 'object') continue;
    for (const [name, range] of Object.entries(block)) {
      // A package listed twice keeps its first, more meaningful, field.
      if (!deps.has(name)) deps.set(name, { range: String(range), field });
    }
  }
  return deps;
}

/**
 * The Node version a recommendation has to clear.
 *
 * `engines.node` is the honest answer when it exists, because it is what the
 * project promises to run on. Falling back to the running Node would let shed
 * recommend an API the project's own users cannot call.
 *
 * @param {object} pkg
 * @param {string} [override] value of --node
 * @returns {{ version: string, source: 'flag'|'engines'|'runtime' }}
 */
export function resolveNodeFloor(pkg, override) {
  if (override) {
    const floor = lowerBound(override) ?? override.replace(/^v/, '');
    return { version: floor, source: 'flag' };
  }
  const declared = pkg?.engines?.node;
  if (typeof declared === 'string') {
    const floor = lowerBound(declared);
    if (floor) return { version: floor, source: 'engines' };
  }
  return { version: process.version.replace(/^v/, ''), source: 'runtime' };
}

/** @typedef {{ files: string[], skipped: { path: string, reason: string }[], nested: string[] }} Walk */

/**
 * Collect source files under `dir`, pruning ignored directories as it goes.
 *
 * Pruning at the directory level rather than filtering a full listing is the
 * whole performance story: a repository with node_modules present is otherwise
 * dominated by paths that were never going to be scanned.
 *
 * @param {string} dir
 * @param {import('./gitignore.mjs').Ignore} ignore
 * @returns {Walk}
 */
export function walkSource(dir, ignore) {
  /** @type {string[]} */
  const files = [];
  /** @type {{ path: string, reason: string }[]} */
  const skipped = [];
  /** @type {string[]} */
  const nested = [];

  /** @param {string} absolute */
  const visit = (absolute) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch (err) {
      skipped.push({ path: toRelative(dir, absolute), reason: /** @type {Error} */ (err).code ?? 'unreadable' });
      return;
    }

    for (const entry of entries) {
      const child = join(absolute, entry.name);
      const rel = toRelative(dir, child);

      if (entry.isDirectory()) {
        if (ALWAYS_PRUNE.has(entry.name)) continue;
        if (ignore.ignores(rel, true)) continue;
        // A directory with its own package.json is a different project, and its
        // source answers to a different manifest. Walking into it made a
        // workspace root report "nothing removable" about 554 files it had no
        // business judging.
        if (existsSync(join(child, 'package.json'))) {
          nested.push(rel);
          continue;
        }
        visit(child);
        continue;
      }
      if (!entry.isFile()) continue;

      const dot = entry.name.lastIndexOf('.');
      if (dot === -1 || !SOURCE_EXTENSIONS.has(entry.name.slice(dot))) continue;
      if (ignore.ignores(rel, false)) continue;

      try {
        if (statSync(child).size > MAX_FILE_BYTES) {
          skipped.push({ path: rel, reason: 'larger than 2 MB, assumed to be a bundle' });
          continue;
        }
      } catch {
        skipped.push({ path: rel, reason: 'unreadable' });
        continue;
      }
      files.push(rel);
    }
  };

  visit(dir);
  files.sort(); // deterministic output regardless of filesystem ordering
  nested.sort();
  return { files, skipped, nested };
}

/** Repository-relative, forward-slashed, for both display and pattern matching. */
function toRelative(root, absolute) {
  return relative(root, absolute).split(sep).join('/');
}

/**
 * Load the ignore rules for a project: its .gitignore plus shed's own defaults.
 * @param {string} dir
 * @param {typeof import('./gitignore.mjs').Ignore} Ignore
 * @param {string[]} extra
 */
export function loadIgnore(dir, Ignore, extra = []) {
  const path = join(dir, '.gitignore');
  const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  return Ignore.parse(content, ['node_modules/', '.git/', ...extra]);
}

/**
 * Read the project's package-lock.json, if it has one.
 *
 * Absence is normal, not an error: a project may use another package manager, or
 * may simply not have installed yet. shed degrades to reporting download reach
 * without transitive counts, and says which it is doing.
 *
 * @param {string} dir
 * @param {(text: string) => { lock: object|null, reason: string|null }} parse
 * @returns {{ lock: object|null, reason: string|null }}
 */
export function loadLockfile(dir, parse) {
  const path = join(dir, 'package-lock.json');
  if (!existsSync(path)) return { lock: null, reason: null };
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { lock: null, reason: /** @type {Error} */ (err).message };
  }
}

/**
 * Config files that reference a dependency by name without importing it.
 *
 * Only non-source formats are listed: a `.eslintrc.cjs` or `vite.config.ts` is
 * already walked as source, so its imports are found the normal way. These are
 * the ones where a package name appears as a bare string in JSON or YAML.
 */
const CONFIG_FILES = [
  '.eslintrc', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
  '.prettierrc', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml',
  '.stylelintrc', '.stylelintrc.json', '.babelrc', '.babelrc.json',
  'babel.config.json', 'tsconfig.json', 'jsconfig.json', '.npmrc', '.nvmrc',
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  'lerna.json', 'turbo.json', 'nx.json', 'renovate.json', '.releaserc',
  '.releaserc.json', 'commitlint.config.json', '.lintstagedrc',
  '.lintstagedrc.json', '.markdownlint.json', 'netlify.toml', 'vercel.json',
];

/**
 * Text in which a dependency may be named without being imported.
 *
 * Includes the manifest itself with the dependency blocks stripped, so that
 * `eslintConfig`, `lint-staged`, `husky` and `browserslist` sections count, and
 * the CI workflows, where a tool is usually invoked by name.
 *
 * @param {string} dir
 * @param {object} pkg
 * @returns {string}
 */
export function loadConfigText(dir, pkg) {
  const manifest = { ...pkg };
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    delete manifest[field];
  }

  const parts = [JSON.stringify(manifest)];

  // Framework configs name their plugins as bare strings or object keys rather
  // than importing them - postcss.config.js lists `autoprefixer` as a key, and
  // tailwind/next/vite configs do the same. Matching by shape rather than by a
  // fixed list keeps this working for the next framework too.
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/(\.config\.[cm]?[jt]s$|\.config\.(json|ya?ml)$|^\.[a-z]+rc)/i.test(entry.name)) continue;
      try {
        parts.push(readFileSync(join(dir, entry.name), 'utf8'));
      } catch {
        // unreadable config contributes nothing
      }
    }
  } catch {
    // unreadable project root; the manifest text alone still counts
  }

  for (const name of CONFIG_FILES) {
    const path = join(dir, name);
    if (existsSync(path)) {
      try {
        parts.push(readFileSync(path, 'utf8'));
      } catch {
        // An unreadable config file simply contributes nothing.
      }
    }
  }

  const workflows = join(dir, '.github', 'workflows');
  if (existsSync(workflows)) {
    try {
      for (const entry of readdirSync(workflows, { withFileTypes: true })) {
        if (entry.isFile() && /\.ya?ml$/.test(entry.name)) {
          parts.push(readFileSync(join(workflows, entry.name), 'utf8'));
        }
      }
    } catch {
      // ditto
    }
  }
  return parts.join('\n');
}

/**
 * Packages implied by the shape of the project rather than named anywhere.
 *
 * Two conventions do most of the work. A `<name>.config.*` file at the root
 * implies `<name>` (tailwind, postcss, vite, jest, next), and a `.<name>rc` file
 * implies `<name>` (eslint, prettier, stylelint). Neither package is imported,
 * and neither is named in a script - `next lint` does not contain the string
 * "eslint" - so without this they look dead and `--fix` deletes the toolchain.
 *
 * @param {string} dir
 * @param {string[]} files repository-relative source paths already collected
 * @returns {Set<string>}
 */
export function impliedTooling(dir, files) {
  /** @type {Set<string>} */
  const implied = new Set();

  /** Config basenames that do not match the package they belong to. */
  const ALIASES = new Map([
    ['tailwind', 'tailwindcss'],
    ['babel', '@babel/core'],
    ['commitlint', '@commitlint/cli'],
    ['release', 'semantic-release'],
  ]);

  /** @param {string} token */
  const add = (token) => {
    implied.add(token);
    const alias = ALIASES.get(token);
    if (alias) implied.add(alias);
  };

  /** @type {string[]} */
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return implied;
  }

  for (const name of entries) {
    const config = /^(.+)\.config\.[cm]?[jt]s$|^(.+)\.config\.(?:json|ya?ml)$/.exec(name);
    if (config) add(config[1] ?? config[2]);

    const rc = /^\.([a-z][a-z0-9-]*)rc(?:\.[a-z]+)?$/i.exec(name);
    if (rc) add(rc[1].toLowerCase());
  }

  // TypeScript is required by anything that compiles TypeScript, and is named by
  // none of it.
  const typed = entries.includes('tsconfig.json') || entries.includes('jsconfig.json')
    || files.some((file) => /\.[cm]?tsx?$/.test(file));
  if (typed) implied.add('typescript');

  return implied;
}

/** Config files that mean the output is a browser bundle, not a Node program. */
const BUNDLER_CONFIGS = /^(vite|next|webpack|rollup|parcel|esbuild|astro|nuxt|svelte|remix)\.config\./i;

/**
 * Whether this project builds for browsers.
 *
 * It matters because every version judgement shed makes is about Node, and a
 * browser bundle does not run on Node at all. `crypto.randomUUID` exists in
 * browsers but only in a secure context; `node:` builtins do not exist there
 * at all. shed cannot reason about that, so it says so rather than pretending
 * the Node floor is the whole story.
 *
 * @param {string} dir
 * @param {object} pkg
 * @returns {boolean}
 */
export function looksBrowserTargeted(dir, pkg) {
  if (pkg?.browserslist !== undefined || pkg?.browser !== undefined) return true;
  try {
    return readdirSync(dir, { withFileTypes: true })
      .some((entry) => entry.isFile() && BUNDLER_CONFIGS.test(entry.name));
  } catch {
    return false;
  }
}
