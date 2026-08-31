import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, helpText } from '../src/cli.mjs';
import { UsageError } from '../src/errors.mjs';

test('command selection', async (t) => {
  await t.test('defaults to scan', () => {
    assert.equal(parse([]).command, 'scan');
    assert.equal(parse(['.']).command, 'scan');
  });

  await t.test('a leading known word is the command, not a directory', () => {
    const parsed = parse(['why', 'chalk']);
    assert.equal(parsed.command, 'why');
    assert.deepEqual(parsed.positionals, ['chalk']);
  });

  await t.test('an unknown leading word is a directory', () => {
    const parsed = parse(['./some/dir']);
    assert.equal(parsed.command, 'scan');
    assert.deepEqual(parsed.positionals, ['./some/dir']);
  });
});

test('flags', async (t) => {
  await t.test('booleans default to false and set to true', () => {
    assert.equal(parse([]).flags.json, false);
    assert.equal(parse(['--json']).flags.json, true);
  });

  await t.test('short flags work', () => {
    assert.equal(parse(['-q']).flags.quiet, true);
    assert.equal(parse(['-a']).flags.all, true);
  });

  await t.test('string flags take a value in either form', () => {
    assert.equal(parse(['--node', '20.0.0']).flags.node, '20.0.0');
    assert.equal(parse(['--node=20.0.0']).flags.node, '20.0.0');
  });

  await t.test('--ignore repeats into an array', () => {
    assert.deepEqual(parse(['--ignore', 'a', '--ignore', 'b']).flags.ignore, ['a', 'b']);
  });

  await t.test('--no-color negates, which parseArgs cannot do on its own', () => {
    assert.equal(parse(['--no-color']).flags.color, false);
    assert.equal(parse(['--color']).flags.color, true);
  });

  await t.test('last flag wins', () => {
    assert.equal(parse(['--color', '--no-color']).flags.color, false);
    assert.equal(parse(['--no-color', '--color']).flags.color, true);
  });

  await t.test('colour is undefined when unspecified, so auto-detection can run', () => {
    assert.equal(parse([]).flags.color, undefined);
  });

  await t.test('flags and positionals interleave', () => {
    const parsed = parse(['scan', '--json', './dir', '-q']);
    assert.equal(parsed.command, 'scan');
    assert.deepEqual(parsed.positionals, ['./dir']);
    assert.equal(parsed.flags.json, true);
    assert.equal(parsed.flags.quiet, true);
  });
});

test('usage errors', async (t) => {
  await t.test('an unknown flag is a UsageError, not a crash', () => {
    assert.throws(() => parse(['--nonsense']), UsageError);
  });

  await t.test('a string flag with no value is a UsageError', () => {
    assert.throws(() => parse(['--node']), UsageError);
  });
});

test('help text is generated from the option table', async (t) => {
  const text = helpText('9.9.9');

  await t.test('includes the version', () => {
    assert.match(text, /shed 9\.9\.9/);
  });

  await t.test('lists every command', () => {
    for (const command of ['scan', 'why', 'list']) assert.match(text, new RegExp(`\\b${command}\\b`));
  });

  await t.test('lists every option, so help cannot drift from the parser', () => {
    for (const flag of ['--json', '--fix', '--node', '--ignore', '--all', '--quiet', '--help', '--version']) {
      assert.ok(text.includes(flag), `help is missing ${flag}`);
    }
  });

  await t.test('shows negatable flags in their negatable form', () => {
    assert.match(text, /--\[no-\]color/);
  });

  await t.test('documents the exit codes', () => {
    assert.match(text, /EXIT CODES/);
  });
});
