/**
 * Command dispatch and exit codes.
 *
 * Kept apart from `cli.mjs` (which only parses) so that argument handling can be
 * tested without touching a filesystem, and from the commands themselves so that
 * each one is a plain function of its inputs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Diagnostic, UsageError } from './errors.mjs';
import { parse, helpText } from './cli.mjs';
import { colorEnabled, createPainter } from './render/ansi.mjs';
import { analyze, humanCount, VERDICT_ORDER } from './analyze.mjs';
import { renderText, toJSON } from './report.mjs';
import { loadManifest, resolveNodeFloor, walkSource, loadIgnore } from './project.mjs';
import { Ignore } from './gitignore.mjs';
import { ENTRIES, lookup } from './knowledge.mjs';
import { planFix, removeDependencies } from './fix.mjs';

/**
 * Replaced with a literal by tools/bundle.mjs, so the built artifact carries its
 * own version instead of reading a manifest that may not travel with it.
 */
const BAKED_VERSION = '0.0.0-dev';

/** @returns {string} */
function resolveVersion() {
  if (BAKED_VERSION !== '0.0.0-dev') return BAKED_VERSION;
  try {
    return JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

export const VERSION = resolveVersion();

/** @typedef {{ stdout: (s: string) => void, stderr: (s: string) => void, columns: number }} Io */

/**
 * @param {string[]} argv
 * @param {Io} io
 * @returns {number} process exit code
 */
export function main(argv, io) {
  let parsed;
  try {
    parsed = parse(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`shed: ${err.message}\n\nRun \`shed --help\` for usage.`);
      return 2;
    }
    throw err;
  }

  const { command, positionals, flags } = parsed;
  const painter = createPainter(flags.color ?? colorEnabled({ isTTY: io.columns > 0 }));

  if (flags.help || command === 'help') {
    io.stdout(helpText(VERSION));
    return 0;
  }
  if (flags.version) {
    io.stdout(VERSION);
    return 0;
  }

  try {
    switch (command) {
      case 'list':
        return runList(painter, io, flags);
      case 'why':
        return runWhy(positionals, painter, io, flags);
      default:
        return runScan(positionals, painter, io, flags);
    }
  } catch (err) {
    if (err instanceof Diagnostic) {
      io.stderr(`shed: ${err.format()}`);
      return 2;
    }
    if (err instanceof UsageError) {
      io.stderr(`shed: ${err.message}`);
      return 2;
    }
    throw err;
  }
}

/**
 * Run the audit.
 * @returns {number} 1 when anything is removable, so CI can gate on it
 */
function runScan(positionals, painter, io, flags) {
  const dir = resolve(positionals[0] ?? '.');
  const { pkg, path: manifestPath } = loadManifest(dir);
  const ignore = new Set(flags.ignore ?? []);
  const walk = walkSource(dir, loadIgnore(dir, Ignore));
  const floor = resolveNodeFloor(pkg, flags.node);

  const analysis = analyze({ dir, pkg, files: walk.files, floor, ignore });
  const report = {
    version: VERSION,
    project: { dir, name: pkg.name ?? null, version: pkg.version ?? null },
    node: floor,
    ...analysis,
  };

  if (flags.fix) return applyFix(report, manifestPath, painter, io);

  if (flags.json) {
    io.stdout(JSON.stringify(toJSON(report), null, 2));
  } else {
    io.stdout(renderText(report, {
      painter, all: flags.all, quiet: flags.quiet, width: io.columns || 100,
    }));
    if (analysis.errors.length > 0 && !flags.quiet) {
      io.stderr(`\n${painter.dim(`${analysis.errors.length} file(s) could not be fully parsed; run with --json to see them.`)}`);
    }
  }

  return analysis.totals.byVerdict.removable > 0 ? 1 : 0;
}

/**
 * Remove dependencies nothing imports, then report exactly what changed.
 * @returns {number} 0 on success or a clean no-op, 2 when shed refuses to edit
 */
function applyFix(report, manifestPath, painter, io) {
  const c = painter;
  const { targets, refusal } = planFix(report.findings, report.errors.length);

  if (refusal) {
    io.stderr(`shed: ${refusal}`);
    return 2;
  }
  if (targets.length === 0) {
    io.stdout('Nothing to remove: every declared dependency is imported somewhere, or is run by a script.');
    return 0;
  }

  let result;
  try {
    result = removeDependencies(readFileSync(manifestPath, 'utf8'), targets);
  } catch (err) {
    io.stderr(`shed: ${/** @type {Error} */ (err).message}`);
    return 2;
  }

  writeFileSync(manifestPath, result.text);

  const lines = [c.boldGreen(`Removed ${result.removed.length} unreferenced dependencies from package.json:`)];
  for (const name of result.removed) lines.push(`  - ${name}`);
  for (const { name, reason } of result.skipped) lines.push(`  ${c.yellow('!')} ${name}: ${reason}`);
  lines.push('', c.dim('Nothing else was touched. Run your tests, then delete the lockfile entries with your package manager.'));
  io.stdout(lines.join('\n'));
  return 0;
}

/** Explain one package in full, whether or not the project uses it. */
function runWhy(positionals, painter, io, flags) {
  const [name, where] = positionals;
  if (!name) throw new UsageError('why needs a package name, e.g. `shed why chalk`');

  const entry = lookup(name);
  const c = painter;
  if (!entry) {
    io.stdout(`${c.bold(name)} is not in shed's knowledge base, so shed has no opinion on it.`);
    return 0;
  }

  const lines = [
    `${c.bold(entry.pkg)}  ${c.dim(entry.weekly ? `${humanCount(entry.weekly)} weekly downloads` : '')}`,
    '',
    `  ${c.dim('replace with')}  ${c.cyan(entry.api)}`,
    `  ${c.dim('available in')}  Node ${entry.since}`,
    `  ${c.dim('confidence  ')}  ${entry.confidence}`,
    '',
    `  ${entry.rationale}`,
  ];
  if (entry.caveats?.length) {
    lines.push('', `  ${c.yellow('shed will not call this removable if it sees:')}`);
    for (const caveat of entry.caveats) lines.push(`    ${caveat}`);
  }
  if (entry.docs) lines.push('', `  ${c.dim(`https://nodejs.org/api/${entry.docs}`)}`);

  // When pointed at a project, add what shed actually found there.
  const dir = resolve(where ?? '.');
  try {
    const { pkg } = loadManifest(dir);
    const walk = walkSource(dir, loadIgnore(dir, Ignore));
    const floor = resolveNodeFloor(pkg, flags.node);
    const { findings } = analyze({ dir, pkg, files: walk.files, floor });
    const finding = findings.find((f) => f.name === name);
    lines.push('');
    if (!finding) {
      lines.push(`  ${c.dim(`${pkg.name ?? dir} does not declare ${name}.`)}`);
    } else {
      lines.push(`  ${c.dim('in this project:')} ${c.bold(finding.verdict)} - ${finding.because}`);
      for (const site of finding.sites) lines.push(`    ${site.file}:${site.line}:${site.col}`);
    }
  } catch {
    // `shed why chalk` from outside a project is a legitimate way to use it.
  }

  io.stdout(lines.join('\n'));
  return 0;
}

/** Print the knowledge base so a user can audit shed's opinions. */
function runList(painter, io, flags) {
  if (flags.json) {
    io.stdout(JSON.stringify(ENTRIES, null, 2));
    return 0;
  }
  const c = painter;
  const rows = [...ENTRIES].sort((a, b) => (b.weekly ?? 0) - (a.weekly ?? 0));
  const lines = [c.dim(`${rows.length} mappings, ordered by weekly downloads`), ''];
  for (const entry of rows) {
    lines.push(
      `  ${c.bold(entry.pkg.padEnd(18))} ${c.dim((entry.weekly ? `${humanCount(entry.weekly)}/wk` : '').padStart(9))}  ` +
      `${c.cyan(entry.api)} ${c.dim(`(Node ${entry.since}, ${entry.confidence})`)}`,
    );
  }
  io.stdout(lines.join('\n'));
  return 0;
}

export { VERDICT_ORDER };
