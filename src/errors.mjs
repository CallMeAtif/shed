/**
 * Position-aware diagnostics.
 *
 * Every hand-rolled parser in this project reports failures through `Diagnostic`
 * so that a user always gets `file:line:col`, the offending source line, and a
 * caret - never a bare stack trace.
 */

/** @typedef {{ file: string, line: number, col: number, offset: number }} Position */

export class Diagnostic extends Error {
  /**
   * @param {string} message
   * @param {Position} pos
   * @param {string} [sourceLine] the raw text of `pos.line`, used to draw the caret
   */
  constructor(message, pos, sourceLine) {
    super(message);
    this.name = 'Diagnostic';
    this.pos = pos;
    this.sourceLine = sourceLine;
  }

  /** `path/to/file.js:14:22: unterminated template literal` plus a caret frame. */
  format() {
    const { file, line, col } = this.pos;
    const head = `${file}:${line}:${col}: ${this.message}`;
    if (this.sourceLine === undefined) return head;
    const gutter = String(line);
    const pad = ' '.repeat(gutter.length);
    // Tabs in the source would desynchronise the caret, so render them as one space.
    const text = this.sourceLine.replace(/\t/g, ' ');
    return [
      head,
      `${pad} |`,
      `${gutter} | ${text}`,
      `${pad} | ${' '.repeat(Math.max(0, col - 1))}^`,
    ].join('\n');
  }
}

/**
 * Extract the raw text of a 1-based line number, for caret frames.
 * @param {string} source
 * @param {number} line
 * @returns {string|undefined}
 */
export function lineText(source, line) {
  if (line < 1) return undefined;
  let start = 0;
  for (let n = 1; n < line; n++) {
    const nl = source.indexOf('\n', start);
    if (nl === -1) return undefined;
    start = nl + 1;
  }
  const end = source.indexOf('\n', start);
  const raw = end === -1 ? source.slice(start) : source.slice(start, end);
  return raw.endsWith('\r') ? raw.slice(0, -1) : raw;
}

/** Raised for bad CLI usage; the entry point maps it to exit code 2. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}
