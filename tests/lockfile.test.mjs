import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNpmLock, resolveFrom, removalImpact } from '../src/lockfile/npm.mjs';

/**
 * A lockfile shaped like the real thing:
 *   cors  -> vary
 *   helmet-> vary            (shared, so removing cors must not claim vary)
 *   uuid  -> (nothing)
 *   express -> body-parser -> bytes
 *   bcrypt (hasInstallScript)
 */
const LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': {
      dependencies: { cors: '^2.8.5', helmet: '^8.0.0', uuid: '^9.0.0', express: '^4.0.0' },
      devDependencies: { bcrypt: '^5.0.0' },
    },
    'node_modules/cors': { version: '2.8.5', dependencies: { vary: '^1.1.2' } },
    'node_modules/helmet': { version: '8.0.0', dependencies: { vary: '^1.1.2' } },
    'node_modules/vary': { version: '1.1.2' },
    'node_modules/uuid': { version: '9.0.0' },
    'node_modules/express': { version: '4.0.0', dependencies: { 'body-parser': '^1.0.0' } },
    'node_modules/body-parser': { version: '1.0.0', dependencies: { bytes: '^3.0.0' } },
    'node_modules/bytes': { version: '3.0.0' },
    'node_modules/bcrypt': { version: '5.0.0', hasInstallScript: true, dev: true },
  },
});

const { lock } = parseNpmLock(LOCK);

test('parseNpmLock', async (t) => {
  await t.test('reads every package and the root dependencies', () => {
    assert.equal(lock.nodes.size, 8);
    assert.deepEqual(lock.roots.sort(), ['bcrypt', 'cors', 'express', 'helmet', 'uuid']);
  });

  await t.test('keeps scoped names intact', () => {
    const { lock: scoped } = parseNpmLock(JSON.stringify({
      lockfileVersion: 3,
      packages: { '': {}, 'node_modules/@babel/core': { version: '7.0.0' } },
    }));
    assert.equal(scoped.nodes.get('node_modules/@babel/core').name, '@babel/core');
  });

  await t.test('records install scripts, which are the supply-chain risk', () => {
    assert.equal(lock.nodes.get('node_modules/bcrypt').hasInstallScript, true);
    assert.equal(lock.nodes.get('node_modules/cors').hasInstallScript, false);
  });

  await t.test('refuses lockfile v1 rather than half-parsing it', () => {
    const { lock: old, reason } = parseNpmLock(JSON.stringify({ lockfileVersion: 1, dependencies: {} }));
    assert.equal(old, null);
    assert.match(reason, /version 1/);
  });

  await t.test('reports malformed JSON instead of throwing', () => {
    const { lock: bad, reason } = parseNpmLock('{ nope');
    assert.equal(bad, null);
    assert.match(reason, /not valid JSON/);
  });
});

test('resolveFrom walks outward like Node does', async (t) => {
  const nested = parseNpmLock(JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { a: '1' } },
      'node_modules/a': { version: '1', dependencies: { c: '1' } },
      'node_modules/a/node_modules/c': { version: '2' },
      'node_modules/c': { version: '1' },
    },
  })).lock;

  await t.test('prefers a nested copy over the hoisted one', () => {
    assert.equal(resolveFrom(nested, 'node_modules/a', 'c'), 'node_modules/a/node_modules/c');
  });

  await t.test('falls back to the hoisted copy', () => {
    assert.equal(resolveFrom(nested, '', 'c'), 'node_modules/c');
  });

  await t.test('returns null for something not in the tree', () => {
    assert.equal(resolveFrom(nested, '', 'missing'), null);
  });
});

test('removalImpact counts only what actually leaves', async (t) => {
  await t.test('a leaf dependency removes just itself', () => {
    const { packages } = removalImpact(lock, ['uuid']);
    assert.deepEqual(packages.map((p) => p.name), ['uuid']);
  });

  await t.test('a shared transitive dependency is not claimed', () => {
    // cors and helmet both depend on vary, so removing cors alone keeps vary.
    const { packages } = removalImpact(lock, ['cors']);
    assert.deepEqual(packages.map((p) => p.name), ['cors']);
  });

  await t.test('but removing both owners does free the shared one', () => {
    const { packages } = removalImpact(lock, ['cors', 'helmet']);
    assert.deepEqual(packages.map((p) => p.name), ['cors', 'helmet', 'vary']);
  });

  await t.test('the whole chain below a dependency comes with it', () => {
    const { packages } = removalImpact(lock, ['express']);
    assert.deepEqual(packages.map((p) => p.name), ['body-parser', 'bytes', 'express']);
  });

  await t.test('install scripts are reported separately', () => {
    const { installScripts } = removalImpact(lock, ['bcrypt']);
    assert.deepEqual(installScripts.map((p) => p.name), ['bcrypt']);
  });

  await t.test('removing nothing frees nothing', () => {
    assert.deepEqual(removalImpact(lock, []).packages, []);
  });
});
