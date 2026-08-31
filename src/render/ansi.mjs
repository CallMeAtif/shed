/**
 * Terminal colour, without chalk.
 *
 * `util.styleText` (Node v20.12, stable v22.17) does the escape-code work. What a
 * colour package actually sells on top of that is the *decision* of whether to
 * colour at all, so that is what this module owns.
 */
import { styleText, stripVTControlCharacters } from 'node:util';

/**
 * Resolve whether colour should be emitted for a stream.
 *
 * Precedence follows the informal cross-ecosystem contract:
 *   NO_COLOR (any value, even empty) always wins - https://no-color.org
 *   FORCE_COLOR=0 disables, any other value enables
 *   otherwise: colour only on a TTY that is not TERM=dumb
 *
 * @param {{ isTTY?: boolean }} stream
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function colorEnabled(stream, env = process.env) {
  if (env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0';
  if (!stream?.isTTY) return false;
  return env.TERM !== 'dumb';
}

/**
 * Build a painter. When colour is off every style is the identity function, so
 * call sites never branch on it.
 *
 * @param {boolean} enabled
 */
export function createPainter(enabled) {
  /**
   * @param {string|string[]} format a `util.styleText` format name or list
   * @param {string} text
   */
  const paint = (format, text) => (enabled ? styleText(format, text) : text);

  return {
    enabled,
    paint,
    red: (t) => paint('red', t),
    green: (t) => paint('green', t),
    yellow: (t) => paint('yellow', t),
    blue: (t) => paint('blue', t),
    cyan: (t) => paint('cyan', t),
    magenta: (t) => paint('magenta', t),
    dim: (t) => paint('dim', t),
    bold: (t) => paint('bold', t),
    underline: (t) => paint('underline', t),
    boldRed: (t) => paint(['bold', 'red'], t),
    boldGreen: (t) => paint(['bold', 'green'], t),
    boldYellow: (t) => paint(['bold', 'yellow'], t),
  };
}

/** Re-exported so the rest of the tool never imports node:util for this alone. */
export const stripAnsi = stripVTControlCharacters;
