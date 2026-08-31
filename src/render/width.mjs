/**
 * Terminal display width, without string-width.
 *
 * Bun ships `Bun.stringWidth`; Node ships nothing equivalent, so this is one of
 * the genuine gaps in the standard library. What Node *does* give us is
 * `Intl.Segmenter` (ECMAScript, built in), which handles grapheme clustering -
 * the hard half of the problem - so all that remains is an East Asian width
 * table and the zero-width ranges.
 */
import { stripAnsi } from './ansi.mjs';

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Code point ranges rendered two columns wide (Unicode East_Asian_Width W and F). */
const WIDE = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

/** Code point ranges that occupy no columns: combining marks, joiners, selectors. */
const ZERO = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a],
  [0x064b, 0x065f], [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x2060, 0x2064], [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xe0100, 0xe01ef],
];

/** @param {number} cp @param {number[][]} ranges */
function inRanges(cp, ranges) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid][0]) hi = mid - 1;
    else if (cp > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** @param {number} cp @returns {0|1|2} */
function codePointWidth(cp) {
  if (cp === 0x00) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0; // C0/C1 controls
  if (inRanges(cp, ZERO)) return 0;
  if (inRanges(cp, WIDE)) return 2;
  return 1;
}

/**
 * Width of a string in terminal columns, ignoring ANSI escapes.
 *
 * A grapheme cluster is measured by its widest code point, which is what makes
 * emoji-with-variation-selector and ZWJ sequences come out as one glyph rather
 * than a sum of their parts.
 *
 * @param {string} input
 * @returns {number}
 */
export function stringWidth(input) {
  const plain = stripAnsi(input);
  let total = 0;
  for (const { segment } of segmenter.segment(plain)) {
    // VS16 asks for emoji presentation, which every terminal renders two columns
    // wide even when the base code point is East Asian Neutral (U+26A0 warning sign
    // is width 1 bare, width 2 as an emoji).
    if (segment.includes('\uFE0F')) {
      total += 2;
      continue;
    }
    let w = 0;
    for (const ch of segment) w = Math.max(w, codePointWidth(ch.codePointAt(0)));
    total += w;
  }
  return total;
}

/**
 * Pad to `target` columns, measured in display width rather than code units.
 * @param {string} input
 * @param {number} target
 * @param {'left'|'right'} [align]
 */
export function pad(input, target, align = 'left') {
  const fill = ' '.repeat(Math.max(0, target - stringWidth(input)));
  return align === 'left' ? input + fill : fill + input;
}

/**
 * Truncate to `target` columns, appending an ellipsis when anything was cut.
 * Never splits a grapheme cluster.
 * @param {string} input
 * @param {number} target
 */
export function truncate(input, target) {
  if (stringWidth(input) <= target) return input;
  if (target <= 1) return '…'.slice(0, target);
  let out = '';
  let w = 0;
  for (const { segment } of segmenter.segment(stripAnsi(input))) {
    const sw = stringWidth(segment);
    if (w + sw > target - 1) break;
    out += segment;
    w += sw;
  }
  return out + '…';
}

/**
 * Wrap to `target` columns on word boundaries, measuring display width rather
 * than code units so CJK and emoji do not overflow the column.
 *
 * A word longer than the target is emitted on its own overlong line rather than
 * broken: file paths and API names are worse to read hyphenated than wide.
 *
 * @param {string} input
 * @param {number} target
 * @returns {string[]} one entry per line
 */
export function wrap(input, target) {
  const words = input.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines = [];
  let line = '';
  for (const word of words) {
    if (line === '') {
      line = word;
      continue;
    }
    if (stringWidth(line) + 1 + stringWidth(word) <= target) {
      line += ` ${word}`;
      continue;
    }
    lines.push(line);
    line = word;
  }
  lines.push(line);
  return lines;
}
