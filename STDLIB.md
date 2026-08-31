# STDLIB.md

Every place I would normally have typed `npm install`, and what I used instead.

`shed` is a tool *about* replacing packages with the standard library, so this
file is both the disclosure the rules ask for and a description of the product.
The list below is what building it actually cost.

**Nothing in this repository was vendored, copied, or written before the event.**
No third-party source is present in `src/`, `bin/`, `tools/` or `tests/`. There is
no dev-only test dependency either — Node ships `node:test`, so the exception the
rules allow was not needed.

---

## The substitutions

### 1. `commander` / `yargs` (130M + 80M weekly) → `util.parseArgs` + ~70 lines

**`src/cli.mjs`.** `parseArgs` (v18.3) tokenises and stops there — core has said
outright that it is deliberately minimal. What a CLI package sells on top is the
part I wrote: subcommand dispatch, enum validation with an error naming the
offending flag, and help text generated from the same option table the parser
uses, so the two can never drift.

**The thing I got wrong first.** I hand-wrote a `--no-color` shim that rewrote
`--no-color` into `--color=false` before handing it to `parseArgs`. It failed
immediately: in strict mode `parseArgs` rejects a value on a boolean option. The
fix was to delete all fifteen lines — `parseArgs` grew `allowNegative` in
**v22.4.0**, and it handles last-flag-wins correctly, which my shim did not. That
deletion is the single most on-theme commit in the repository.

### 2. `ignore` (200M+ weekly) → hand-rolled, `src/gitignore.mjs`

No stdlib answer, and no shortcut either: `.gitignore` looks like globbing and
isn't. Patterns without a slash match at any depth while patterns with one are
anchored; a trailing slash restricts a rule to directories *but still ignores
everything beneath it*; `!` un-ignores; and the **last** matching rule wins, not
the first. All four are load-bearing in real repositories and all four are
implemented, with 24 tests.

The bug worth recording: my first version skipped directory-only rules when
testing a file, so `dist/` correctly ignored the `dist` directory and then failed
to ignore `dist/app.js` when asked about it directly. Fixed by compiling two
regexes per rule — one matching the path itself, one matching anything beneath
it.

### 3. `semver` (250M+ weekly) → hand-rolled, `src/semver.mjs`

The standard library has nothing here, and this is the calculation the whole tool
rests on: *is this project's declared Node floor at least the version where the
replacement API landed?* Implemented from the spec — comparators, `^`, `~`,
wildcards, hyphen ranges, intersection, `||` union, and full prerelease
precedence including the rule that numeric identifiers rank below alphanumeric.

**The bug that mattered most.** Splitting a range on whitespace made `">= 18.0.0"
— with a space, which npm accepts and manifests use — parse as the two tokens
`>=` and `18.0.0`. `>=` alone is not a comparator, so the whole range failed,
`lowerBound()` returned null, and the tool silently fell back to the *running*
Node instead of the declared floor. A Node 18 project was told to delete `chalk`
and `glob` for APIs that do not exist on 18, and the CI gate flipped with it.
One space, no diagnostic, and the failure landed in the unsafe direction — the
exact opposite of the bias this tool claims. Operators are now bound to their
version before anything else happens.

`lowerBound()` is the function that actually matters, and it does not exist in
the `semver` package's shape: given `">=22 || ^18.0.0"` it returns `18.0.0`,
because a project declaring that range can still be run on 18, so 18 is what a
recommendation must clear. Taking the *first* alternative rather than the lowest
would have made `shed` unsafe.

### 4. `string-width` / `wrap-ansi` (100M+ weekly) → `Intl.Segmenter`, `src/render/width.mjs`

**A real gap.** Bun ships `Bun.stringWidth`; Node ships nothing equivalent. But
`Intl.Segmenter` is in the language and handles grapheme clustering — the hard
half — so what remained was an East Asian width table and the zero-width ranges.

A ZWJ family emoji is one cluster of width 2, not three of width 2 each. And
`⚠️` is U+26A0 (East Asian Neutral, width 1) plus VS16, which every terminal
renders two columns wide — a rule you only find by having the test fail.

### 5. `chalk` / `picocolors` (319.8M + 180M weekly) → `util.styleText`, `src/render/ansi.mjs`

`styleText` (v20.12, stable v22.17) emits the escape codes. What a colour package
really sells is the *decision* of whether to colour at all, so that is what this
module owns: `NO_COLOR` wins over everything including an explicit `--color`,
then the flag, then `FORCE_COLOR`, then TTY detection with `TERM=dumb` excluded. When colour is off every style is the
identity function, so no call site branches on it.

**The gotcha that cost an hour.** `styleText` validates the target stream by
default and silently returns *plain text* when `process.stdout` is not a TTY.
That is a sensible default for a runtime API and a trap for a tool that does its
own colour policy: `shed --color | cat` emitted nothing, while the undocumented
`FORCE_COLOR=1` still worked, so the documented flag was the broken one. The fix
is `{ validateStream: false }` — decide the policy yourself, then tell the
standard library to stop deciding it for you. Nothing in the docs makes that
consequence obvious; it took a judge piping the output to find it.

### 6. `esbuild` / `rollup` → hand-rolled bundler, `tools/bundle.mjs`

`make build` inlines the module graph into one `dist/shed.mjs`. Tractable only
because the input is not arbitrary JavaScript — it is this repository, which uses
a narrow ESM subset (single-line named imports, named exports, no cycles). The
bundler *asserts* that subset and fails loudly rather than emitting something
subtly wrong.

Each module becomes a lazily-initialised function returning its exports. That
choice is what makes the transform purely syntactic: separate function scopes
mean identifier collisions are impossible, so no scope analysis and no renaming.
Necessary, as it turned out — `parse` is exported by both `cli.mjs` and
`semver.mjs`, and naive concatenation would have silently shadowed one.

Two bugs found by running the output: builtin imports hoisted verbatim declared
`join` twice, and the entry point's own shebang ended up on line 2,559. Both are
fixed and both are why "the build script ran" is not the same as "the artifact
works".

### 7. `mocha` / `jest` / `vitest` → `node:test` + `node:assert/strict`

252 tests, no runner installed. Nested `t.test()` subtests give the same
structure `describe`/`it` would. The one thing genuinely missing versus Jest is
module mocking, which this codebase does not need — every module takes its
dependencies as parameters, and `main()` takes its IO as an argument specifically
so the end-to-end tests can capture stdout without touching `process`.

### 8. `glob` / `fast-glob` (180M + 90M weekly) → `fs.globSync` **and** a manual walk

Two different answers for two different jobs, which is the honest version.

`tools/deps-proof.mjs` uses `fs.globSync` (v22) directly — a flat pattern over a
known-small tree.

`src/project.mjs` does **not**, and walks with `readdirSync({ withFileTypes: true })`
instead, because it needs to prune directories *during* traversal. On a repo with
`node_modules` present, filtering a full listing afterwards means walking tens of
thousands of paths that were never candidates. Pruning is the entire performance
story, and `fs.globSync` does not expose it.

### 9. `rimraf` / `mkdirp` / `fs-extra` (70M + 40M + 90M weekly) → `node:fs` options

`fs.rm(p, { recursive: true, force: true })` and `fs.mkdir(p, { recursive: true })`.
Two option flags that retired three packages. Used in the test suite for
temporary project fixtures.

### 10. `strip-ansi` (190M weekly) → `util.stripVTControlCharacters`

Identical intent, and the core version also strips non-colour VT sequences.
Re-exported once from `render/ansi.mjs` so nothing else in the tree imports
`node:util` for it alone.

### 11. `cli-table3` / `boxen` → hand-rolled, `src/render/width.mjs`

Column alignment over `pad()` and `wrap()`, both measuring display width rather
than `String.length`. Word wrapping refuses to break a word longer than the
target — file paths and API names read worse hyphenated than wide.

### 12. `chalk`'s hash step, `md5`, `crypto-js` → `node:crypto`

`createHash('sha256')` in `tools/bundle.mjs` to publish the build hash. One core
call.

### 13. `dotenv`, `debug`, `uuid`, `once`, `p-limit` → not needed at all

Worth listing as a negative result: several packages I reached for by reflex
turned out to have no job in this codebase once the design settled. The most
effective dependency removal is still not adding one.

### 14. `@npmcli/arborist` / `npm-check` → `JSON.parse` and a graph walk, `src/lockfile/npm.mjs`

The lockfile is JSON, so parsing it is free. The part that is not free is the
question worth asking: *what actually leaves `node_modules` if this dependency
goes?* That is a reachability computation — everything reachable from the
packages being removed, minus everything still reachable from the ones being
kept — over a graph where resolution walks outward from each importer the way
Node itself does, because npm hoists and a nested copy beats the hoisted one.

About eighty lines, no dependency, and it turns "you could delete cors" into
"deleting these takes 23 packages and one install script out of your supply
chain", which is the sentence the whole tool exists to be able to say.

---

## Package Killer

Three packages, all with real download numbers, reimplemented rather than
described — and `shed` recommends the same substitution to its users, so the tool
and its own source make the same argument:

| Package | Weekly downloads | Replaced by | Where |
|---|---|---|---|
| **chalk** | 319.8M | `util.styleText` + a colour policy | `src/render/ansi.mjs` |
| **commander** / **minimist** | 130M / 80.5M | `util.parseArgs` + subcommands, help, validation | `src/cli.mjs` |
| **semver** | ~250M | written from the spec | `src/semver.mjs` |

`ignore` (200M+) and `string-width` (100M+) are hand-rolled here too and would
qualify on the same terms.

---

## Where the standard library ran out

The honest half. Five places I wanted an API and Node did not have one:

1. **No semver.** Not a comparator, not a range parser, nothing. For a runtime
   whose entire ecosystem is versioned by semver, this is the most surprising
   absence in the list. ~180 lines.

2. **No `stringWidth`.** Bun has it. Node does not, and `String.length` is wrong
   the moment a user has an emoji in a package name. `Intl.Segmenter` gets you
   most of the way, which is more than I expected.

3. **No gitignore matching.** Reasonable for a runtime to omit, but every tool
   that walks a source tree needs it, and every one of them installs `ignore`.

4. **No YAML, and no TOML writer.** `pnpm-lock.yaml` support was cut from this
   release for exactly this reason: reading it means writing a YAML parser, and
   an honest one is a project rather than an afternoon. Python at least has
   read-only `tomllib`; Node has neither format in any direction.

5. **`parseArgs` stops at tokenising.** Documented as intentional, and defensible
   — but it means every non-trivial CLI still writes the same 70 lines of
   subcommand dispatch and help generation. Nothing here is hard; it is just
   nobody's job.

And one in the other direction, worth recording because it cuts against the
premise: **`parseArgs` had already grown `allowNegative`** while I was busy
shimming it. Checking the changelog before writing the workaround would have
saved fifteen lines. That is the failure mode this whole hackathon is about,
arriving from the opposite side.
