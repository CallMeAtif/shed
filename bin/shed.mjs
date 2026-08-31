#!/usr/bin/env node
/**
 * Entry point. Deliberately thin: everything testable lives in src/main.mjs,
 * which takes its IO as a parameter rather than reaching for process.
 */
import { main } from '../src/main.mjs';

// A consumer that exits early (`| head`, `| grep -q`) closes the pipe under us.
// That is normal for a CLI and must not print a stack trace; exit quietly the way
// every other well-behaved tool does.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });
}

process.exitCode = main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  columns: process.stdout.columns ?? 0,
});
