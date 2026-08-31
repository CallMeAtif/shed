/**
 * Finding every module specifier in a JavaScript or TypeScript file.
 *
 * The obvious implementation is a regular expression over the source, and it is
 * wrong in ways that matter here: `require` appears inside strings and comments,
 * a regex literal can contain quotes and braces, and a template literal can nest
 * another template literal inside `${}` to arbitrary depth. A tool whose entire
 * job is telling people to delete code cannot afford a false positive, so this is
 * a character scanner with a mode stack instead.
 *
 * Two-pass by design: `tokenize` decides what is code and what is not, and
 * `extractImports` reads import forms out of the resulting token stream. Keeping
 * them apart is what makes both testable.
 */
import { Diagnostic, lineText } from '../errors.mjs';

/** @typedef {'ident'|'string'|'punct'|'number'|'regex'|'template'} TokenType */
/** @typedef {{ type: TokenType, value: string, line: number, col: number, offset: number }} Token */

/**
 * Keywords after which a `/` begins a regex literal rather than a division.
 * The general problem needs a parser; this covers the operator-position cases
 * that occur in real source.
 */
const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);

/** Punctuation after which a `/` is a division rather than a regex. */
const VALUE_ENDING_PUNCT = new Set([')', ']', '}']);

// JavaScript identifiers are Unicode, not ASCII: `import café from 'chalk'` is
// legal. Tokenising `é` as punctuation made the clause walk reject the whole
// import, which then looked unreferenced - and --fix would delete it.
const isIdentStart = (c) => /[\p{ID_Start}$_]/u.test(c);
const isIdentPart = (c) => /[\p{ID_Continue}$\u200C\u200D]/u.test(c);
const isDigit = (c) => c >= '0' && c <= '9';

/**
 * Split source into tokens, discarding comments and template text.
 *
 * Malformed input never throws: an unterminated string or comment is reported as
 * a Diagnostic and scanning stops there, so one bad file cannot kill a run over
 * four thousand of them.
 *
 * @param {string} source
 * @param {string} file path used in diagnostics
 * @returns {{ tokens: Token[], errors: Diagnostic[], comments: [number, number][] }}
 */
export function tokenize(source, file) {
  /** @type {Token[]} */
  const tokens = [];
  /** @type {Diagnostic[]} */
  const errors = [];
  /**
   * Half-open [start, end) offsets of every comment. The scanner already knows
   * precisely what is a comment; exposing it lets other passes stop treating
   * prose as code.
   * @type {[number, number][]}
   */
  const comments = [];

  // A stack entry per template literal we are inside. `braceDepth` counts the
  // plain `{` blocks opened within the current `${}`, so that the `}` which ends
  // the interpolation can be told apart from the ones that end object literals.
  /** @type {{ braceDepth: number }[]} */
  const templates = [];
  let inTemplateText = false;

  let i = 0;
  let line = 1;
  let col = 1;

  const here = () => ({ file, line, col, offset: i });
  const fail = (message, pos = here()) => {
    errors.push(new Diagnostic(message, pos, lineText(source, pos.line)));
  };

  /** Advance one character, keeping line and column truthful. */
  const bump = () => {
    if (source[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
    i++;
  };

  /** @param {number} n */
  const bumpN = (n) => {
    for (let k = 0; k < n && i < source.length; k++) bump();
  };

  /** @param {TokenType} type @param {string} value @param {{line:number,col:number,offset:number}} pos */
  const emit = (type, value, pos) => {
    tokens.push({ type, value, line: pos.line, col: pos.col, offset: pos.offset });
  };

  /** Whether a `/` at the current position starts a regex literal. */
  const regexAllowed = () => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    if (prev.type === 'ident') return REGEX_AFTER_KEYWORD.has(prev.value);
    if (prev.type === 'punct') return !VALUE_ENDING_PUNCT.has(prev.value);
    return false; // after a string, number, regex or template a `/` is division
  };

  /** Read the text part of a template literal, stopping at ` or ${. */
  const readTemplateText = () => {
    const start = here();
    while (i < source.length) {
      const c = source[i];
      if (c === '\\') {
        bumpN(2);
        continue;
      }
      if (c === '`') {
        bump();
        templates.pop();
        inTemplateText = false;
        emit('template', '', start);
        return;
      }
      if (c === '$' && source[i + 1] === '{') {
        bumpN(2);
        templates[templates.length - 1].braceDepth = 0;
        inTemplateText = false;
        return;
      }
      bump();
    }
    fail('unterminated template literal', start);
  };

  while (i < source.length) {
    if (inTemplateText) {
      readTemplateText();
      continue;
    }

    const c = source[i];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '﻿') {
      bump();
      continue;
    }

    if (c === '/' && source[i + 1] === '/') {
      const from = i;
      while (i < source.length && source[i] !== '\n') bump();
      comments.push([from, i]);
      continue;
    }

    if (c === '/' && source[i + 1] === '*') {
      const start = here();
      const from = i;
      bumpN(2);
      let closed = false;
      while (i < source.length) {
        if (source[i] === '*' && source[i + 1] === '/') {
          bumpN(2);
          closed = true;
          break;
        }
        bump();
      }
      if (!closed) fail('unterminated block comment', start);
      comments.push([from, i]);
      continue;
    }

    if (c === '"' || c === "'") {
      const start = here();
      const quote = c;
      bump();
      let value = '';
      let closed = false;
      while (i < source.length) {
        const ch = source[i];
        if (ch === '\\') {
          value += source[i + 1] ?? '';
          bumpN(2);
          continue;
        }
        if (ch === quote) {
          bump();
          closed = true;
          break;
        }
        // A raw newline ends a normal string literal in JavaScript.
        if (ch === '\n') break;
        value += ch;
        bump();
      }
      if (!closed) fail(`unterminated ${quote === '"' ? 'double' : 'single'}-quoted string`, start);
      else emit('string', value, start);
      continue;
    }

    if (c === '`') {
      bump();
      templates.push({ braceDepth: 0 });
      inTemplateText = true;
      continue;
    }

    if (c === '/' && regexAllowed()) {
      const start = here();
      const rewind = { i, line, col };
      bump();
      let inClass = false;
      let closed = false;
      while (i < source.length) {
        const ch = source[i];
        if (ch === '\\') {
          bumpN(2);
          continue;
        }
        if (ch === '\n') break;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) {
          bump();
          closed = true;
          break;
        }
        bump();
      }
      if (!closed) {
        // A regex literal cannot span a line, so an unclosed one was never a
        // regex: it is division, or the `/` of a JSX closing tag. Rewind and
        // treat it as punctuation rather than reporting a parse error - JSX
        // alone would otherwise produce thousands of false diagnostics.
        ({ i, line, col } = rewind);
        bump();
        emit('punct', '/', start);
        continue;
      }
      while (i < source.length && isIdentPart(source[i])) bump(); // flags
      emit('regex', '', start);
      continue;
    }

    // `\u0041bc` is a legal identifier. Rare, but a missed identifier here
    // becomes a missed import, which becomes a deleted dependency.
    const escapedIdent = c === '\\' && source[i + 1] === 'u';
    if (isIdentStart(c) || escapedIdent) {
      const start = here();
      let value = '';
      while (i < source.length) {
        if (source[i] === '\\' && source[i + 1] === 'u') {
          value += source.slice(i, i + 6);
          bumpN(6);
          continue;
        }
        if (!isIdentPart(source[i])) break;
        value += source[i];
        bump();
      }
      emit('ident', value, start);
      continue;
    }

    if (isDigit(c) || (c === '.' && isDigit(source[i + 1]))) {
      const start = here();
      while (i < source.length && /[0-9a-fA-FxXoObBeE._n]/.test(source[i])) bump();
      emit('number', '', start);
      continue;
    }

    // Punctuation. Only single characters are emitted: the extraction pass cares
    // about ( ) . , ; { } and treats everything else as an opaque separator.
    const start = here();
    if (c === '{' && templates.length) templates[templates.length - 1].braceDepth++;
    if (c === '}' && templates.length) {
      const top = templates[templates.length - 1];
      if (top.braceDepth === 0) {
        bump();
        inTemplateText = true; // this `}` closed a ${...}, resume template text
        continue;
      }
      top.braceDepth--;
    }
    bump();
    emit('punct', c, start);
  }

  if (templates.length && errors.length === 0) {
    fail('unterminated template literal', { file, line, col, offset: i });
  }

  return { tokens, errors, comments };
}

/** @typedef {'static'|'dynamic'|'require'|'export-from'} ImportKind */
/** @typedef {{ specifier: string, kind: ImportKind, line: number, col: number, offset: number }} FoundImport */

/**
 * Tokens that may legally appear inside an import or export *clause* - the part
 * between the keyword and `from`.
 *
 * The full clause grammar admits exactly three token classes - identifiers,
 * string module names (ES2022), and the punctuation `{ } , *` - plus the
 * keywords `as`, `type` and `from`. Anything else ends the clause.
 *
 * Bounding the search by the grammar rather than by a token count is what makes
 * this correct in both directions. A fixed lookahead both truncates long clauses
 * (an import of eighty aliased names silently disappears, and a tool that then
 * offers to delete the dependency is worse than useless) and runs past the end
 * of a semicolon-less `export { a }` into the next statement's specifier.
 */
const CLAUSE_PUNCT = new Set(['{', '}', ',', '*']);

/**
 * Read module specifiers out of a token stream.
 *
 * @param {string} source
 * @param {string} file
 * @returns {{ imports: FoundImport[], errors: Diagnostic[], comments: [number, number][] }}
 */
export function extractImports(source, file) {
  const { tokens, errors, comments } = tokenize(source, file);
  /** @type {FoundImport[]} */
  const imports = [];

  /** @param {Token} token @param {ImportKind} kind */
  const record = (token, kind) => {
    imports.push({ specifier: token.value, kind, line: token.line, col: token.col, offset: token.offset });
  };

  /**
   * Find the `from 'spec'` that closes an import or export clause, walking only
   * over tokens the clause grammar permits. Anything else means this was not a
   * from-clause, so the search stops rather than guessing.
   */
  const findFromClause = (start) => {
    let depth = 0;
    let braceClosed = false;

    for (let j = start; j < tokens.length; j++) {
      const token = tokens[j];

      // Once the named-bindings group has closed, the only thing that may
      // follow is `from`. Without this, a semicolon-less `export { a }` walks
      // into the next statement and steals its specifier.
      if (braceClosed) {
        if (token.type !== 'ident' || token.value !== 'from') return null;
        const next = tokens[j + 1];
        return next?.type === 'string' ? next : null;
      }

      if (token.type === 'punct') {
        if (token.value === '{') {
          depth++;
          continue;
        }
        if (token.value === '}') {
          depth--;
          if (depth < 0) return null;
          if (depth === 0) braceClosed = true;
          continue;
        }
        if (CLAUSE_PUNCT.has(token.value)) continue; // ',' or '*'
        return null; // a semicolon, an operator, a literal
      }

      // Inside the braces: names, aliases, and ES2022 string module names
      // (`import { "a-b" as ab } from 'x'`). The depth check has to come before
      // the type guard, or a string dies here rather than being skipped.
      if (depth > 0) {
        if (token.type === 'ident' || token.type === 'string') continue;
        return null;
      }

      // `export * as "ns" from 'x'` puts a string at depth zero too.
      if (token.type === 'string') continue;
      if (token.type !== 'ident') return null;

      if (token.value === 'from') {
        const next = tokens[j + 1];
        return next?.type === 'string' ? next : null;
      }
      // A default-import name, a namespace alias, `as`, or `type`.
    }
    return null;
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== 'ident') continue;
    const next = tokens[index + 1];
    const prev = tokens[index - 1];

    // A property named import/require is not a module reference: `obj.require(x)`.
    if (prev?.type === 'punct' && prev.value === '.') continue;

    if (token.value === 'import') {
      if (next?.type === 'punct' && next.value === '.') continue; // import.meta
      if (next?.type === 'string') {
        record(next, 'static'); // side-effect import: import 'node:fs'
        continue;
      }
      if (next?.type === 'punct' && next.value === '(') {
        const arg = tokens[index + 2];
        // A non-literal argument is a computed specifier; shed reports what it
        // can prove and stays quiet about the rest.
        if (arg?.type === 'string') record(arg, 'dynamic');
        continue;
      }
      const clause = findFromClause(index + 1);
      if (clause) record(clause, 'static');
      continue;
    }

    if (token.value === 'export') {
      // Only `export { ... } from` and `export * from` re-export. A declaration
      // form (`export const`, `export default`, `export function`) has no
      // specifier, and scanning past it would bind to the next statement's.
      let at = index + 1;
      if (tokens[at]?.type === 'ident' && tokens[at].value === 'type') at++;
      const head = tokens[at];
      const isClause = head?.type === 'punct' && (head.value === '{' || head.value === '*');
      if (!isClause) continue;
      const clause = findFromClause(at);
      if (clause) record(clause, 'export-from');
      continue;
    }

    if (token.value === 'require' && next?.type === 'punct' && next.value === '(') {
      const arg = tokens[index + 2];
      if (arg?.type === 'string') record(arg, 'require');
    }
  }

  return { imports, errors, comments };
}

/**
 * Reduce a specifier to the package it belongs to.
 *
 * `lodash/fp/get` is lodash; `@babel/core/lib/x` is @babel/core; anything
 * relative, absolute or builtin belongs to no package.
 *
 * @param {string} specifier
 * @returns {string|null}
 */
export function packageNameFromSpecifier(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('node:') || specifier.startsWith('bun:')) return null;
  if (specifier.startsWith('data:') || specifier.startsWith('http:') || specifier.startsWith('https:')) return null;
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return parts[0] || null;
}

/**
 * A deliberately permissive second opinion, used only to VETO a deletion.
 *
 * The strict scanner is string- and comment-aware, which is right for reporting
 * and wrong for safety in one case: JSX text is not tokenised, so an even number
 * of apostrophes on a line can close a "string" around a real `require()` and
 * swallow it silently, with no diagnostic. This scan ignores all context and
 * matches anything that looks like a specifier.
 *
 * It is never used to claim a package IS used, only to refuse to claim it is
 * not. False positives here cost a dependency staying in a manifest; false
 * negatives in the strict scanner cost a broken build.
 *
 * @param {string} source
 * @returns {Set<string>} package names, loosely
 */
export function looseReferences(source) {
  /** @type {Set<string>} */
  const names = new Set();
  const pattern = /(?:\bfrom|\brequire\s*\(|\bimport\s*\(|\bimport)\s*['"`]([^'"`\n]+)['"`]/g;
  for (const match of source.matchAll(pattern)) {
    const name = packageNameFromSpecifier(match[1]);
    if (name) names.add(name);
  }
  return names;
}
