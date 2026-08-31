/**
 * Turning a manifest plus a source tree into verdicts.
 *
 * The rule shed follows is that a recommendation must be defensible: it names the
 * replacement API, the Node version that API landed in, and every line that would
 * have to change. Anything it cannot prove is reported as unknown rather than
 * guessed at, because one wrong "you can delete this" costs more trust than ten
 * correct ones earn.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractImports, packageNameFromSpecifier, looseReferences } from './scanner/imports.mjs';
import { declaredDependencies } from './project.mjs';
import { lookup } from './knowledge.mjs';
import { gte } from './semver.mjs';

/**
 * @typedef {'removable'|'bump'|'blocked'|'unreferenced'|'unknown'} Verdict
 *
 * removable    - the stdlib covers every use shed can see, on this Node floor
 * bump         - the replacement exists but above the project's declared floor
 * blocked      - the code uses something the stdlib replacement does not cover
 * unreferenced - declared but never imported anywhere shed looked
 * tooling      - never imported, but a package script invokes it by name
 * unknown      - no mapping in the knowledge base; shed has no opinion
 */

/** Report order: most actionable first. */
export const VERDICT_ORDER = ['removable', 'bump', 'blocked', 'unreferenced', 'tooling', 'unknown'];

/** Verdicts shown without --all. */
export const DEFAULT_VERDICTS = new Set(['removable', 'bump', 'blocked']);

/** @typedef {{ file: string, line: number, col: number, kind: string, specifier: string }} Site */
/** @typedef {{ file: string, line: number, col: number, caveat: string, text: string }} CaveatHit */

/** At most this many evidence lines are kept per package; the rest are counted. */
const MAX_EVIDENCE = 8;

/**
 * Find uses of API surface the stdlib replacement does not cover.
 *
 * Still a substring probe rather than a semantic analysis, but comments are
 * blanked first using the ranges the tokenizer already computed - citing a
 * mention in prose as proof of API usage was the weakest evidence shed printed.
 * The remaining bias is deliberate: a false "blocked" merely leaves a dependency
 * in place, while a false "removable" breaks someone's build.
 *
 * @param {string} text
 * @param {string} file
 * @param {string[]} caveats
 * @param {[number, number][]} comments half-open offset ranges to ignore
 * @returns {CaveatHit[]}
 */
function probeCaveats(text, file, caveats, comments) {
  // In a JSX file the tokenizer's comment ranges are not trustworthy: a URL in
  // JSX text ("see http://x.com") reads as a line comment and blanks the rest of
  // the line, which hid a real caveat and produced a false "removable". Matching
  // the raw text there is the conservative direction.
  const trustComments = !/\.[jt]sx$/.test(file);
  // Replacing comment bytes with spaces keeps every offset, line and column
  // identical, so positions stay truthful without a second pass.
  let code = text;
  if (trustComments) {
    for (const [start, end] of comments) {
      code = code.slice(0, start) + ' '.repeat(end - start) + code.slice(end);
    }
  }

  /** @type {CaveatHit[]} */
  const hits = [];
  /** @type {Set<number>} */
  const seenLines = new Set();
  const lines = code.split(/\r?\n/);
  const original = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    for (const caveat of caveats) {
      const col = lines[i].indexOf(caveat);
      if (col === -1) continue;
      // One line is one piece of evidence, however many caveats it contains.
      if (seenLines.has(i)) continue;
      seenLines.add(i);
      hits.push({ file, line: i + 1, col: col + 1, caveat, text: original[i].trim() });
    }
  }
  return hits;
}

/**
 * Escape a package name for use inside a regular expression.
 *
 * Written once because it was written twice, and one of the two copies had a
 * character class that closed early - so `socket.io` matched `socketxio`.
 *
 * @param {string} name
 */
function escapeForRegExp(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Package scripts that invoke a dependency by name.
 *
 * Without this, every CLI-shaped dev dependency - nodemon, typescript, eslint -
 * looks unreferenced, because nothing imports it. Recommending their removal
 * would break the project, which is the classic false positive of this genre of
 * tool. Matching is on a word boundary so `ts-node` does not match `ts-node-dev`.
 *
 * @param {object} pkg
 * @param {string} name
 * @returns {string[]} the script names that mention it
 */
function scriptsUsing(pkg, name) {
  const scripts = pkg?.scripts;
  if (!scripts || typeof scripts !== 'object') return [];
  const pattern = new RegExp(`(^|[\\s"'=/])${escapeForRegExp(name)}([\\s"'/]|$)`);
  return Object.entries(scripts)
    .filter(([, command]) => typeof command === 'string' && pattern.test(command))
    .map(([script]) => script);
}

/**
 * Packages whose name alone says they are never imported.
 *
 * A type package is resolved by the TypeScript compiler, and an eslint config or
 * a babel preset is named as a bare string inside a config that may not even be
 * JavaScript. Nothing imports any of them, so an import-based scan calls them
 * dead - and deleting @types/node is a bad afternoon.
 */
const TOOLING_BY_NAME = [
  /^@types\//,
  /^eslint-(config|plugin)-/,
  /^@[^/]+\/eslint-(config|plugin)/,
  /^babel-(plugin|preset)-/,
  /^@babel\/(plugin|preset)-/,
  /^stylelint-config-/,
  /^prettier-plugin-/,
  /^@commitlint\/config/,
  /^semantic-release-/,
];

/**
 * Whether a package is named somewhere that is not an import.
 *
 * @param {string} configText
 * @param {string} name
 * @returns {boolean}
 */
function namedInConfig(configText, name) {
  if (!configText) return false;
  return new RegExp(`(^|["'\\s:/=])${escapeForRegExp(name)}(["'\\s,:/]|$)`).test(configText);
}

/**
 * @typedef {object} Finding
 * @property {string} name
 * @property {string} range        the version range the manifest declares
 * @property {string} field        which dependency block it came from
 * @property {Verdict} verdict
 * @property {import('./knowledge.mjs').Entry|null} entry
 * @property {Site[]} sites        import sites, capped
 * @property {number} siteCount    total import sites before capping
 * @property {CaveatHit[]} caveats capped
 * @property {number} caveatCount
 * @property {string} because      one line explaining this verdict
 * @property {string[]} scripts    package scripts that invoke it by name
 * @property {boolean} unconfirmed a loose scan or a string literal named it where no import did
 */

/**
 * @param {object} options
 * @param {string} options.dir
 * @param {object} options.pkg
 * @param {string[]} options.files repository-relative source paths
 * @param {{ version: string, source: string }} options.floor
 * @param {Set<string>} [options.ignore] package names to leave out entirely
 * @param {string} [options.configText] text where a package may be named without being imported
 * @param {Set<string>} [options.peers] names required as a peer, or implied by the project's shape
 * @returns {{ findings: Finding[], errors: import('./errors.mjs').Diagnostic[], scanned: number, totals: object }}
 */
export function analyze({ dir, pkg, files, floor, ignore = new Set(), configText = '', peers = new Set() }) {
  const declared = declaredDependencies(pkg);

  /** @type {Map<string, Site[]>} */
  const sites = new Map();
  /** @type {Map<string, CaveatHit[]>} */
  const caveatHits = new Map();
  /** @type {import('./errors.mjs').Diagnostic[]} */
  const errors = [];
  /** Names a permissive scan saw, whether or not the strict one confirmed them. */
  /** @type {Set<string>} */
  const loose = new Set();
  /** Every string literal in the source, for packages named rather than imported. */
  /** @type {Set<string>} */
  const literals = new Set();
  let scanned = 0;

  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(dir, file), 'utf8');
    } catch {
      continue; // walkSource already recorded unreadable paths
    }
    scanned++;

    const found = extractImports(text, file);
    errors.push(...found.errors);
    for (const name of looseReferences(text)) loose.add(name);
    for (const literal of found.strings) literals.add(literal);

    /** @type {Set<string>} */
    const inThisFile = new Set();
    for (const imp of found.imports) {
      const name = packageNameFromSpecifier(imp.specifier);
      if (!name || ignore.has(name)) continue;
      inThisFile.add(name);
      if (!sites.has(name)) sites.set(name, []);
      sites.get(name).push({
        file, line: imp.line, col: imp.col, kind: imp.kind, specifier: imp.specifier,
      });
    }

    // Probing costs a pass over the file, so only do it for packages this file
    // actually imports and that have caveats worth probing for.
    for (const name of inThisFile) {
      const entry = lookup(name);
      if (!entry?.caveats?.length) continue;
      const hits = probeCaveats(text, file, entry.caveats, found.comments);
      if (!hits.length) continue;
      if (!caveatHits.has(name)) caveatHits.set(name, []);
      caveatHits.get(name).push(...hits);
    }
  }

  /** @type {Finding[]} */
  const findings = [];
  for (const [name, { range, field }] of declared) {
    if (ignore.has(name)) continue;

    const entry = lookup(name) ?? null;
    const found = sites.get(name) ?? [];
    const hits = caveatHits.get(name) ?? [];

    const scripts = scriptsUsing(pkg, name);
    const byName = TOOLING_BY_NAME.some((pattern) => pattern.test(name));
    const inConfig = namedInConfig(configText, name);
    const isPeer = peers.has(name);

    /** @type {Verdict} */
    let verdict;
    let because;

    if (found.length === 0 && (scripts.length > 0 || byName || inConfig || isPeer)) {
      verdict = 'tooling';
      if (scripts.length > 0) {
        because = `nothing imports it, but ${scripts.map((s) => `scripts.${s}`).join(' and ')} runs it`;
      } else if (isPeer) {
        because = 'nothing imports it, but the project requires it as a peer or a toolchain';
      } else if (byName) {
        because = 'nothing imports it, and nothing should - this kind of package is resolved by name';
      } else {
        because = 'nothing imports it, but it is named in a config file';
      }
    } else if (found.length === 0) {
      verdict = 'unreferenced';
      because = literals.has(name)
        ? 'nothing imports it, but its name appears as a string in the source - it may be loaded by name at runtime'
        : loose.has(name)
        ? 'no import shed can confirm, but a permissive scan saw the name - too close to call, so --fix will not touch it'
        : entry
          ? 'nothing imports it; if that is right, deleting it needs no replacement at all'
          : 'nothing imports it in the files shed scanned';
    } else if (!entry) {
      verdict = 'unknown';
      because = 'not in the knowledge base - shed has no opinion either way';
    } else if (hits.length > 0) {
      verdict = 'blocked';
      const names = [...new Set(hits.map((h) => h.caveat))].join(', ');
      because = `${entry.api} does not cover ${names}`;
    } else if (!gte(floor.version, entry.since)) {
      verdict = 'bump';
      because = `${entry.api} needs Node ${entry.since}; this project's floor is ${floor.version}`;
    } else {
      verdict = 'removable';
      because = entry.rationale;
    }

    findings.push({
      name,
      range,
      field,
      verdict,
      entry,
      sites: found.slice(0, MAX_EVIDENCE),
      siteCount: found.length,
      caveats: hits.slice(0, MAX_EVIDENCE),
      caveatCount: hits.length,
      because,
      scripts,
      // A permissive scan disagreeing with the strict one is enough to block a
      // deletion, though not enough to claim the package is used.
      unconfirmed: found.length === 0 && (loose.has(name) || literals.has(name)),
    });
  }

  // Most actionable first, then by reach, then alphabetically so runs are stable.
  findings.sort((a, b) => {
    const byVerdict = VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict);
    if (byVerdict !== 0) return byVerdict;
    const byReach = (b.entry?.weekly ?? 0) - (a.entry?.weekly ?? 0);
    if (byReach !== 0) return byReach;
    return a.name < b.name ? -1 : 1;
  });

  return { findings, errors, scanned, totals: summarise(findings, declared.size) };
}

/**
 * @param {Finding[]} findings
 * @param {number} declaredCount
 */
function summarise(findings, declaredCount) {
  /** @type {Record<string, number>} */
  const byVerdict = Object.fromEntries(VERDICT_ORDER.map((v) => [v, 0]));
  let weeklyRemovable = 0;
  for (const finding of findings) {
    byVerdict[finding.verdict]++;
    if (finding.verdict === 'removable') weeklyRemovable += finding.entry?.weekly ?? 0;
  }
  return { declared: declaredCount, byVerdict, weeklyRemovable };
}

/**
 * Format a download count the way a person would say it out loud.
 * @param {number} n
 */
export function humanCount(n) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
