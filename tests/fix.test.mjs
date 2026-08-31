import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { removeDependencies, planFix } from '../src/fix.mjs';
import { main } from '../src/main.mjs';

const MANIFEST = `{
  "name": "fixture",
  "version": "1.0.0",
  "dependencies": {
    "chalk": "^5.0.0",
    "express": "^4.0.0",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "chalk": "^5.0.0"
  }
}
`;

test('removeDependencies preserves the file around the edit', async (t) => {
  await t.test('removes an entry from the middle', () => {
    const { text, removed } = removeDependencies(MANIFEST, [{ name: 'express', field: 'dependencies' }]);
    assert.deepEqual(removed, ['express']);
    assert.equal(JSON.parse(text).dependencies.express, undefined);
    assert.equal(JSON.parse(text).dependencies.chalk, '^5.0.0');
    assert.equal(JSON.parse(text).dependencies.uuid, '^9.0.0');
  });

  await t.test('removes the last entry and fixes the orphaned comma', () => {
    const { text } = removeDependencies(MANIFEST, [{ name: 'uuid', field: 'dependencies' }]);
    assert.doesNotThrow(() => JSON.parse(text));
    assert.match(text, /"express": "\^4\.0\.0"\n/);
  });

  await t.test('removes from the right block when a name appears in two', () => {
    const { text } = removeDependencies(MANIFEST, [{ name: 'chalk', field: 'devDependencies' }]);
    const parsed = JSON.parse(text);
    assert.equal(parsed.dependencies.chalk, '^5.0.0');
    assert.equal(parsed.devDependencies.chalk, undefined);
  });

  await t.test('collapses a block it empties', () => {
    const { text } = removeDependencies(MANIFEST, [{ name: 'chalk', field: 'devDependencies' }]);
    assert.match(text, /"devDependencies": \{\}/);
  });

  await t.test('keeps indentation, key order and the trailing newline', () => {
    const { text } = removeDependencies(MANIFEST, [{ name: 'express', field: 'dependencies' }]);
    assert.match(text, /^\{\n  "name": "fixture",\n  "version": "1\.0\.0",/);
    assert.ok(text.endsWith('}\n'));
  });

  await t.test('reports a name it cannot find instead of guessing', () => {
    const { removed, skipped } = removeDependencies(MANIFEST, [{ name: 'nope', field: 'dependencies' }]);
    assert.deepEqual(removed, []);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, /no line of its own/);
  });

  await t.test('removes several at once', () => {
    const { text, removed } = removeDependencies(MANIFEST, [
      { name: 'chalk', field: 'dependencies' },
      { name: 'uuid', field: 'dependencies' },
    ]);
    assert.deepEqual(removed.sort(), ['chalk', 'uuid']);
    assert.deepEqual(Object.keys(JSON.parse(text).dependencies), ['express']);
  });

  await t.test('is idempotent', () => {
    const once = removeDependencies(MANIFEST, [{ name: 'express', field: 'dependencies' }]).text;
    const twice = removeDependencies(once, [{ name: 'express', field: 'dependencies' }]);
    assert.deepEqual(twice.removed, []);
    assert.equal(twice.text, once);
  });
});

test('planFix decides what may be touched', async (t) => {
  const findings = [
    { name: 'a', field: 'dependencies', verdict: 'unreferenced' },
    { name: 'b', field: 'dependencies', verdict: 'removable' },
    { name: 'c', field: 'devDependencies', verdict: 'tooling' },
    { name: 'd', field: 'dependencies', verdict: 'blocked' },
    { name: 'e', field: 'dependencies', verdict: 'unknown' },
  ];

  await t.test('only unreferenced packages qualify', () => {
    const { targets } = planFix(findings, 0);
    assert.deepEqual(targets, [{ name: 'a', field: 'dependencies' }]);
  });

  await t.test('a package a script runs is never removed', () => {
    assert.ok(!planFix(findings, 0).targets.some((t2) => t2.name === 'c'));
  });

  await t.test('any parse error refuses the whole edit', () => {
    const { targets, refusal } = planFix(findings, 1);
    assert.deepEqual(targets, []);
    assert.match(refusal, /refusing to edit/);
  });
});

test('--fix end to end', async (t) => {
  /** @param {object} manifest @param {Record<string,string>} files */
  const project = (manifest, files) => {
    const dir = mkdtempSync(join(tmpdir(), 'shed-fix-'));
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    return dir;
  };
  const run = (argv) => {
    const out = [];
    const err = [];
    const code = main([...argv, '--no-color'], {
      stdout: (s) => out.push(s), stderr: (s) => err.push(s), columns: 200,
    });
    return { code, stdout: out.join('\n'), stderr: err.join('\n') };
  };

  await t.test('removes the unused dependency and leaves the used one', () => {
    const dir = project(
      {
        name: 'fixture',
        engines: { node: '>=22.0.0' },
        dependencies: { chalk: '^5.0.0', uuid: '^9.0.0' },
      },
      { 'src/a.js': "import chalk from 'chalk';\nexport default chalk;\n" },
    );
    const { code, stdout } = run([dir, '--fix']);
    const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

    assert.equal(code, 0);
    assert.match(stdout, /Removed 1 unreferenced/);
    assert.equal(after.dependencies.uuid, undefined);
    assert.equal(after.dependencies.chalk, '^5.0.0');
    rmSync(dir, { recursive: true, force: true });
  });

  await t.test('will not remove a package a script invokes', () => {
    const dir = project(
      {
        name: 'fixture',
        engines: { node: '>=22.0.0' },
        scripts: { dev: 'nodemon src/a.js' },
        dependencies: { nodemon: '^3.0.0' },
      },
      { 'src/a.js': 'export default 1;\n' },
    );
    const { code, stdout } = run([dir, '--fix']);
    const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

    assert.equal(code, 0);
    assert.match(stdout, /Nothing to remove/);
    assert.equal(after.dependencies.nodemon, '^3.0.0');
    rmSync(dir, { recursive: true, force: true });
  });

  await t.test('refuses to edit when a file did not parse', () => {
    const dir = project(
      { name: 'fixture', engines: { node: '>=22.0.0' }, dependencies: { uuid: '^9.0.0' } },
      { 'src/broken.js': "const s = 'unterminated\n" },
    );
    const { code, stderr } = run([dir, '--fix']);
    const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

    assert.equal(code, 2);
    assert.match(stderr, /refusing to edit/);
    assert.equal(after.dependencies.uuid, '^9.0.0', 'the manifest must be untouched');
    rmSync(dir, { recursive: true, force: true });
  });

  await t.test('running it twice changes nothing the second time', () => {
    const dir = project(
      { name: 'fixture', engines: { node: '>=22.0.0' }, dependencies: { uuid: '^9.0.0' } },
      { 'src/a.js': 'export default 1;\n' },
    );
    run([dir, '--fix']);
    const first = readFileSync(join(dir, 'package.json'), 'utf8');
    const { stdout } = run([dir, '--fix']);
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), first);
    assert.match(stdout, /Nothing to remove/);
    rmSync(dir, { recursive: true, force: true });
  });
});

test('--fix refuses when the scan could not account for every file', async (t) => {
  const project = (manifest, files) => {
    const dir = mkdtempSync(join(tmpdir(), 'shed-blk-'));
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    return dir;
  };
  const run = (argv) => {
    const out = [];
    const err = [];
    const code = main([...argv, '--no-color'], {
      stdout: (s) => out.push(s), stderr: (s) => err.push(s), columns: 200,
    });
    return { code, stdout: out.join('\n'), stderr: err.join('\n') };
  };
  const manifest = { name: 'f', engines: { node: '>=22.0.0' }, dependencies: { chalk: '^5.0.0' } };

  await t.test('a file skipped for size blocks the edit', () => {
    const dir = project(manifest, { 'src/a.js': 'export default 1;\n' });
    writeFileSync(join(dir, 'src/big.js'), `${'// pad\n'.repeat(400000)}import chalk from 'chalk';\n`);
    const { code, stderr } = run([dir, '--fix']);
    assert.equal(code, 2);
    assert.match(stderr, /skipped and never read/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies.chalk, '^5.0.0');
    rmSync(dir, { recursive: true, force: true });
  });

  await t.test('a JSX file blocks the edit, because JSX text is not tokenised', () => {
    const dir = project(manifest, { 'src/a.jsx': "const A = () => <p>it's {require('chalk')} fine</p>;\n" });
    const { code, stderr } = run([dir, '--fix']);
    assert.equal(code, 2);
    assert.match(stderr, /JSX/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies.chalk, '^5.0.0');
    rmSync(dir, { recursive: true, force: true });
  });
});
