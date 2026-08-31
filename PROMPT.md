# ZERO DEPENDENCY HACKATHON — OPERATOR PROMPT
(paste everything below the line into a fresh Claude Code session, in an empty git repo,
with the full event context pack pasted immediately after it)

---

You are a principal engineer building a competition submission. You have a hard deadline
and a fixed rubric. Optimise for the rubric, not for elegance you can't ship.

## 0. NON-NEGOTIABLES — violating any of these forfeits the entry

1. `package.json` MUST contain `"dependencies": {}` and `"devDependencies": {}`. No exceptions.
   No `npm install`, ever. If you type `npm i`, you have lost.
2. Node built-ins only. Every import is `node:*` or a global. Pin `"engines": { "node": ">=22.17.0" }`
   and state the exact tested version in the README.
3. The tool NEVER spawns another program at runtime. No `child_process` calls to `git`, `npm`,
   `pnpm`, `node`, or anything else. Shelling out is a hidden dependency and is explicitly
   out of scope. Reading files those tools already wrote is fine and is the whole design.
4. The tool NEVER makes a network request. Fully offline. This is a feature — say so in the README.
5. Every line of code is written in this session. Nothing vendored, nothing pasted from a package.
   If anything is, it goes in STDLIB.md under a "Not written this weekend" heading.
6. No `any`-shaped slop. Plain `.mjs` ESM, JSDoc types where they clarify. No TypeScript build step.

## 1. WHAT YOU ARE BUILDING

**`shed`** — an offline dependency auditor that tells a JavaScript project which of its
dependencies the Node standard library has already replaced, and proves the claim.

Point it at a repo. It reads `package.json`, the lockfile, and the source tree, and prints:

- **Removable** — deps with a stdlib equivalent available on *this project's* Node version,
  each with the exact replacement API, the Node version it landed in, and every source
  site that imports it.
- **Removable after a bump** — deps whose stdlib replacement exists, but above the project's
  declared `engines.node` floor. Reports the bump needed.
- **Blocked** — deps with a stdlib equivalent that the project uses in a way the stdlib
  doesn't cover (e.g. `chalk.level` detection, `minimist` with type coercion). Naming these
  honestly is worth more than inflating the removable count.
- **Unknown** — everything else, listed, not guessed about.

And it quantifies the win, entirely from the lockfile, with no network:
transitive packages removed, install-script-bearing packages removed, weekly-download
total retired, node_modules bytes reclaimed.

Exit codes: `0` clean, `1` removable deps found (so it works as a CI gate), `2` usage error.
Flags: `--json`, `--fix`, `--min-severity`, `--ignore`, `--node <version>`, `--no-color`, `--quiet`.

**`--fix` writes codemods only for the mechanically safe swaps** (`uuid.v4()` →
`crypto.randomUUID()`, `rimraf(p)` → `fs.rm(p, {recursive:true, force:true})`,
`chalk.red(x)` → `styleText('red', x)`). It refuses anything ambiguous and says why.
It must be idempotent, and it must never touch a file it did not parse cleanly.

### Why this wins each rubric line — keep this in view while building

- **Functionality 35%** — a real person runs this on a real repo and deletes real packages
  today. Test it on three actual `package.json` files you find on this machine and put the
  output in the README.
- **Zero-Dep Craft 30%** — the tool's subject *is* dependency removal, and its internals
  hand-roll five things people import. STDLIB.md writes itself and will be long and true.
- **Code Quality 25%** — the parsers are the code. They get position-tracking errors and a
  table-driven test corpus of ugly inputs. See §3.
- **Innovation 10%** — it is the hackathon's own thesis, executable.

## 1a. CLOCK — freeze is 31 Aug 2026 18:00 UTC = 23:30 IST tonight

You have ~10 hours from 13:30 IST. Budget it. These are wall-clock targets, not estimates:

| By (IST) | State |
|---|---|
| 14:15 | Phase 1 gate: skeleton, empty manifest, `make test` green on one smoke test, first commit |
| 16:30 | Phase 2 gate: import scanner passes every ugly fixture in §3 |
| 17:45 | Phase 3 gate: knowledge base + semver satisfier, correct verdicts on a real repo |
| 18:45 | Phase 4 gate: CLI surface, colour, `--json`, exit codes. **P0 COMPLETE — tag it, push it** |
| 20:30 | P1: `package-lock.json` reader + impact numbers + `--fix` for the three safe swaps |
| 21:15 | P1 stretch: yarn.lock, then pnpm-lock.yaml — cut either without hesitation |
| 22:15 | Docs: README, STDLIB.md, deps-proof.txt, `.zero-dep.toml`. Do not compress this |
| 22:45 | Demo video recorded |
| 23:00 | Submitted. Half an hour of slack is not optional — it is the plan |

**Push a complete, submittable entry at 18:45 IST.** Everything after that is improving a
thing that is already submitted. Never be in a position where the deadline catches you
with nothing pushed.

Two admin items to confirm are done before you write code, they take two minutes each:
registration at https://tally.so/r/2EY7zD, and the repo public with an MIT LICENSE file.

## 2. SCOPE LADDER — build strictly in order, stop when the clock in §1a says stop

**P0 — must ship, and must be pushed by 18:45 IST. Nothing else starts until all of this runs.**
- `package.json` reader (hand-rolled JSON is NOT needed — `JSON.parse` is stdlib, use it).
- Source scanner: recursive walk with `fs.globSync` over `**/*.{js,mjs,cjs,jsx,ts,tsx}`,
  respecting `.gitignore` (parse it yourself — it is a real format with negation and
  directory rules) and always skipping `node_modules`.
- **Import extractor: a real character-level scanner, not a regex.** It must correctly skip
  line comments, block comments, string literals with escapes, template literals *including
  nested `${}` with strings inside*, and regex literals disambiguated from division. It
  extracts static `import`/`export from`, `require()`, and dynamic `import()`. It records
  byte offset + line + column for every hit. This scanner is the heart of the submission's
  Code Quality score — write it first, test it hardest.
- Knowledge base: a single declarative table of ~30 package→stdlib mappings (seed in §7),
  each entry `{ pkg, replacement, api, since, confidence, caveats[], weeklyDownloads }`.
  Data, not code. One object literal a judge can read in thirty seconds.
- Version gate: hand-rolled semver comparator + range satisfier (`^`, `~`, `>=`, `x`,
  hyphen ranges, `||`). Enough to answer "does this project's Node floor include `since`?"
  Document precisely which grammar you support and which you don't.
- Terminal renderer: raw ANSI, honour `NO_COLOR`, `FORCE_COLOR`, and `stdout.isTTY`.
  Width-aware column alignment using your own display-width function (Node has no
  `stringWidth` — Bun does; that gap is a STDLIB.md entry).
- `--json` output with a stable, documented schema.
- `node:test` suite covering the scanner's ugly cases and the semver ranges.
- README.md, STDLIB.md, `.zero-dep.toml` (track A), deps-proof.txt, Makefile.

**P1 — expected to ship. You have the hours for this; see the clock in §1a.**
- Lockfile readers, in this order of value: `package-lock.json` (JSON, easy, gives the
  transitive graph and `hasInstallScript`), `yarn.lock` v1 (a bespoke format — hand-rolled
  tokenizer, genuinely impressive), `pnpm-lock.yaml` (a hand-rolled **subset** YAML parser;
  be explicit in the README that it is a subset targeting this one file shape, not a
  YAML implementation).
- The impact numbers: transitive count, install-script count, bytes.
- `--fix` codemods for the three safe swaps.

**P2 — only if genuinely everything above is done.**
- Cross-run cache in `node:sqlite` (RC, v24.15+, no flag) so repeat scans of large repos
  are instant. Mention the RC status in the README.
- A `shed why <pkg>` subcommand explaining a single verdict in full.

**Cut before you cut P0 quality:** P2 entirely, then pnpm/yarn lock support, then `--fix`.

## 3. HOW THE PARSERS MUST BEHAVE

Every hand-rolled parser in this repo obeys the same three rules:

1. **Position from character one.** Track `offset`, `line`, `col` as you scan. Retrofitting
   this is miserable and you will not have time.
2. **Errors are values with a location and a caret.** `foo.js:14:22: unterminated template
   literal`, plus the offending source line and a `^`. Never throw a bare `Error` at a user.
3. **Malformed input degrades, never crashes.** A file that fails to parse is reported as
   skipped-with-reason and the scan continues. One bad file must not kill a 4000-file run.

Test corpus lives in `tests/fixtures/` and must include, at minimum:
a regex literal containing a quote (`/['"]/g`), a division that looks like a regex,
a template literal nesting a template literal, `require` inside a comment, `require` inside
a string, a BOM, CRLF line endings, an unterminated string, a scoped package
(`@scope/name/sub/path`), a bare `import 'node:fs'`, and a file that is 100% comments.
Each one is a named subtest. If a fixture fails, the tool is wrong, not the fixture.

## 4. BONUS CHALLENGES — take these two, skip the other two

- **Package Killer (+3)** — you are killing `chalk` (319.8M weekly), `minimist` (80.5M weekly),
  and `semver` — *and* the tool's internals reimplement them rather than describing them.
  Document all three in STDLIB.md with the download numbers.
- **STDLIB Log (+3)** — §7 already gives you more than the ten required. Every entry needs a
  one-line rationale that says something true and specific. Empty bullets score zero.
- **Reproducible Build (+5)** — take this ONLY if P0 and P1 are done. `make build` concatenates
  the modules in sorted order into `dist/shed.mjs` with no timestamps, no absolute paths, and
  a fixed banner. Build twice, publish both `sha256` values in the README.
- **Single File (+5)** — do NOT take this. It fights the parser structure and costs more than
  five points' worth of Code Quality. If you disagree after P1 is done, revisit; not before.

## 5. WORKFLOW — phases with gates. Do not skip a gate.

1. **Skeleton (30 min).** Repo layout, `package.json` with empty manifests, Makefile,
   `node --test` wired, one passing smoke test, first commit.
   *Gate:* `make test` passes on a clean clone.
2. **Scanner (longest phase).** The import extractor + its fixture corpus, TDD: write the
   ugly fixture first, watch it fail, make it pass.
   *Gate:* every fixture in §3 passes.
3. **Knowledge base + version gate.** The mapping table and the semver satisfier.
   *Gate:* `shed` produces a correct verdict list on a real repo you did not write.
4. **Renderer + CLI surface.** Flags, exit codes, colour, `--json`.
   *Gate:* `NO_COLOR=1 shed --json . | node -e '...'` parses; exit codes are correct.
5. **P1 items**, in the stated order, each behind its own gate.
6. **Docs (reserve 45 minutes, do not compress this).** README, STDLIB.md, deps-proof.txt,
   `.zero-dep.toml`. Docs are 30% of the score and are the first thing a judge reads.
7. **Demo video script.** Write the 5-minute beat sheet as a file: show the empty manifest
   first, run it on a real repo, show a package actually being deleted, show the tests,
   show `make build` twice with matching hashes if you took that bonus.

At every gate, if it fails, fix it before moving on. State honestly in the final summary
what you cut and why.

## 6. BANNED — these are how entries lose

- `npm install` anything. Including "just for tests" — `node:test` is in the box.
- Regex-based import extraction. A regex cannot handle template literals or regex literals,
  a judge will find the case in ninety seconds, and the whole submission reads as a toy.
- Spawning `git`, `npm`, or `pnpm` to get information you could read off disk.
- Any network call, including a "just to enrich download counts" fetch. Counts are static
  data in the knowledge base, sourced and dated in a comment.
- Inflating the removable list with mappings that don't actually hold. One wrong "you can
  delete this" costs more trust than ten correct ones earn.
- Claiming a lockfile format works when you only tested the happy path. Say which shapes
  you support.
- A README that doesn't state limits. Write the "Limits" section *before* you're proud of
  the tool.

## 7. STDLIB.md SEED — expand each with a one-line rationale, delete what you don't use

Substitutions the tool *makes for its users* (the knowledge base):
| Package | Weekly | Stdlib replacement | Since |
|---|---|---|---|
| chalk | 319.8M | `util.styleText()` | v20.12, stable v22.17 |
| readable-stream | 185.6M | `node:stream` + `stream/promises` | stable |
| form-data | 100.9M | global `FormData` + `fetch` | v18 |
| minimist | 80.5M | `util.parseArgs()` | v18.3 |
| node-fetch / axios | — | global `fetch` (Undici) | v18 |
| mocha / jest / tap | — | `node:test` + `node:assert` | v20 |
| nodemon | 7.8M | `node --watch` | v18.11 |
| dotenv | — | `process.loadEnvFile()` / `--env-file` | v20.6 |
| strip-ansi | — | `util.stripVTControlCharacters()` | stable |
| uuid | — | `crypto.randomUUID()` | stable |
| glob | — | `fs.glob()` / `fs.globSync()` | v22 |
| ws | — | global `WebSocket` | v22 |
| better-sqlite3 | — | `node:sqlite` | RC v24.15 / v25.7 |
| rimraf | — | `fs.rm({recursive, force})` | v14.14 |
| mkdirp | — | `fs.mkdir({recursive})` | v10.12 |
| debug | — | `util.debuglog()` | stable |
| pkg / nexe | — | `node:sea` | experimental — flag this |

Substitutions **you made building the tool** — these are the ones judges weigh hardest,
because they are yours:
- `commander` / `yargs` → `util.parseArgs` plus a hand-written subcommand and coercion layer.
  parseArgs is string-and-boolean only by design; the rest is ~80 lines.
- `semver` → hand-rolled comparator and range satisfier. No stdlib answer exists; document
  the exact grammar subset supported.
- `js-yaml` → hand-rolled subset YAML reader for `pnpm-lock.yaml`. Node ships no YAML at all.
  State plainly that it parses one file shape, not YAML.
- `@yarnpkg/lockfile` → hand-rolled tokenizer for yarn.lock v1's bespoke format.
- `ignore` → hand-rolled `.gitignore` matcher (negation, trailing slash, `**`).
- `string-width` / `wrap-ansi` → hand-rolled display-width function. Bun ships
  `Bun.stringWidth`; Node does not. This is a genuine stdlib gap — name it as one.
- `cli-table3` → hand-rolled width-aware table renderer over the above.
- `p-limit` → hand-rolled promise pool over `Promise.race`.
- `chalk` (for the tool's *own* output) → `util.styleText` with `NO_COLOR` + `isTTY` handling.
- `fast-glob` → `fs.globSync`.
- `jest` → `node:test` + `node:assert/strict`, subtests via `t.test`.
- `lodash.get` / `deepmerge` → optional chaining and `structuredClone`.

Add a final honest section: **"Where the standard library ran out."** List every place you
wanted an API and Node didn't have one, and what you wrote instead. That section is the
single highest-signal thing in the document.

## 8. DEFINITION OF DONE

- [ ] `git clone && make` produces a runnable artifact with zero installs.
- [ ] `make test` green, and the count of tests is in the README.
- [ ] `cat package.json` shows empty `dependencies` and `devDependencies`.
- [ ] `deps-proof.txt` contains real command output proving it (e.g. `npm ls --all` on a
      clean clone, plus `cat package.json`), with the date.
- [ ] Tool has been run against at least three real third-party repos on this machine, and
      one output transcript is in the README.
- [ ] README states: what it does, one-command run, the concurrency/IO model, and an
      explicit **Limits** section naming every format subset and known false-negative class.
- [ ] STDLIB.md has ≥10 non-trivial substitutions, each with a rationale, plus the
      "Where the standard library ran out" section.
- [ ] `.zero-dep.toml` names track A and a one-line pitch.
- [ ] OSI licence (MIT), repo public.
- [ ] Demo beat sheet written, opening on the empty manifest.

Start with §5 phase 1. Report at every gate. Do not ask me for permission between phases —
run to the next gate and tell me the result.
