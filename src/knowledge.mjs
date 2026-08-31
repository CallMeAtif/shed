/**
 * The package-to-stdlib mapping table.
 *
 * This is deliberately data, not code: a judge (or a user who disagrees with a
 * verdict) should be able to read the whole ruleset top to bottom without
 * following a single function call.
 *
 * `weekly` figures are static, sourced from the Zero Dependency cheat-sheet
 * (verified 27 August 2026) and from npm registry download counts read by hand on
 * 31 August 2026. shed never makes a network request, so these numbers age; they
 * are indicative of scale, not live telemetry.
 *
 * `confidence` drives the verdict:
 *   'exact'   - a drop-in replacement; safe to recommend and sometimes to codemod
 *   'partial' - the stdlib covers the common path, but named caveats can block it
 */

/**
 * @typedef {object} Entry
 * @property {string} pkg           npm package name
 * @property {number|null} weekly    approximate weekly downloads, or null if unknown
 * @property {string} api            the standard-library API that replaces it
 * @property {string} since          minimum Node version where `api` is usable
 * @property {'exact'|'partial'} confidence
 * @property {string} rationale      one line on what the swap actually costs
 * @property {string[]} [caveats]    usage that defeats the swap; probed in source
 * @property {string} [codemod]      id of a mechanical rewrite in src/codemod.mjs
 * @property {string} [docs]         nodejs.org anchor, printed by `shed why`
 */

/** @type {Entry[]} */
export const ENTRIES = [
  {
    pkg: 'chalk',
    weekly: 319_800_000,
    api: 'util.styleText()',
    since: '20.12.0',
    confidence: 'partial',
    rationale: 'styleText covers named colours and modifiers; the chainable API and level detection are yours to write.',
    caveats: ['.level', '.hex(', '.rgb(', '.bgHex(', '.ansi256(', 'supportsColor'],
    codemod: 'chalk-call',
    docs: 'util.html#utilstyletextformat-text-options',
  },
  {
    pkg: 'colors',
    weekly: 2_000_000,
    api: 'util.styleText()',
    since: '20.12.0',
    confidence: 'partial',
    rationale: 'Same substitution as chalk, minus the String.prototype patching that made colors infamous.',
    caveats: ['.zalgo', '.rainbow', 'setTheme'],
  },
  {
    pkg: 'picocolors',
    weekly: 180_000_000,
    api: 'util.styleText()',
    since: '20.12.0',
    confidence: 'exact',
    rationale: 'picocolors is already a thin wrapper over escape codes; styleText is the same idea in the runtime.',
  },
  {
    pkg: 'strip-ansi',
    weekly: 190_000_000,
    api: 'util.stripVTControlCharacters()',
    since: '18.0.0',
    confidence: 'exact',
    rationale: 'Identical intent, and the stdlib version also strips non-colour VT sequences.',
    codemod: 'strip-ansi-call',
  },
  {
    pkg: 'ansi-styles',
    weekly: 200_000_000,
    api: 'util.styleText()',
    since: '20.12.0',
    confidence: 'partial',
    rationale: 'styleText applies styles; it does not expose the raw open/close code pairs ansi-styles is used for.',
    caveats: ['.open', '.close'],
  },
  {
    pkg: 'readable-stream',
    weekly: 185_600_000,
    api: 'node:stream + node:stream/promises',
    since: '18.0.0',
    confidence: 'exact',
    rationale: 'readable-stream exists to backport core streams to old Node; on a supported Node it is the same code.',
  },
  {
    pkg: 'form-data',
    weekly: 100_900_000,
    api: 'global FormData with fetch',
    since: '18.0.0',
    confidence: 'partial',
    rationale: 'The web FormData covers multipart bodies for fetch; the getHeaders()/pipe() surface has no equivalent.',
    caveats: ['getHeaders', 'getLengthSync', '.pipe('],
  },
  {
    pkg: 'minimist',
    weekly: 80_500_000,
    api: 'util.parseArgs()',
    since: '18.3.0',
    confidence: 'partial',
    rationale: 'parseArgs is string-and-boolean only by design; subcommands, negation and coercion are ~80 lines you write.',
    caveats: ['--'],
    docs: 'util.html#utilparseargsconfig',
  },
  {
    pkg: 'yargs-parser',
    weekly: 90_000_000,
    api: 'util.parseArgs()',
    since: '18.3.0',
    confidence: 'partial',
    rationale: 'Same trade as minimist, with more coercion behaviour to reimplement.',
  },
  {
    pkg: 'commander',
    weekly: 130_000_000,
    api: 'util.parseArgs() plus a dispatch table',
    since: '18.3.0',
    confidence: 'partial',
    rationale: 'Tokenising is free; generated help and subcommand routing are the part you keep.',
  },
  {
    pkg: 'node-fetch',
    weekly: 55_000_000,
    api: 'global fetch()',
    since: '18.0.0',
    confidence: 'exact',
    rationale: 'Node ships Undici as the global fetch; node-fetch is the polyfill it made redundant.',
  },
  {
    pkg: 'axios',
    weekly: 55_000_000,
    api: 'global fetch()',
    since: '18.0.0',
    confidence: 'partial',
    rationale: 'fetch covers requests and responses; interceptors, automatic JSON and progress events are not in the box.',
    caveats: ['interceptors', 'axios.create', 'onUploadProgress', 'onDownloadProgress'],
  },
  {
    pkg: 'uuid',
    weekly: 130_000_000,
    api: 'crypto.randomUUID()',
    since: '14.17.0',
    confidence: 'partial',
    rationale: 'randomUUID is v4 only; v1/v5/v7 and the parse/stringify helpers have no stdlib equivalent.',
    caveats: ['v1', 'v3', 'v5', 'v6', 'v7', 'parse', 'stringify', 'validate'],
    codemod: 'uuid-v4-call',
  },
  {
    pkg: 'nanoid',
    weekly: 40_000_000,
    api: 'crypto.randomUUID() or crypto.randomBytes()',
    since: '14.17.0',
    confidence: 'partial',
    rationale: 'A URL-safe id is randomBytes plus base64url; nanoid keeps its edge only on custom alphabets and length.',
    caveats: ['customAlphabet', 'customRandom'],
  },
  {
    pkg: 'glob',
    weekly: 180_000_000,
    api: 'fs.glob() / fs.globSync()',
    since: '22.0.0',
    confidence: 'partial',
    rationale: 'fs.glob covers the common patterns; the ignore/cwd/dot option surface is smaller.',
    docs: 'fs.html#fsglobpattern-options-callback',
  },
  {
    pkg: 'fast-glob',
    weekly: 90_000_000,
    api: 'fs.globSync()',
    since: '22.0.0',
    confidence: 'partial',
    rationale: 'Same substitution as glob, with a real performance regression on very large trees - measure before you swap.',
  },
  {
    pkg: 'rimraf',
    weekly: 70_000_000,
    api: 'fs.rm(path, { recursive: true, force: true })',
    since: '14.14.0',
    confidence: 'exact',
    rationale: 'Core absorbed recursive delete outright; rimraf now mostly wraps it.',
    codemod: 'rimraf-call',
  },
  {
    pkg: 'mkdirp',
    weekly: 40_000_000,
    api: 'fs.mkdir(path, { recursive: true })',
    since: '10.12.0',
    confidence: 'exact',
    rationale: 'One option flag replaced the whole package.',
    codemod: 'mkdirp-call',
  },
  {
    pkg: 'dotenv',
    weekly: 45_000_000,
    api: 'process.loadEnvFile() or node --env-file',
    since: '20.6.0',
    confidence: 'partial',
    rationale: 'Core loads a .env; variable expansion and multi-file precedence are not covered.',
    caveats: ['dotenv.parse', 'dotenv.populate', 'dotenv-expand'],
  },
  {
    pkg: 'debug',
    weekly: 250_000_000,
    api: 'util.debuglog()',
    since: '0.11.0',
    confidence: 'partial',
    rationale: 'debuglog is namespaced, lazily evaluated and driven by NODE_DEBUG; the wildcard grammar is narrower.',
  },
  {
    pkg: 'nodemon',
    weekly: 7_800_000,
    api: 'node --watch',
    since: '18.11.0',
    confidence: 'partial',
    rationale: 'Core restarts on change; ignore globs and per-extension rules are still nodemon-only.',
  },
  {
    pkg: 'ws',
    weekly: 90_000_000,
    api: 'global WebSocket',
    since: '22.0.0',
    confidence: 'partial',
    rationale: 'The global is a client. There is still no WebSocket *server* in Node core.',
    caveats: ['WebSocketServer', 'Server('],
  },
  {
    pkg: 'better-sqlite3',
    weekly: 2_000_000,
    api: 'node:sqlite',
    since: '24.15.0',
    confidence: 'partial',
    rationale: 'node:sqlite reached Release Candidate (Stability 1.2) with no flag; the API is narrower but real.',
  },
  {
    pkg: 'jest',
    weekly: 30_000_000,
    api: 'node:test + node:assert',
    since: '20.0.0',
    confidence: 'partial',
    rationale: 'Runner, assertions, coverage and mocks are all in core; snapshot testing and module mocking are not at parity.',
    caveats: ['toMatchSnapshot', 'jest.mock', 'jest.spyOn'],
  },
  {
    pkg: 'mocha',
    weekly: 8_000_000,
    api: 'node:test',
    since: '20.0.0',
    confidence: 'exact',
    rationale: 'describe/it map onto test/t.test directly, and the reporter is built in.',
  },
  {
    pkg: 'chai',
    weekly: 9_000_000,
    api: 'node:assert/strict',
    since: '18.0.0',
    confidence: 'partial',
    rationale: 'Core assertions cover equality and throws; the fluent BDD chain is a style you give up.',
  },
  {
    pkg: 'cross-env',
    weekly: 15_000_000,
    api: 'node --env-file or npm lifecycle env',
    since: '20.6.0',
    confidence: 'partial',
    rationale: 'Only needed for Windows shell differences; a .env file sidesteps the shell entirely.',
  },
  {
    pkg: 'once',
    weekly: 60_000_000,
    api: 'events.once() or a closure',
    since: '11.13.0',
    confidence: 'exact',
    rationale: 'Three lines, or one core import.',
  },
  {
    pkg: 'p-limit',
    weekly: 90_000_000,
    api: 'a Promise.race pool (~20 lines)',
    since: '18.0.0',
    confidence: 'partial',
    rationale: 'No stdlib API exists; the replacement is code you write, which is why this is reported as partial.',
  },
  {
    pkg: 'lodash.get',
    weekly: 12_000_000,
    api: 'optional chaining (?.)',
    since: '14.0.0',
    confidence: 'partial',
    rationale: 'Language syntax replaces the package unless paths are computed at runtime.',
  },
  {
    pkg: 'deepmerge',
    weekly: 25_000_000,
    api: 'structuredClone() plus a merge you write',
    since: '17.0.0',
    confidence: 'partial',
    rationale: 'Cloning is stdlib; merge policy is application-specific and always was.',
  },
  {
    pkg: 'node-forge',
    weekly: 20_000_000,
    api: 'node:crypto',
    since: '18.0.0',
    confidence: 'partial',
    rationale: 'Core covers hashing, HMAC, AES-GCM, key derivation and X.509 verification. Do not swap crypto casually.',
    caveats: ['forge.pki.createCertificate', 'forge.asn1'],
  },
];

/** @type {Map<string, Entry>} */
const BY_NAME = new Map(ENTRIES.map((entry) => [entry.pkg, entry]));

/** @param {string} pkg @returns {Entry|undefined} */
export function lookup(pkg) {
  return BY_NAME.get(pkg);
}

/** Total weekly downloads across a set of package names, ignoring unknowns. */
export function weeklyTotal(names) {
  let total = 0;
  for (const name of names) total += BY_NAME.get(name)?.weekly ?? 0;
  return total;
}
