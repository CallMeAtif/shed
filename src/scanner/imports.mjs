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

const isIdentStart = (c) => /[A-Za-z_$]/.test(c);
const isIdentPart = (c) => /[A-Za-z0-9_$]/.test(c);
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
 * @returns {{ tokens: Token[], errors: Diagnostic[] }}
 */
export function tokenize(source, file) {
  /** @type {Token[]} */
  const tokens = [];
  /** @type {Diagnostic[]} */
  const errors = [];

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
      while (i < source.length && source[i] !== '\n') bump();
      continue;
    }

    if (c === '/' && source[i + 1] === '*') {
      const start = here();
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

    if (isIdentStart(c)) {
      const start = here();
      let value = '';
      while (i < source.length && isIdentPart(source[i])) {
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

  return { tokens, errors };
}

/** @typedef {'static'|'dynamic'|'require'|'export-from'} ImportKind */
/** @typedef {{ specifier: string, kind: ImportKind, line: number, col: number, offset: number }} FoundImport */

/** How far past an `import`/`export` keyword to look for its `from` clause. */
const CLAUSE_LOOKAHEAD = 200;

/**
 * Read module specifiers out of a token stream.
 *
 * @param {string} source
 * @param {string} file
 * @returns {{ imports: FoundImport[], errors: Diagnostic[] }}
 */
export function extractImports(source, file) {
  const { tokens, errors } = tokenize(source, file);
  /** @type {FoundImport[]} */
  const imports = [];

  /** @param {Token} token @param {ImportKind} kind */
  const record = (token, kind) => {
    imports.push({ specifier: token.value, kind, line: token.line, col: token.col, offset: token.offset });
  };

  /** Find the `from 'spec'` that closes an import or export clause. */
  const findFromClause = (start) => {
    const limit = Math.min(tokens.length, start + CLAUSE_LOOKAHEAD);
    for (let j = start; j < limit; j++) {
      const token = tokens[j];
      if (token.type === 'punct' && token.value === ';') return null;
      if (token.type === 'ident' && token.value === 'from') {
        const next = tokens[j + 1];
        return next?.type === 'string' ? next : null;
      }
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
      const clause = findFromClause(index + 1);
      if (clause) record(clause, 'export-from');
      continue;
    }

    if (token.value === 'require' && next?.type === 'punct' && next.value === '(') {
      const arg = tokens[index + 2];
      if (arg?.type === 'string') record(arg, 'require');
    }
  }

  return { imports, errors };
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
