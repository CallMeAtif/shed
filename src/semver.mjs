/**
 * Version comparison and range satisfaction, without the semver package.
 *
 * The standard library has no answer here at all, so this is written from the
 * spec. It implements the subset shed actually needs to answer one question -
 * "is this project's declared Node floor at least the version where the
 * replacement API landed?" - and the README says exactly which subset that is.
 *
 * Whitespace between an operator and its version is normalised first, so
 * ">= 1.2.3" and ">=1.2.3" are the same range. Build metadata is accepted and
 * ignored, per the semver spec.
 *
 * Supported range grammar:
 *   comparators      >=1.2.3  >1.2.3  <=1.2.3  <1.2.3  =1.2.3  1.2.3
 *   caret and tilde  ^1.2.3  ~1.2.3
 *   wildcards        *  x  1.x  1.2.x  (and the bare empty range)
 *   hyphen ranges    1.2.3 - 2.3.4
 *   intersection     space or comma separated comparators
 *   union            ||
 *
 * Build metadata is parsed and ignored for ordering, per the spec. Prerelease
 * inclusion follows node-semver: a prerelease satisfies a comparator set only if
 * some comparator pins the same major.minor.patch and is itself a prerelease.
 */

/** @typedef {{ major: number, minor: number, patch: number, prerelease: (string|number)[] }} Version */

const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * @param {string} input
 * @returns {Version|null} null rather than throwing: version strings in the wild
 *   include `latest`, `workspace:*` and git URLs, and none of those are errors.
 */
export function parse(input) {
  const match = VERSION_RE.exec(String(input).trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? 0 : Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)),
  };
}

/**
 * Standard semver precedence, including the rule that any prerelease sorts
 * below its own release.
 * @param {Version} a @param {Version} b @returns {-1|0|1}
 */
export function compare(a, b) {
  for (const key of /** @type {const} */ (['major', 'minor', 'patch'])) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = typeof x === 'number';
    const yNum = typeof y === 'number';
    if (xNum && yNum) return x < y ? -1 : 1;
    if (xNum !== yNum) return xNum ? -1 : 1; // numeric identifiers rank below alphanumeric
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/** @param {string} a @param {string} b @returns {-1|0|1} treating unparseable as equal */
export function compareStrings(a, b) {
  const va = parse(a);
  const vb = parse(b);
  if (!va || !vb) return 0;
  return compare(va, vb);
}

/** @param {string} a @param {string} b */
export const gte = (a, b) => compareStrings(a, b) >= 0;

/** @typedef {{ op: '>='|'>'|'<='|'<'|'=', version: Version }} Comparator */

/**
 * Expand one range token into the comparators it means.
 * @param {string} token
 * @returns {Comparator[]|null} null when the token is not a range shape we handle
 */
function expandToken(token) {
  const text = token.trim();
  if (text === '' || text === '*' || text === 'x' || text === 'X') return [];

  const opMatch = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(text);
  if (!opMatch) return null;
  const [, op = '', rest] = opMatch;

  // Partial versions (1, 1.2, 1.x) define an implicit range rather than a point.
  const partial = /^v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(rest);
  if (!partial) return null;
  const major = Number(partial[1]);
  const minorRaw = partial[2];
  const patchRaw = partial[3];
  const minorWild = minorRaw === undefined || /^[xX*]$/.test(minorRaw);
  const patchWild = patchRaw === undefined || /^[xX*]$/.test(patchRaw);
  const minor = minorWild ? 0 : Number(minorRaw);
  const patch = patchWild ? 0 : Number(patchRaw);
  const prerelease = partial[4] === undefined ? [] : partial[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id));
  /** @type {Version} */
  const base = { major, minor, patch, prerelease };

  /** @param {Version} v @returns {Version} */
  const nextMajor = (v) => ({ major: v.major + 1, minor: 0, patch: 0, prerelease: [] });
  /** @param {Version} v @returns {Version} */
  const nextMinor = (v) => ({ major: v.major, minor: v.minor + 1, patch: 0, prerelease: [] });

  switch (op) {
    case '>=':
      return [{ op: '>=', version: base }];
    case '>':
      return [{ op: '>', version: base }];
    case '<=':
      return [{ op: '<=', version: base }];
    case '<':
      return [{ op: '<', version: base }];
    case '^':
      // Below 1.0.0 the leftmost *specified* non-zero component is the one that
      // must stay put, and a wildcard widens the bound rather than narrowing it:
      // ^0.x is <1.0.0, ^0.0.x is <0.1.0, ^0.2.3 is <0.3.0, ^0.0.3 is <0.0.4.
      if (major !== 0 || minorWild) return [{ op: '>=', version: base }, { op: '<', version: nextMajor(base) }];
      if (patchWild) return [{ op: '>=', version: base }, { op: '<', version: nextMinor(base) }];
      if (minor !== 0) return [{ op: '>=', version: base }, { op: '<', version: nextMinor(base) }];
      return [{ op: '>=', version: base }, { op: '<', version: { major: 0, minor: 0, patch: patch + 1, prerelease: [] } }];
    case '~':
      return minorWild
        ? [{ op: '>=', version: base }, { op: '<', version: nextMajor(base) }]
        : [{ op: '>=', version: base }, { op: '<', version: nextMinor(base) }];
    default:
      if (minorWild) return [{ op: '>=', version: base }, { op: '<', version: nextMajor(base) }];
      if (patchWild) return [{ op: '>=', version: base }, { op: '<', version: nextMinor(base) }];
      return [{ op: '=', version: base }];
  }
}

/**
 * Split a range into its OR-ed alternatives, each a list of AND-ed comparators.
 * @param {string} range
 * @returns {Comparator[][]|null} null when any alternative fails to parse
 */
export function parseRange(range) {
  // ">= 18.0.0" is valid and common, but splitting on whitespace would make ">="
  // a token of its own and fail the whole range - which used to fall back to the
  // running Node silently, flipping verdicts toward "removable". Bind each
  // operator to the version it qualifies before anything else happens.
  const text = String(range).replace(/\s+/g, ' ').replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1');

  // An empty range means "any version"; an empty *alternative* ("||", ">=1 ||")
  // is malformed, and must not be read as a comparator set that matches
  // everything.
  if (text.trim() === '') return [[]];

  /** @type {Comparator[][]} */
  const alternatives = [];
  for (const alt of text.split('||')) {
    if (alt.trim() === '') return null;
    // Hyphen ranges bind looser than intersection, so resolve them before splitting.
    const hyphen = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(alt);
    if (hyphen) {
      const lower = expandToken(`>=${hyphen[1]}`);
      // A partial upper bound covers the whole component it omits: "1.2.3 - 2.3"
      // ends below 2.4.0, not at 2.3.0.
      const parts = hyphen[2].replace(/^v/, '').split('.');
      const upper = parts.length >= 3
        ? expandToken(`<=${hyphen[2]}`)
        : expandToken(`<${parts.length === 1 ? `${Number(parts[0]) + 1}.0.0` : `${parts[0]}.${Number(parts[1]) + 1}.0`}`);
      if (!lower || !upper) return null;
      alternatives.push([...lower, ...upper]);
      continue;
    }
    /** @type {Comparator[]} */
    const comparators = [];
    for (const token of alt.split(/[\s,]+/).filter(Boolean)) {
      const expanded = expandToken(token);
      if (!expanded) return null;
      comparators.push(...expanded);
    }
    alternatives.push(comparators);
  }
  return alternatives;
}

/**
 * @param {string} version
 * @param {string} range
 * @returns {boolean} false for unparseable input, never a throw
 */
export function satisfies(version, range) {
  const target = parse(version);
  const alternatives = parseRange(range);
  if (!target || !alternatives) return false;

  return alternatives.some((comparators) => {
    // node-semver's rule: a prerelease only satisfies a set when some comparator
    // pins the same [major, minor, patch] and is itself a prerelease. Otherwise
    // 1.2.3-alpha would satisfy ">=1.0.0", which is not what anyone means by a
    // version floor.
    if (target.prerelease.length > 0) {
      const tupleMatch = comparators.some(({ version: bound }) =>
        bound.prerelease.length > 0
        && bound.major === target.major
        && bound.minor === target.minor
        && bound.patch === target.patch);
      if (!tupleMatch) return false;
    }
    return comparators.every(({ op, version: bound }) => {
      const cmp = compare(target, bound);
      switch (op) {
        case '>=': return cmp >= 0;
        case '>': return cmp > 0;
        case '<=': return cmp <= 0;
        case '<': return cmp < 0;
        default: return cmp === 0;
      }
    });
  });
}

/**
 * The lowest version a range admits - the project's real floor.
 *
 * This is the question shed asks of `engines.node`: a project declaring
 * ">=18 || >=22" can still be run on 18, so 18 is what a recommendation must
 * clear. Exclusive lower bounds (`>1.2.3`) are treated as their own version,
 * which understates the floor by one patch and can only ever make shed more
 * conservative.
 *
 * @param {string} range
 * @returns {string|null} null when the range has no lower bound or does not parse
 */
export function lowerBound(range) {
  const alternatives = parseRange(range);
  if (!alternatives) return null;

  /** @type {Version|null} */
  let lowest = null;
  for (const comparators of alternatives) {
    /** @type {Version|null} */
    let altLow = null;
    for (const { op, version } of comparators) {
      if (op !== '>=' && op !== '>' && op !== '=') continue;
      if (!altLow || compare(version, altLow) < 0) altLow = version;
    }
    if (!altLow) return null; // an unbounded alternative (`*`, `<20`) admits 0.0.0
    if (!lowest || compare(altLow, lowest) < 0) lowest = altLow;
  }
  return lowest ? format(lowest) : null;
}

/** @param {Version} v */
export function format(v) {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease.length ? `${core}-${v.prerelease.join('.')}` : core;
}
