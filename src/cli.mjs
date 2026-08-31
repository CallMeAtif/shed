/**
 * Argument parsing, without minimist or commander.
 *
 * `util.parseArgs` (v18.3) does tokenisation and nothing else - it is explicitly
 * documented as deliberately minimal. Everything a CLI package actually sells on
 * top of that lives here: subcommands, enum validation, generated help that
 * cannot drift from the option table, and usage errors that name the offending
 * flag. Negation is the one thing parseArgs grew on its own (allowNegative,
 * v22.4.0), so the shim this file used to carry has been deleted.
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
    help: 'Remove dependencies nothing imports from package.json',
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
  all: {
    type: 'boolean',
    short: 'a',
    default: false,
    placeholder: '',
    help: 'Also report unreferenced packages and ones with no known mapping',
  },
  color: {
    type: 'boolean',
    negatable: true,
    placeholder: '',
    help: 'Force colour on or off; otherwise NO_COLOR, FORCE_COLOR, then TTY decide',
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
    if (spec.default !== undefined) config[name].default = spec.default;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: config,
      allowPositionals: true,
      strict: true,
      // Turns `--no-color` into color: false, with last-flag-wins semantics.
      // Added in v22.4.0; this repository once shimmed it by hand and no longer
      // needs to, which is the whole point of the exercise.
      allowNegative: true,
    });
  } catch (err) {
    throw new UsageError(/** @type {Error} */ (err).message);
  }

  const flags = { ...parsed.values };
  for (const [name, spec] of Object.entries(OPTIONS)) {
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
