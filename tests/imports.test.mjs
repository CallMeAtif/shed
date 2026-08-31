import test from 'node:test';
import assert from 'node:assert/strict';
import { extractImports, tokenize, packageNameFromSpecifier } from '../src/scanner/imports.mjs';

/** @param {string} source */
const specifiers = (source) => extractImports(source, 't.js').imports.map((i) => i.specifier);
/** @param {string} source */
const kinds = (source) => extractImports(source, 't.js').imports.map((i) => i.kind);
/** @param {string} source */
const errors = (source) => extractImports(source, 't.js').errors.map((e) => e.message);

test('import forms it must find', async (t) => {
  await t.test('default and named static imports', () => {
    assert.deepEqual(specifiers("import chalk from 'chalk';"), ['chalk']);
    assert.deepEqual(specifiers("import { red, blue } from 'chalk';"), ['chalk']);
    assert.deepEqual(specifiers("import * as fs from 'node:fs';"), ['node:fs']);
  });

  await t.test('side-effect import with no clause', () => {
    assert.deepEqual(specifiers("import 'node:fs';"), ['node:fs']);
  });

  await t.test('an import clause spread over several lines', () => {
    const source = 'import {\n  red,\n  blue,\n} from "chalk";';
    assert.deepEqual(specifiers(source), ['chalk']);
  });

  await t.test('re-export', () => {
    assert.deepEqual(specifiers("export { red } from 'chalk';"), ['chalk']);
    assert.deepEqual(specifiers("export * from 'chalk';"), ['chalk']);
    assert.deepEqual(kinds("export * from 'chalk';"), ['export-from']);
  });

  await t.test('dynamic import', () => {
    assert.deepEqual(specifiers("const m = await import('chalk');"), ['chalk']);
    assert.deepEqual(kinds("const m = await import('chalk');"), ['dynamic']);
  });

  await t.test('require', () => {
    assert.deepEqual(specifiers("const chalk = require('chalk');"), ['chalk']);
    assert.deepEqual(kinds("const chalk = require('chalk');"), ['require']);
  });

  await t.test('several imports in one file, in source order', () => {
    const source = "import a from 'aa';\nconst b = require('bb');\nexport * from 'cc';";
    assert.deepEqual(specifiers(source), ['aa', 'bb', 'cc']);
  });
});

test('things that look like imports but are not', async (t) => {
  await t.test('require inside a line comment', () => {
    assert.deepEqual(specifiers("// const x = require('chalk');"), []);
  });

  await t.test('require inside a block comment', () => {
    assert.deepEqual(specifiers("/*\n const x = require('chalk');\n*/"), []);
  });

  await t.test('require inside a string literal', () => {
    assert.deepEqual(specifiers('const doc = "call require(\'chalk\') to load it";'), []);
  });

  await t.test('require as a property name', () => {
    assert.deepEqual(specifiers("loader.require('chalk');"), []);
  });

  await t.test('import.meta is not a module specifier', () => {
    assert.deepEqual(specifiers("const dir = import.meta.dirname;"), []);
  });

  await t.test('a computed dynamic import is skipped rather than guessed at', () => {
    assert.deepEqual(specifiers('const m = await import(name);'), []);
  });

  await t.test('a file that is entirely comments yields nothing and no errors', () => {
    const source = '// one\n/* two\n   three */\n// four\n';
    assert.deepEqual(specifiers(source), []);
    assert.deepEqual(errors(source), []);
  });
});

test('the cases a regular expression gets wrong', async (t) => {
  await t.test('a regex literal containing quotes', () => {
    const source = "const q = /['\"]/g;\nimport chalk from 'chalk';";
    assert.deepEqual(specifiers(source), ['chalk']);
  });

  await t.test('a regex literal containing a slash inside a character class', () => {
    const source = "const p = /[a-z/]+/;\nconst c = require('chalk');";
    assert.deepEqual(specifiers(source), ['chalk']);
  });

  await t.test('a regex literal containing braces and a quote', () => {
    const source = "const re = /^\\{'\\}$/;\nrequire('chalk');";
    assert.deepEqual(specifiers(source), ['chalk']);
  });

  await t.test('division is not mistaken for a regex', () => {
    const source = "const ratio = width / 2;\nconst half = total / count;\nrequire('chalk');";
    assert.deepEqual(specifiers(source), ['chalk']);
  });

  await t.test('a template literal nested inside another template literal', () => {
    const source = 'const s = `a ${ `b ${ c } d` } e`;\nrequire("chalk");';
    assert.deepEqual(specifiers(source), ['chalk']);
  });

  await t.test('an object literal inside a template interpolation', () => {
    const source = 'const s = `x ${ JSON.stringify({ a: 1 }) } y`;\nrequire("chalk");';
    assert.deepEqual(specifiers(source), ['chalk']);
  });

  await t.test('a require call inside a template interpolation is real code', () => {
    const source = 'const s = `${ require("chalk").red("hi") }`;';
    assert.deepEqual(specifiers(source), ['chalk']);
  });

  await t.test('an escaped backtick does not end the template', () => {
    const source = 'const s = `a \\` ${ 1 } b`;\nrequire("chalk");';
    assert.deepEqual(specifiers(source), ['chalk']);
  });

  await t.test('an escaped quote does not end the string', () => {
    const source = "const s = 'it\\'s fine';\nrequire('chalk');";
    assert.deepEqual(specifiers(source), ['chalk']);
  });
});

test('encoding and line endings', async (t) => {
  await t.test('a byte order mark does not shift the first token', () => {
    const source = '\uFEFFimport chalk from "chalk";';
    assert.deepEqual(specifiers(source), ['chalk']);
  });

  await t.test('CRLF line endings report the right line number', () => {
    const source = 'const a = 1;\r\nconst b = 2;\r\nimport chalk from "chalk";';
    const [found] = extractImports(source, 't.js').imports;
    assert.equal(found.line, 3);
  });

  await t.test('positions are 1-based and point at the specifier', () => {
    const [found] = extractImports("import chalk from 'chalk';", 't.js').imports;
    assert.equal(found.line, 1);
    assert.equal(found.col, 19);
  });
});

test('malformed input degrades instead of crashing', async (t) => {
  await t.test('an unterminated string is a diagnostic, not a throw', () => {
    const found = extractImports("const s = 'oops;\n", 't.js');
    assert.equal(found.errors.length, 1);
    assert.match(found.errors[0].message, /unterminated single-quoted string/);
  });

  await t.test('an unterminated block comment is reported with a position', () => {
    const found = extractImports('/* never closed\nrequire("chalk")', 't.js');
    assert.equal(found.errors.length, 1);
    assert.equal(found.errors[0].pos.line, 1);
  });

  await t.test('an unterminated template literal is reported', () => {
    const found = extractImports('const s = `open forever', 't.js');
    assert.equal(found.errors.length, 1);
    assert.match(found.errors[0].message, /unterminated template literal/);
  });

  await t.test('a diagnostic formats with a caret frame', () => {
    const found = extractImports("const s = 'oops;\n", 't.js');
    const text = found.errors[0].format();
    assert.match(text, /^t\.js:1:11: unterminated single-quoted string/);
    assert.match(text, /\^/);
  });

  await t.test('imports before the bad token are still reported', () => {
    const found = extractImports("import chalk from 'chalk';\nconst s = 'oops;\n", 't.js');
    assert.deepEqual(found.imports.map((i) => i.specifier), ['chalk']);
    assert.equal(found.errors.length, 1);
  });
});

test('packageNameFromSpecifier', async (t) => {
  await t.test('takes the first segment of a bare specifier', () => {
    assert.equal(packageNameFromSpecifier('lodash'), 'lodash');
    assert.equal(packageNameFromSpecifier('lodash/fp/get'), 'lodash');
  });

  await t.test('keeps both segments of a scoped package', () => {
    assert.equal(packageNameFromSpecifier('@babel/core'), '@babel/core');
    assert.equal(packageNameFromSpecifier('@babel/core/lib/index.js'), '@babel/core');
  });

  await t.test('ignores anything that is not a package', () => {
    for (const s of ['./local.mjs', '../up.mjs', '/abs/path.js', 'node:fs', 'bun:sqlite', 'https://x/y.js', '']) {
      assert.equal(packageNameFromSpecifier(s), null, s);
    }
  });
});

test('tokenize is independently correct', async (t) => {
  await t.test('drops comments and template text from the stream', () => {
    const { tokens } = tokenize('// c\nconst a = `text`;', 't.js');
    assert.deepEqual(tokens.map((x) => x.type), ['ident', 'ident', 'punct', 'template', 'punct']);
  });

  await t.test('reports no errors for well-formed source', () => {
    const { errors: errs } = tokenize('const re = /a\\/b/g; const s = `x${1}y`;', 't.js');
    assert.deepEqual(errs, []);
  });
});

test('clause scanning is bounded by the grammar, not by a token count', async (t) => {
  await t.test('an import of eighty aliased names is still found', () => {
    const clause = Array.from({ length: 80 }, (_, i) => `  Comp${i} as C${i},`).join('\n');
    const source = `import {\n${clause}\n} from '@mui/material';\n`;
    assert.deepEqual(specifiers(source), ['@mui/material']);
  });

  await t.test('a long clause produces no spurious diagnostics', () => {
    const clause = Array.from({ length: 200 }, (_, i) => `  n${i},`).join('\n');
    assert.deepEqual(errors(`import {\n${clause}\n} from 'x';\n`), []);
  });
});

test('a semicolon-less export must not steal the next statement\'s specifier', async (t) => {
  await t.test('export { a } followed by an import', () => {
    assert.deepEqual(specifiers("const a = 1\nexport { a }\nimport semver from 'semver'\n"), ['semver']);
  });

  await t.test('export { a } followed by a require', () => {
    assert.deepEqual(specifiers("export { a }\nconst x = require('chalk')\n"), ['chalk']);
  });

  await t.test('declaration exports are not re-exports', () => {
    for (const head of ['export default config', 'export const a = 1', 'export function f() {}', 'export class C {}']) {
      assert.deepEqual(specifiers(`${head}\nimport semver from 'semver'\n`), ['semver'], head);
    }
  });

  await t.test('genuine re-export forms still resolve', () => {
    assert.deepEqual(specifiers("export { red } from 'chalk';"), ['chalk']);
    assert.deepEqual(specifiers("export * from 'chalk';"), ['chalk']);
    assert.deepEqual(specifiers("export * as ns from 'chalk';"), ['chalk']);
    assert.deepEqual(specifiers("export type { A } from 'chalk';"), ['chalk']);
  });
});
