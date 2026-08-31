/**
 * .gitignore matching, without the `ignore` package.
 *
 * gitignore looks like globbing and is not: patterns without a slash match at any
 * depth while patterns with one are anchored, a trailing slash restricts a rule to
 * directories, `!` un-ignores, and the *last* matching rule wins rather than the
 * first. All four of those are load-bearing in real repositories, so they are all
 * implemented here.
 *
 * Deliberately unsupported: `.gitignore` files in subdirectories (only the root
 * one is read) and `\` escaping of a leading `!` or `#`. Both are in the README's
 * limits section.
 */

/**
 * `self` matches the path itself; `under` matches anything beneath it. Keeping
 * the two apart is what lets a directory-only rule such as `dist/` ignore
 * `dist/app.js` while still not ignoring a plain *file* named `dist`.
 *
 * @typedef {{ self: RegExp, under: RegExp, negate: boolean, dirOnly: boolean, source: string }} Rule
 */

/**
 * Translate one gitignore pattern into anchored regular expressions.
 *
 * @param {string} pattern
 * @returns {Rule|null} null for blank lines and comments
 */
export function compilePattern(pattern) {
  let text = pattern;

  // Trailing whitespace is insignificant unless backslash-escaped.
  text = text.replace(/(?<!\\)\s+$/, '');
  if (text === '' || text.startsWith('#')) return null;

  const negate = text.startsWith('!');
  if (negate) text = text.slice(1);

  const dirOnly = text.endsWith('/');
  if (dirOnly) text = text.slice(0, -1);

  // A slash anywhere but the end anchors the pattern to the repository root.
  const anchored = text.includes('/');
  if (text.startsWith('/')) text = text.slice(1);

  let body = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '*') {
      if (text[i + 1] === '*') {
        // `**/` matches zero or more directories; a bare `**` matches anything.
        if (text[i + 2] === '/') {
          body += '(?:[^/]+/)*';
          i += 2;
        } else {
          body += '.*';
          i += 1;
        }
        continue;
      }
      body += '[^/]*';
      continue;
    }
    if (c === '?') {
      body += '[^/]';
      continue;
    }
    if (c === '[') {
      // Character classes pass through, with gitignore's `!` negation spelled `^`.
      const close = text.indexOf(']', i + 1);
      if (close === -1) {
        body += '\\[';
        continue;
      }
      const inner = text.slice(i + 1, close);
      body += '[' + (inner.startsWith('!') ? '^' + inner.slice(1) : inner) + ']';
      i = close;
      continue;
    }
    body += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }

  // An unanchored pattern may match at any depth.
  const prefix = anchored ? '^' : '^(?:.*/)?';
  return {
    self: new RegExp(prefix + body + '$'),
    under: new RegExp(prefix + body + '/.*$'),
    negate,
    dirOnly,
    source: pattern,
  };
}

export class Ignore {
  /** @param {Rule[]} rules */
  constructor(rules) {
    this.rules = rules;
  }

  /**
   * @param {string} content the text of a .gitignore file
   * @param {string[]} [extra] additional patterns, e.g. shed's own defaults
   */
  static parse(content, extra = []) {
    /** @type {Rule[]} */
    const rules = [];
    for (const line of [...content.split(/\r?\n/), ...extra]) {
      const rule = compilePattern(line);
      if (rule) rules.push(rule);
    }
    return new Ignore(rules);
  }

  /**
   * @param {string} path repository-relative, forward-slashed, no leading ./
   * @param {boolean} [isDir]
   * @returns {boolean}
   */
  ignores(path, isDir = false) {
    let ignored = false;
    // Last match wins, so this cannot short-circuit on the first hit.
    for (const rule of this.rules) {
      // A directory-only rule never matches a file by name, but everything
      // underneath the directory it names is still ignored.
      const hit = rule.dirOnly
        ? (isDir && rule.self.test(path)) || rule.under.test(path)
        : rule.self.test(path) || rule.under.test(path);
      if (hit) ignored = !rule.negate;
    }
    return ignored;
  }
}
