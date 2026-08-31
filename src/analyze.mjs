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
import { extractImports, packageNameFromSpecifier } from './scanner/imports.mjs';
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
 * This is a substring probe over the file's text, not a semantic analysis: it can
 * fire on a caveat mentioned inside a comment. That bias is deliberate - a false
 * "blocked" merely leaves a dependency in place, while a false "removable" breaks
 * someone's build.
 *
 * @param {string} text
 * @param {string} file
 * @param {string[]} caveats
 * @returns {CaveatHit[]}
 */
function probeCaveats(text, file, caveats) {
  /** @type {CaveatHit[]} */
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const caveat of caveats) {
      const col = lines[i].indexOf(caveat);
      if (col === -1) continue;
      hits.push({ file, line: i + 1, col: col + 1, caveat, text: lines[i].trim() });
    }
  }
  return hits;
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
  const pattern = new RegExp(`(^|[\\s"'=/])${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}([\\s"'/]|$)`);
  return Object.entries(scripts)
    .filter(([, command]) => typeof command === 'string' && pattern.test(command))
    .map(([script]) => script);
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
 */

/**
 * @param {object} options
 * @param {string} options.dir
 * @param {object} options.pkg
 * @param {string[]} options.files repository-relative source paths
 * @param {{ version: string, source: string }} options.floor
 * @param {Set<string>} [options.ignore] package names to leave out entirely
 * @returns {{ findings: Finding[], errors: import('./errors.mjs').Diagnostic[], scanned: number, totals: object }}
 */
export function analyze({ dir, pkg, files, floor, ignore = new Set() }) {
  const declared = declaredDependencies(pkg);

  /** @type {Map<string, Site[]>} */
  const sites = new Map();
  /** @type {Map<string, CaveatHit[]>} */
  const caveatHits = new Map();
  /** @type {import('./errors.mjs').Diagnostic[]} */
  const errors = [];
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
      const hits = probeCaveats(text, file, entry.caveats);
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

    /** @type {Verdict} */
    let verdict;
    let because;

    if (found.length === 0 && scripts.length > 0) {
      verdict = 'tooling';
      because = `nothing imports it, but ${scripts.map((s) => `scripts.${s}`).join(' and ')} runs it`;
    } else if (found.length === 0) {
      verdict = 'unreferenced';
      because = entry
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
