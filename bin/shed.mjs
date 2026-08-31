#!/usr/bin/env node
/**
 * Entry point. Deliberately thin: everything testable lives in src/main.mjs,
 * which takes its IO as a parameter rather than reaching for process.
 */
import { main } from '../src/main.mjs';

process.exitCode = main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  columns: process.stdout.columns ?? 0,
});
