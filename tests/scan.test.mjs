/**
 * End-to-end tests: build a real project in a temporary directory, scan it, and
 * assert on the verdicts and the process exit code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { main } from '../src/main.mjs';

/**
 * @param {object} manifest
 * @param {Record<string, string>} files relative path -> contents
 * @returns {string} the project directory
 */
function makeProject(manifest, files) {
  const dir = mkdtempSync(join(tmpdir(), 'shed-test-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

/** Run shed against a directory and capture everything it produced. */
function run(argv) {
  const out = [];
  const err = [];
  const code = main([...argv, '--no-color'], {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    columns: 200,
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

/** Parse the JSON report for a directory. */
function report(dir, extra = []) {
  const { stdout, code } = run([dir, '--json', ...extra]);
  return { json: JSON.parse(stdout), code };
}

test('a project with a clean stdlib swap', async (t) => {
  const dir = makeProject(
    { name: 'fixture', engines: { node: '>=22.0.0' }, dependencies: { chalk: '^5.0.0' } },
    { 'src/log.js': "import chalk from 'chalk';\nexport const hi = () => chalk.red('hi');\n" },
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { json, code } = report(dir);
  const finding = json.findings.find((f) => f.name === 'chalk');

  await t.test('is reported as removable', () => {
    assert.equal(finding.verdict, 'removable');
  });

  await t.test('names the replacement and the version it landed in', () => {
    assert.equal(finding.replacement.api, 'util.styleText()');
    assert.equal(finding.replacement.since, '20.12.0');
  });

  await t.test('points at the import site', () => {
    assert.deepEqual(finding.sites.map((s) => `${s.file}:${s.line}`), ['src/log.js:1']);
  });

  await t.test('exits 1 so it can be used as a CI gate', () => {
    assert.equal(code, 1);
  });
});

test('a caveat in the source blocks the swap', async (t) => {
  const dir = makeProject(
    { name: 'fixture', engines: { node: '>=22.0.0' }, dependencies: { chalk: '^5.0.0' } },
    { 'src/log.js': "import chalk from 'chalk';\nexport const hi = () => chalk.hex('#fff')('hi');\n" },
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const finding = report(dir).json.findings.find((f) => f.name === 'chalk');

  await t.test('is blocked rather than removable', () => {
    assert.equal(finding.verdict, 'blocked');
  });

  await t.test('says which API the stdlib does not cover', () => {
    assert.match(finding.because, /\.hex\(/);
  });

  await t.test('cites the line that blocks it', () => {
    assert.equal(finding.caveats[0].line, 2);
  });
});

test("the project's Node floor gates the recommendation", async (t) => {
  const files = { 'src/a.js': "import { globSync } from 'glob';\nexport default globSync('*');\n" };

  await t.test('below the floor it needs a bump', () => {
    const dir = makeProject(
      { name: 'old', engines: { node: '>=18.0.0' }, dependencies: { glob: '^10.0.0' } },
      files,
    );
    const finding = report(dir).json.findings.find((f) => f.name === 'glob');
    assert.equal(finding.verdict, 'bump');
    assert.match(finding.because, /needs Node 22\.0\.0/);
    rmSync(dir, { recursive: true, force: true });
  });

  await t.test('above the floor it is removable', () => {
    const dir = makeProject(
      { name: 'new', engines: { node: '>=22.0.0' }, dependencies: { glob: '^10.0.0' } },
      files,
    );
    const finding = report(dir).json.findings.find((f) => f.name === 'glob');
    assert.equal(finding.verdict, 'removable');
    rmSync(dir, { recursive: true, force: true });
  });

  await t.test('--node overrides what the manifest declares', () => {
    const dir = makeProject(
      { name: 'old', engines: { node: '>=18.0.0' }, dependencies: { glob: '^10.0.0' } },
      files,
    );
    const { json } = report(dir, ['--node', '22.0.0']);
    assert.equal(json.node.source, 'flag');
    assert.equal(json.findings.find((f) => f.name === 'glob').verdict, 'removable');
    rmSync(dir, { recursive: true, force: true });
  });
});

test('packages nothing imports, and packages shed has no opinion on', async (t) => {
  const dir = makeProject(
    {
      name: 'fixture',
      engines: { node: '>=22.0.0' },
      dependencies: { chalk: '^5.0.0', 'some-private-thing': '^1.0.0' },
    },
    { 'src/a.js': "import x from 'some-private-thing';\nexport default x;\n" },
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { json, code } = report(dir, ['--all']);

  await t.test('a declared but unimported package is unreferenced', () => {
    assert.equal(json.findings.find((f) => f.name === 'chalk').verdict, 'unreferenced');
  });

  await t.test('an unmapped package is unknown, not guessed at', () => {
    const finding = json.findings.find((f) => f.name === 'some-private-thing');
    assert.equal(finding.verdict, 'unknown');
    assert.equal(finding.replacement, null);
  });

  await t.test('exits 0 when nothing is removable', () => {
    assert.equal(code, 0);
  });
});

test('scanning respects .gitignore and skips node_modules', async (t) => {
  const dir = makeProject(
    { name: 'fixture', engines: { node: '>=22.0.0' }, dependencies: { chalk: '^5.0.0' } },
    {
      '.gitignore': 'build/\n',
      'src/a.js': "export const a = 1;\n",
      'build/bundle.js': "import chalk from 'chalk';\n",
      'node_modules/dep/index.js': "import chalk from 'chalk';\n",
    },
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { json } = report(dir, ['--all']);

  await t.test('only the one real source file is scanned', () => {
    assert.equal(json.scanned, 1);
  });

  await t.test('so an import that exists only in ignored files is not counted', () => {
    assert.equal(json.findings.find((f) => f.name === 'chalk').verdict, 'unreferenced');
  });
});

test('--ignore drops a package from the report entirely', async (t) => {
  const dir = makeProject(
    { name: 'fixture', engines: { node: '>=22.0.0' }, dependencies: { chalk: '^5.0.0' } },
    { 'src/a.js': "import chalk from 'chalk';\n" },
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { json, code } = report(dir, ['--ignore', 'chalk']);
  assert.equal(json.findings.length, 0);
  assert.equal(code, 0);
});

test('the JSON report has the shape the README documents', async (t) => {
  const dir = makeProject(
    { name: 'fixture', version: '1.2.3', engines: { node: '>=22.0.0' }, dependencies: { chalk: '^5.0.0' } },
    { 'src/a.js': "import chalk from 'chalk';\n" },
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { json } = report(dir);
  assert.equal(json.project.name, 'fixture');
  assert.equal(json.project.version, '1.2.3');
  assert.deepEqual(json.node, { version: '22.0.0', source: 'engines' });
  assert.equal(typeof json.scanned, 'number');
  assert.equal(json.totals.byVerdict.removable, 1);
  assert.ok(Array.isArray(json.errors));
});

test('failure modes', async (t) => {
  await t.test('a directory with no package.json exits 2 with a clear message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shed-empty-'));
    const { code, stderr } = run([dir]);
    assert.equal(code, 2);
    assert.match(stderr, /no package\.json here/);
    rmSync(dir, { recursive: true, force: true });
  });

  await t.test('a malformed package.json reports a line and column', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shed-bad-'));
    writeFileSync(join(dir, 'package.json'), '{\n  "name": "x",\n  oops\n}\n');
    const { code, stderr } = run([dir]);
    assert.equal(code, 2);
    assert.match(stderr, /not valid JSON/);
    assert.match(stderr, /package\.json:3:/);
    rmSync(dir, { recursive: true, force: true });
  });

  await t.test('an unknown flag exits 2 and points at --help', () => {
    const { code, stderr } = run(['--nonsense']);
    assert.equal(code, 2);
    assert.match(stderr, /--help/);
  });
});

test('other commands', async (t) => {
  await t.test('--version prints just the version', () => {
    const { stdout, code } = run(['--version']);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
    assert.equal(code, 0);
  });

  await t.test('list prints the knowledge base as JSON', () => {
    const { stdout, code } = run(['list', '--json']);
    const entries = JSON.parse(stdout);
    assert.ok(entries.length > 50);
    assert.ok(entries.every((e) => e.pkg && e.api && e.since));
    assert.equal(code, 0);
  });

  await t.test('why explains a package shed knows', () => {
    const { stdout, code } = run(['why', 'chalk']);
    assert.match(stdout, /util\.styleText/);
    assert.match(stdout, /20\.12\.0/);
    assert.equal(code, 0);
  });

  await t.test('why is honest about a package it does not know', () => {
    const { stdout } = run(['why', 'definitely-not-a-real-package-xyz']);
    assert.match(stdout, /no opinion/);
  });

  await t.test('why with no package name is a usage error', () => {
    assert.equal(run(['why']).code, 2);
  });
});

test('packages that are never imported but must not be removed', async (t) => {
  await t.test('a @types package is tooling, not dead weight', () => {
    const dir = makeProject(
      {
        name: 'fixture',
        engines: { node: '>=22.0.0' },
        devDependencies: { '@types/node': '^22.0.0' },
      },
      { 'src/a.js': 'export default 1;\n' },
    );
    const finding = report(dir, ['--all']).json.findings.find((f) => f.name === '@types/node');
    assert.equal(finding.verdict, 'tooling');
    assert.match(finding.because, /resolved by name/);
    rmSync(dir, { recursive: true, force: true });
  });

  await t.test('an eslint plugin is tooling by naming convention', () => {
    const dir = makeProject(
      { name: 'fixture', engines: { node: '>=22.0.0' }, devDependencies: { 'eslint-plugin-import': '^2.0.0' } },
      { 'src/a.js': 'export default 1;\n' },
    );
    assert.equal(
      report(dir, ['--all']).json.findings.find((f) => f.name === 'eslint-plugin-import').verdict,
      'tooling',
    );
    rmSync(dir, { recursive: true, force: true });
  });

  await t.test('a package named in a JSON config is tooling', () => {
    const dir = makeProject(
      { name: 'fixture', engines: { node: '>=22.0.0' }, devDependencies: { 'some-tool': '^1.0.0' } },
      { 'src/a.js': 'export default 1;\n', '.releaserc.json': '{ "plugins": ["some-tool"] }\n' },
    );
    const finding = report(dir, ['--all']).json.findings.find((f) => f.name === 'some-tool');
    assert.equal(finding.verdict, 'tooling');
    assert.match(finding.because, /named in a config file/);
    rmSync(dir, { recursive: true, force: true });
  });

  await t.test('a package named in a manifest section other than dependencies is tooling', () => {
    const dir = makeProject(
      {
        name: 'fixture',
        engines: { node: '>=22.0.0' },
        'lint-staged': { '*.js': 'some-linter --fix' },
        devDependencies: { 'some-linter': '^1.0.0' },
      },
      { 'src/a.js': 'export default 1;\n' },
    );
    assert.equal(
      report(dir, ['--all']).json.findings.find((f) => f.name === 'some-linter').verdict,
      'tooling',
    );
    rmSync(dir, { recursive: true, force: true });
  });

  await t.test('none of them are offered to --fix', () => {
    const dir = makeProject(
      {
        name: 'fixture',
        engines: { node: '>=22.0.0' },
        devDependencies: { '@types/node': '^22.0.0', 'eslint-config-x': '^1.0.0' },
        dependencies: { uuid: '^9.0.0' },
      },
      { 'src/a.js': 'export default 1;\n' },
    );
    const { stdout } = run([dir, '--fix']);
    const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.match(stdout, /Removed 1 unreferenced dependency/);
    assert.equal(after.dependencies.uuid, undefined);
    assert.equal(after.devDependencies['@types/node'], '^22.0.0');
    assert.equal(after.devDependencies['eslint-config-x'], '^1.0.0');
    rmSync(dir, { recursive: true, force: true });
  });

  await t.test('a genuinely unused package is still caught', () => {
    const dir = makeProject(
      { name: 'fixture', engines: { node: '>=22.0.0' }, dependencies: { uuid: '^9.0.0' } },
      { 'src/a.js': 'export default 1;\n' },
    );
    assert.equal(
      report(dir, ['--all']).json.findings.find((f) => f.name === 'uuid').verdict,
      'unreferenced',
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

test('caveat evidence quality', async (t) => {
  await t.test('a caveat mentioned only in a comment does not block the swap', () => {
    const dir = makeProject(
      { name: 'fixture', engines: { node: '>=22.0.0' }, dependencies: { chalk: '^5.0.0' } },
      { 'src/a.js': "import chalk from 'chalk';\n// we used to call chalk.hex('#fff') here\nexport default chalk.red('x');\n" },
    );
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.equal(report(dir).json.findings.find((f) => f.name === 'chalk').verdict, 'removable');
  });

  await t.test('but real usage still blocks it', () => {
    const dir = makeProject(
      { name: 'fixture', engines: { node: '>=22.0.0' }, dependencies: { chalk: '^5.0.0' } },
      { 'src/a.js': "import chalk from 'chalk';\nexport default chalk.hex('#fff')('x');\n" },
    );
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.equal(report(dir).json.findings.find((f) => f.name === 'chalk').verdict, 'blocked');
  });

  await t.test('a line with two caveats is cited once, not twice', () => {
    const dir = makeProject(
      { name: 'fixture', engines: { node: '>=22.0.0' }, dependencies: { axios: '^1.0.0' } },
      { 'src/a.js': "import axios from 'axios';\nconst c = axios.create({ interceptors: {} });\nexport default c;\n" },
    );
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const finding = report(dir).json.findings.find((f) => f.name === 'axios');
    const lines = finding.caveats.map((h) => `${h.file}:${h.line}`);
    assert.deepEqual(lines, [...new Set(lines)]);
  });
});

test('packages the manifest declares that no import can vouch for', async (t) => {
  await t.test('a peer requirement of an installed package is tooling', () => {
    const dir = makeProject(
      { name: 'site', engines: { node: '>=22.0.0' }, dependencies: { next: '^14.0.0', 'react-dom': '^18.0.0' } },
      {
        'src/a.js': 'export default 1;\n',
        'package-lock.json': JSON.stringify({
          lockfileVersion: 3,
          packages: {
            '': { dependencies: { next: '^14.0.0', 'react-dom': '^18.0.0' } },
            'node_modules/next': { version: '14.0.0', peerDependencies: { 'react-dom': '^18.0.0' } },
            'node_modules/react-dom': { version: '18.0.0' },
          },
        }),
      },
    );
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const finding = report(dir, ['--all']).json.findings.find((f) => f.name === 'react-dom');
    assert.equal(finding.verdict, 'tooling');
    assert.match(finding.because, /peer|toolchain/);
  });

  await t.test('typescript is implied by a tsconfig, not by anything naming it', () => {
    const dir = makeProject(
      { name: 'fixture', engines: { node: '>=22.0.0' }, devDependencies: { typescript: '^5.0.0' } },
      { 'src/a.ts': 'export default 1;\n', 'tsconfig.json': '{}\n' },
    );
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.equal(report(dir, ['--all']).json.findings.find((f) => f.name === 'typescript').verdict, 'tooling');
  });

  await t.test('a <name>.config.js file implies <name>', () => {
    const dir = makeProject(
      { name: 'fixture', engines: { node: '>=22.0.0' }, devDependencies: { tailwindcss: '^3.0.0' } },
      { 'src/a.js': 'export default 1;\n', 'tailwind.config.js': 'module.exports = {};\n' },
    );
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.equal(report(dir, ['--all']).json.findings.find((f) => f.name === 'tailwindcss').verdict, 'tooling');
  });

  await t.test('a .<name>rc file implies <name>', () => {
    const dir = makeProject(
      { name: 'fixture', engines: { node: '>=22.0.0' }, devDependencies: { eslint: '^8.0.0' } },
      { 'src/a.js': 'export default 1;\n', '.eslintrc.json': '{}\n' },
    );
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.equal(report(dir, ['--all']).json.findings.find((f) => f.name === 'eslint').verdict, 'tooling');
  });
});

test('impact is attributed to the set it actually describes', async (t) => {
  const dir = makeProject(
    { name: 'fixture', engines: { node: '>=22.0.0' }, dependencies: { chalk: '^5.0.0', unused: '^1.0.0' } },
    {
      'src/a.js': "import chalk from 'chalk';\nexport default chalk;\n",
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { chalk: '^5.0.0', unused: '^1.0.0' } },
          'node_modules/chalk': { version: '5.0.0' },
          'node_modules/unused': { version: '1.0.0', dependencies: { 'unused-dep': '^1.0.0' } },
          'node_modules/unused-dep': { version: '1.0.0' },
        },
      }),
    },
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { json } = report(dir);

  await t.test('the removable set is counted on its own', () => {
    assert.equal(json.impact.removable.packages, 1);
  });

  await t.test('the unreferenced set is counted separately, not folded in', () => {
    assert.equal(json.impact.unreferenced.packages, 2);
  });

  await t.test('the headline sentence only claims the removable figure', () => {
    const { stdout } = run([dir]);
    assert.match(stdout, /Removing them takes 1 package out of node_modules/);
    assert.match(stdout, /would take a further 2 packages/);
  });
});
