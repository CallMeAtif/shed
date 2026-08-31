/**
 * Argument parsing, without minimist or commander.
 *
 * `util.parseArgs` (v18.3) does tokenisation and nothing else - it is explicitly
 * documented as deliberately minimal. Everything a CLI package actually sells on
 * top of that lives here: subcommands, `--no-` negation, enum and integer
 * coercion, generated help that cannot drift from the option table, and usage
 * errors that name the offending flag.
 */
import { parseArgs } from 'node:util';
import { UsageError } from './errors.mjs';

/**
 * @typedef {object} OptionSpec
 * @property {'boolean'|'string'} type
 * @property {string} [short]
 * @property {boolean} [multiple]
 * @property {unknown} [default]
 * @property {string} placeholder  value name shown in help, e.g. `<version>`
 * @property {string} help
 * @property {boolean} [negatable]  also accept `--no-<name>`
 * @property {string[]} [choices]   restrict to an enum, validated after parsing
 */

/** @type {Record<string, OptionSpec>} */
export const OPTIONS = {
  json: {
    type: 'boolean',
    default: false,
    placeholder: '',
    help: 'Emit the machine-readable report instead of a table',
  },
  fix: {
    type: 'boolean',
    default: false,
    placeholder: '',
    help: 'Rewrite source for the mechanically safe swaps only',
  },
  node: {
    type: 'string',
    placeholder: '<version>',
    help: 'Node version to judge against (default: engines.node, else the running version)',
  },
  ignore: {
    type: 'string',
    multiple: true,
    placeholder: '<pkg>',
    help: 'Exclude a package from the report (repeatable)',
  },
  'min-severity': {
    type: 'string',
    default: 'removable',
    choices: ['removable', 'bump', 'blocked', 'unknown'],
    placeholder: '<level>',
    help: 'Lowest verdict to report: removable, bump, blocked, unknown',
  },
  color: {
    type: 'boolean',
    negatable: true,
    placeholder: '',
    help: 'Force colour on or off (default: auto-detect, honours NO_COLOR)',
  },
  quiet: {
    type: 'boolean',
    short: 'q',
    default: false,
    placeholder: '',
    help: 'Print only the summary line',
  },
  help: { type: 'boolean', short: 'h', default: false, placeholder: '', help: 'Show this help' },
  version: { type: 'boolean', short: 'v', default: false, placeholder: '', help: 'Show the version' },
};

/** @type {Record<string, { args: string, help: string }>} */
export const COMMANDS = {
  scan: { args: '[dir]', help: 'Audit a project for dependencies the stdlib already replaced' },
  why: { args: '<pkg> [dir]', help: 'Explain the verdict for a single package in full' },
  list: { args: '', help: 'Print the whole package-to-stdlib knowledge base' },
};

const DEFAULT_COMMAND = 'scan';

/**
 * Expand `--no-<flag>` into `--<flag>=false` before parseArgs sees it.
 *
 * parseArgs has no notion of negation, so a bare `--no-color` would be parsed as
 * an unknown option. Rewriting is cheaper than post-processing because it keeps
 * last-flag-wins semantics for `--color --no-color`.
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
function expandNegations(argv) {
  const negatable = new Set(
    Object.entries(OPTIONS).filter(([, s]) => s.negatable).map(([name]) => name),
  );
  return argv.map((arg) => {
    if (!arg.startsWith('--no-')) return arg;
    const name = arg.slice(5);
    return negatable.has(name) ? `--${name}=false` : arg;
  });
}

/**
 * parseArgs types every `type: 'boolean'` value as true regardless of `=false`,
 * so negated flags come back as strings that need folding.
 * @param {unknown} value
 */
function asBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === 'false') return false;
  return Boolean(value);
}

/**
 * @param {string[]} argv arguments after the node binary and script path
 * @returns {{ command: string, positionals: string[], flags: Record<string, unknown> }}
 */
export function parse(argv) {
  /** @type {Record<string, import('node:util').ParseArgsOptionConfig>} */
  const config = {};
  for (const [name, spec] of Object.entries(OPTIONS)) {
    config[name] = { type: spec.type };
    if (spec.short) config[name].short = spec.short;
    if (spec.multiple) config[name].multiple = true;
    if (spec.default !== undefined && !spec.negatable) config[name].default = spec.default;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: expandNegations(argv),
      options: config,
      allowPositionals: true,
      // `--color=false` is a string on a boolean option; tolerate it here and fold below.
      strict: true,
      allowNegative: false,
    });
  } catch (err) {
    throw new UsageError(/** @type {Error} */ (err).message);
  }

  const flags = { ...parsed.values };
  for (const [name, spec] of Object.entries(OPTIONS)) {
    if (spec.type === 'boolean' && name in flags) flags[name] = asBoolean(flags[name]);
    if (spec.choices && flags[name] !== undefined && !spec.choices.includes(String(flags[name]))) {
      throw new UsageError(
        `--${name} must be one of ${spec.choices.join(', ')}, got ${JSON.stringify(flags[name])}`,
      );
    }
  }

  const positionals = [...parsed.positionals];
  const command = positionals[0] in COMMANDS ? positionals.shift() : DEFAULT_COMMAND;
  return { command, positionals, flags };
}

/** Render `--flag <value>  description`, aligned, from the option table. */
function renderOptions() {
  const rows = Object.entries(OPTIONS).map(([name, spec]) => {
    const short = spec.short ? `-${spec.short}, ` : '    ';
    const negatable = spec.negatable ? `--[no-]${name}` : `--${name}`;
    return [`  ${short}${negatable} ${spec.placeholder}`.trimEnd(), spec.help];
  });
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `${left.padEnd(width)}  ${right}`).join('\n');
}

function renderCommands() {
  const rows = Object.entries(COMMANDS).map(([name, spec]) => [
    `  ${name} ${spec.args}`.trimEnd(),
    spec.help,
  ]);
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `${left.padEnd(width)}  ${right}`).join('\n');
}

/** @param {string} version */
export function helpText(version) {
  return `shed ${version} - find the dependencies your standard library already replaced

USAGE
  shed [command] [options] [dir]

COMMANDS
${renderCommands()}

  scan is the default, so \`shed .\` and \`shed scan .\` are the same thing.

OPTIONS
${renderOptions()}

EXIT CODES
  0  no removable dependencies found
  1  removable dependencies found (use this as a CI gate)
  2  usage error

shed makes no network requests and spawns no processes. Everything it reports
comes from files already on disk.`;
}
