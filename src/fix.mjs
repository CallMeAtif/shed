/**
 * The only edit shed is willing to make to your project.
 *
 * `--fix` removes dependencies that nothing imports. It deliberately does not
 * rewrite source code: a codemod that turns `chalk.red(x)` into
 * `styleText('red', x)` is easy to write and easy to get wrong on the fifth
 * variation, and a tool that silently corrupts source is worse than no tool.
 * Deleting a manifest entry is mechanical, reversible with one `git checkout`,
 * and is where the real finding usually is anyway.
 *
 * Three guards stand between a finding and an edit:
 *
 *   1. only the `unreferenced` verdict qualifies - never `tooling`, and never one
 *      a permissive second-opinion scan disagreed about
 *   2. the whole scan must have accounted for every file. A parse error, a file
 *      skipped for size, or a JSX file whose text shed cannot tokenise all mean
 *      an import could be hiding where nobody looked - and an unexamined file is
 *      exactly as dangerous as an unparsed one
 *   3. the rewritten manifest is re-parsed and compared against the intended
 *      object before it is written, so a bad edit aborts instead of landing
 *
 * The text is edited line-wise rather than via JSON.stringify so that the
 * project keeps its own indentation, key order and trailing newline.
 */

/** @typedef {{ text: string, removed: string[], skipped: { name: string, reason: string }[] }} FixResult */

/**
 * Locate the line holding `"name":` inside the given top-level block.
 *
 * @param {string[]} lines
 * @param {string} field  e.g. 'dependencies'
 * @param {string} name
 * @returns {number} line index, or -1
 */
function findEntryLine(lines, field, name) {
  const blockStart = lines.findIndex((line) => new RegExp(`^\\s*"${field}"\\s*:\\s*\\{`).test(line));
  if (blockStart === -1) return -1;

  // Track brace depth so a nested object inside the block cannot end it early.
  let depth = 0;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entry = new RegExp(`^\\s*"${escaped}"\\s*:`);

  for (let i = blockStart; i < lines.length; i++) {
    for (const char of lines[i]) {
      if (char === '{') depth++;
      else if (char === '}') depth--;
    }
    if (i > blockStart && entry.test(lines[i])) return i;
    if (depth === 0 && i > blockStart) return -1; // block closed without a match
  }
  return -1;
}

/**
 * Remove entries from a manifest's text, preserving its formatting.
 *
 * @param {string} text the raw package.json
 * @param {{ name: string, field: string }[]} targets
 * @returns {FixResult}
 * @throws {Error} when the result would not be equivalent to the intended object
 */
export function removeDependencies(text, targets) {
  const original = JSON.parse(text);
  let lines = text.split('\n');
  /** @type {string[]} */
  const removed = [];
  /** @type {{ name: string, reason: string }[]} */
  const skipped = [];

  for (const { name, field } of targets) {
    const index = findEntryLine(lines, field, name);
    if (index === -1) {
      skipped.push({
        name,
        reason: `no line of its own in "${field}" - shed edits line-wise to preserve `
          + 'formatting, so a block written on a single line is left alone',
      });
      continue;
    }
    if (!/,\s*$/.test(lines[index])) {
      // Removing the last entry orphans the comma on the line before it.
      for (let i = index - 1; i >= 0; i--) {
        if (lines[i].trim() === '') continue;
        lines[i] = lines[i].replace(/,(\s*)$/, '$1');
        break;
      }
    }
    lines = [...lines.slice(0, index), ...lines.slice(index + 1)];
    removed.push(name);
  }

  let result = lines.join('\n');

  // An emptied block reads better collapsed than left as a two-line hole.
  result = result.replace(/("(?:dev|optional)?[dD]ependencies"\s*:\s*\{)\s*\n\s*(\})/g, '$1$2');

  // Guard 3: the edit is only allowed to have done exactly what was intended.
  const expected = structuredClone(original);
  for (const { name, field } of targets) {
    if (removed.includes(name)) delete expected[field]?.[name];
  }
  const actual = JSON.parse(result);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('refusing to write: the rewritten package.json is not what was intended');
  }

  return { text: result, removed, skipped };
}

/**
 * Decide which findings `--fix` is allowed to act on.
 *
 * @param {import('./analyze.mjs').Finding[]} findings
 * @param {number} parseErrors
 * @param {string[]} [blockers] other reasons the scan may be incomplete
 * @returns {{ targets: { name: string, field: string }[], refusal: string|null }}
 */
export function planFix(findings, parseErrors, blockers = []) {
  /** @type {string[]} */
  const reasons = [];
  if (parseErrors > 0) reasons.push(`${parseErrors} file(s) did not parse cleanly`);
  reasons.push(...blockers);

  if (reasons.length > 0) {
    return {
      targets: [],
      refusal:
        `refusing to edit: ${reasons.join('; ')}. An import hiding in a file shed did not ` +
        'fully read would make one of these packages referenced, so it will not guess. ' +
        'Run with --json to see the detail.',
    };
  }
  return {
    targets: findings
      .filter((f) => f.verdict === 'unreferenced' && !f.unconfirmed)
      .map((f) => ({ name: f.name, field: f.field })),
    refusal: null,
  };
}
