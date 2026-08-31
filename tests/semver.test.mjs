import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, compareStrings, satisfies, lowerBound } from '../src/semver.mjs';

test('parse', async (t) => {
  await t.test('fills in omitted components', () => {
    assert.deepEqual(parse('18'), { major: 18, minor: 0, patch: 0, prerelease: [] });
    assert.deepEqual(parse('18.3'), { major: 18, minor: 3, patch: 0, prerelease: [] });
  });

  await t.test('accepts a v prefix and drops build metadata', () => {
    assert.deepEqual(parse('v1.2.3+build.7'), { major: 1, minor: 2, patch: 3, prerelease: [] });
  });

  await t.test('splits prerelease identifiers, keeping numerics numeric', () => {
    assert.deepEqual(parse('1.0.0-rc.2').prerelease, ['rc', 2]);
  });

  await t.test('returns null for things that are not versions', () => {
    for (const junk of ['latest', 'workspace:*', 'git+ssh://x', '', 'x.y.z']) {
      assert.equal(parse(junk), null, junk);
    }
  });
});

test('compare', async (t) => {
  await t.test('orders by major, minor, then patch', () => {
    assert.equal(compareStrings('2.0.0', '1.9.9'), 1);
    assert.equal(compareStrings('1.2.3', '1.2.10'), -1);
    assert.equal(compareStrings('1.2.3', '1.2.3'), 0);
  });

  await t.test('ranks a prerelease below its own release', () => {
    assert.equal(compareStrings('1.0.0-rc.1', '1.0.0'), -1);
    assert.equal(compareStrings('1.0.0-rc.1', '1.0.0-rc.2'), -1);
  });

  await t.test('ranks numeric prerelease identifiers below alphanumeric ones', () => {
    assert.equal(compareStrings('1.0.0-1', '1.0.0-alpha'), -1);
  });
});

test('satisfies', async (t) => {
  await t.test('handles bare comparators', () => {
    assert.equal(satisfies('20.12.0', '>=20.0.0'), true);
    assert.equal(satisfies('18.0.0', '>=20.0.0'), false);
    assert.equal(satisfies('20.0.0', '>20.0.0'), false);
  });

  await t.test('handles caret above and below 1.0.0', () => {
    assert.equal(satisfies('1.9.9', '^1.2.3'), true);
    assert.equal(satisfies('2.0.0', '^1.2.3'), false);
    assert.equal(satisfies('0.2.9', '^0.2.3'), true);
    assert.equal(satisfies('0.3.0', '^0.2.3'), false);
    assert.equal(satisfies('0.0.4', '^0.0.3'), false);
  });

  await t.test('handles tilde', () => {
    assert.equal(satisfies('1.2.9', '~1.2.3'), true);
    assert.equal(satisfies('1.3.0', '~1.2.3'), false);
  });

  await t.test('handles wildcards', () => {
    assert.equal(satisfies('1.99.0', '1.x'), true);
    assert.equal(satisfies('2.0.0', '1.x'), false);
    assert.equal(satisfies('42.0.0', '*'), true);
  });

  await t.test('handles hyphen ranges', () => {
    assert.equal(satisfies('1.5.0', '1.2.3 - 2.3.4'), true);
    assert.equal(satisfies('2.3.5', '1.2.3 - 2.3.4'), false);
  });

  await t.test('handles intersection and union', () => {
    assert.equal(satisfies('20.1.0', '>=20.0.0 <21.0.0'), true);
    assert.equal(satisfies('21.0.0', '>=20.0.0 <21.0.0'), false);
    assert.equal(satisfies('22.5.0', '^18.0.0 || ^20.0.0 || >=22'), true);
    assert.equal(satisfies('19.0.0', '^18.0.0 || ^20.0.0 || >=22'), false);
  });

  await t.test('is false rather than throwing for junk', () => {
    assert.equal(satisfies('not-a-version', '>=1'), false);
    assert.equal(satisfies('1.0.0', 'not-a-range!!'), false);
  });
});

test('lowerBound is the floor a recommendation has to clear', async (t) => {
  await t.test('reads a simple floor', () => {
    assert.equal(lowerBound('>=18.0.0'), '18.0.0');
    assert.equal(lowerBound('^20.9.0'), '20.9.0');
    assert.equal(lowerBound('~18.12.1'), '18.12.1');
  });

  await t.test('takes the lowest alternative in a union, not the first', () => {
    assert.equal(lowerBound('>=22 || ^18.0.0'), '18.0.0');
  });

  await t.test('normalises partial versions', () => {
    assert.equal(lowerBound('18'), '18.0.0');
    assert.equal(lowerBound('18.x'), '18.0.0');
  });

  await t.test('returns null when the range admits anything', () => {
    assert.equal(lowerBound('*'), null);
    assert.equal(lowerBound('<20.0.0'), null);
  });
});
