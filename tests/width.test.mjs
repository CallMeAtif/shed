import test from 'node:test';
import assert from 'node:assert/strict';
import { stringWidth, pad, truncate } from '../src/render/width.mjs';

const ESC = '\u001b';
const ZWJ = '\u200d';

test('stringWidth', async (t) => {
  await t.test('counts ascii as one column each', () => {
    assert.equal(stringWidth('shed'), 4);
  });

  await t.test('ignores ANSI escape sequences', () => {
    assert.equal(stringWidth(`${ESC}[31mred${ESC}[39m`), 3);
  });

  await t.test('counts CJK as two columns', () => {
    assert.equal(stringWidth('依存'), 4);
  });

  await t.test('counts an emoji with a variation selector once', () => {
    assert.equal(stringWidth('⚠️'), 2);
  });

  await t.test('counts a ZWJ family sequence as a single cluster', () => {
    assert.equal(stringWidth(`\u{1f468}${ZWJ}\u{1f469}${ZWJ}\u{1f467}`), 2);
  });

  await t.test('ignores combining marks', () => {
    assert.equal(stringWidth('é'), 1);
  });

  await t.test('is zero for the empty string', () => {
    assert.equal(stringWidth(''), 0);
  });
});

test('pad aligns by display width, not code units', () => {
  assert.equal(pad('依', 4), '依  ');
  assert.equal(pad('ab', 4, 'right'), '  ab');
});

test('truncate never splits a grapheme cluster', () => {
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 10), 'abc');
});
