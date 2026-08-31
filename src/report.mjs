/**
 * Turning a report into something a person reads, and into something a machine
 * reads. Both come from the same analysis; neither is derived from the other's
 * text.
 */
import { VERDICT_ORDER, DEFAULT_VERDICTS, humanCount } from './analyze.mjs';
import { pad, stringWidth, truncate, wrap } from './render/width.mjs';

/** Section heading and accent colour for each verdict. */
const SECTIONS = {
  removable: { title: 'REMOVABLE', tone: 'boldGreen', lead: 'the standard library covers every use shed can see' },
  bump: { title: 'NEEDS A NODE BUMP', tone: 'boldYellow', lead: 'the replacement exists above this project\'s floor' },
  blocked: { title: 'BLOCKED', tone: 'boldRed', lead: 'the code uses something the replacement does not cover' },
  unreferenced: { title: 'UNREFERENCED', tone: 'dim', lead: 'declared, but nothing imports it' },
  tooling: { title: 'TOOLING', tone: 'dim', lead: 'never imported, but a package script runs it' },
  unknown: { title: 'NO MAPPING', tone: 'dim', lead: 'not in the knowledge base' },
};

/**
 * @param {object} report the result of analyze(), plus project metadata
 * @param {object} options
 * @param {ReturnType<import('./render/ansi.mjs').createPainter>} options.painter
 * @param {boolean} [options.all]
 * @param {boolean} [options.quiet]
 * @param {number} [options.width] terminal columns
 * @returns {string}
 */
export function renderText(report, { painter, all = false, quiet = false, width = 100 }) {
  const c = painter;
  const out = [];

  const name = report.project.name ?? '(unnamed project)';
  const floorNote = { flag: 'from --node', engines: 'from engines.node', runtime: 'assumed from the running Node' };
  out.push(
    `${c.bold('shed')} ${c.dim(report.version)}  ${c.dim('·')}  ${c.bold(name)}  ${c.dim('·')}  ` +
    `Node floor ${c.cyan(report.node.version)} ${c.dim(`(${floorNote[report.node.source]})`)}`,
  );
  out.push(c.dim(`scanned ${report.scanned} files, ${report.totals.declared} declared dependencies`));

  const visible = all ? new Set(VERDICT_ORDER) : DEFAULT_VERDICTS;

  if (!quiet) {
    for (const verdict of VERDICT_ORDER) {
      if (!visible.has(verdict)) continue;
      const group = report.findings.filter((f) => f.verdict === verdict);
      if (group.length === 0) continue;

      const section = SECTIONS[verdict];
      out.push('');
      out.push(`${c[section.tone](section.title)} ${c.dim(`(${group.length}) - ${section.lead}`)}`);
      for (const finding of group) out.push(...renderFinding(finding, c, width));
    }
  }

  out.push('');
  out.push(renderSummary(report, c));
  return out.join('\n');
}

/**
 * @param {import('./analyze.mjs').Finding} finding
 * @param {ReturnType<import('./render/ansi.mjs').createPainter>} c
 * @param {number} width
 */
function renderFinding(finding, c, width) {
  const lines = [];
  const reach = finding.entry?.weekly ? `${humanCount(finding.entry.weekly)}/wk` : '';
  const head =
    `  ${pad(c.bold(finding.name), 24 + (stringWidth(c.bold(finding.name)) - stringWidth(finding.name)))}` +
    `${pad(c.dim(reach), 12 + (stringWidth(c.dim(reach)) - stringWidth(reach)))}`;

  lines.push(finding.entry ? `${head}${c.cyan(finding.entry.api)}` : head.trimEnd());
  for (const line of wrap(finding.because, Math.max(40, width - 6))) {
    lines.push(`    ${c.dim(line)}`);
  }

  if (finding.caveats.length > 0) {
    for (const hit of finding.caveats.slice(0, 3)) {
      lines.push(`    ${c.yellow(`${hit.file}:${hit.line}`)} ${c.dim(truncate(hit.text, Math.max(30, width - 30)))}`);
    }
    if (finding.caveatCount > 3) lines.push(`    ${c.dim(`… and ${finding.caveatCount - 3} more`)}`);
  } else if (finding.sites.length > 0) {
    const shown = finding.sites.slice(0, 4).map((s) => `${s.file}:${s.line}`);
    const more = finding.siteCount > shown.length ? ` … +${finding.siteCount - shown.length}` : '';
    lines.push(`    ${c.dim(truncate(shown.join('  ') + more, Math.max(30, width - 6)))}`);
  }
  return lines;
}

/** @param {object} report */
function renderSummary(report, c) {
  const { byVerdict, weeklyRemovable } = report.totals;
  if (byVerdict.removable === 0) {
    const pending = byVerdict.bump + byVerdict.blocked;
    return pending > 0
      ? c.bold(`Nothing removable today. ${pending} would be, on a newer Node or without the blocked APIs.`)
      : c.boldGreen('Nothing removable. This project is already leaning on the standard library.');
  }
  const noun = byVerdict.removable === 1 ? 'dependency' : 'dependencies';
  return c.boldGreen(
    `${byVerdict.removable} ${noun} the standard library already replaces` +
    (weeklyRemovable > 0 ? `, worth ~${humanCount(weeklyRemovable)} weekly downloads.` : '.'),
  );
}

/**
 * The machine-readable report.
 *
 * Shape is stable and documented in the README: anything added later is
 * additive, so `shed --json | your-script` keeps working.
 *
 * @param {object} report
 */
export function toJSON(report) {
  return {
    shed: report.version,
    project: report.project,
    node: report.node,
    scanned: report.scanned,
    totals: report.totals,
    findings: report.findings.map((f) => ({
      name: f.name,
      range: f.range,
      field: f.field,
      verdict: f.verdict,
      because: f.because,
      replacement: f.entry
        ? { api: f.entry.api, since: f.entry.since, confidence: f.entry.confidence, weekly: f.entry.weekly }
        : null,
      sites: f.sites,
      siteCount: f.siteCount,
      caveats: f.caveats,
      caveatCount: f.caveatCount,
      scripts: f.scripts,
    })),
    errors: report.errors.map((e) => ({
      file: e.pos.file, line: e.pos.line, col: e.pos.col, message: e.message,
    })),
  };
}
