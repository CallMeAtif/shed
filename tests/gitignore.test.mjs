import test from 'node:test';
import assert from 'node:assert/strict';
import { Ignore, compilePattern } from '../src/gitignore.mjs';

/** @param {string} text */
const ig = (text) => Ignore.parse(text);

test('compilePattern skips what git skips', async (t) => {
  await t.test('blank lines and comments produce no rule', () => {
    assert.equal(compilePattern(''), null);
    assert.equal(compilePattern('   '), null);
    assert.equal(compilePattern('# a comment'), null);
  });
});

test('unanchored patterns match at any depth', async (t) => {
  const i = ig('node_modules\n*.log');

  await t.test('at the root', () => {
    assert.equal(i.ignores('node_modules', true), true);
    assert.equal(i.ignores('debug.log'), true);
  });

  await t.test('and nested', () => {
    assert.equal(i.ignores('packages/app/node_modules', true), true);
    assert.equal(i.ignores('a/b/c/debug.log'), true);
  });

  await t.test('but not as a substring of another name', () => {
    assert.equal(i.ignores('node_modules_backup'), false);
    assert.equal(i.ignores('log'), false);
  });
});

test('a slash anchors the pattern to the root', async (t) => {
  const i = ig('/dist\nbuild/output');

  await t.test('matches at the root', () => {
    assert.equal(i.ignores('dist', true), true);
    assert.equal(i.ignores('build/output'), true);
  });

  await t.test('does not match the same name deeper', () => {
    assert.equal(i.ignores('packages/app/dist', true), false);
    assert.equal(i.ignores('a/build/output'), false);
  });
});

test('a trailing slash restricts a rule to directories', async (t) => {
  const i = ig('dist/');

  await t.test('matches the directory', () => {
    assert.equal(i.ignores('dist', true), true);
  });

  await t.test('matches everything inside it', () => {
    assert.equal(i.ignores('dist/app.js'), true);
    assert.equal(i.ignores('a/dist/deep/app.js'), true);
  });

  await t.test('does not match a file of that name', () => {
    assert.equal(i.ignores('dist', false), false);
  });
});

test('negation, and last rule wins', async (t) => {
  await t.test('re-includes a file inside an ignored directory', () => {
    const i = ig('build/\n!build/keep.js');
    assert.equal(i.ignores('build/drop.js'), true);
    assert.equal(i.ignores('build/keep.js'), false);
  });

  await t.test('order matters: a later ignore beats an earlier negation', () => {
    const i = ig('*.log\n!important.log\n*.log');
    assert.equal(i.ignores('important.log'), true);
  });
});

test('wildcards', async (t) => {
  await t.test('* does not cross a directory boundary', () => {
    const i = ig('src/*.js');
    assert.equal(i.ignores('src/a.js'), true);
    assert.equal(i.ignores('src/nested/a.js'), false);
  });

  await t.test('**/ matches zero or more directories', () => {
    const i = ig('**/fixtures');
    assert.equal(i.ignores('fixtures', true), true);
    assert.equal(i.ignores('a/b/fixtures', true), true);
  });

  await t.test('a trailing /** matches everything below', () => {
    const i = ig('vendor/**');
    assert.equal(i.ignores('vendor/a/b.js'), true);
  });

  await t.test('? matches exactly one character', () => {
    const i = ig('file?.txt');
    assert.equal(i.ignores('file1.txt'), true);
    assert.equal(i.ignores('file12.txt'), false);
  });

  await t.test('character classes work, including negation', () => {
    const i = ig('log[0-9].txt\n!log[!0-9].txt');
    assert.equal(i.ignores('log3.txt'), true);
    assert.equal(i.ignores('loga.txt'), false);
  });
});

test('regex metacharacters in a pattern are literal', () => {
  const i = ig('a.b.js\nc+d.js');
  assert.equal(i.ignores('a.b.js'), true);
  assert.equal(i.ignores('axbxjs'), false);
  assert.equal(i.ignores('c+d.js'), true);
});

test('an empty ignore file ignores nothing', () => {
  const i = ig('');
  assert.equal(i.ignores('anything.js'), false);
});
