# shed

**Find the dependencies your standard library already replaced.**

Point `shed` at a JavaScript project. It reads the manifest and the source tree —
offline, spawning nothing — and tells you which of your dependencies Node core has
made redundant, which line of your code would have to change, and which ones you
genuinely still need.

It is itself a zero-dependency program. `shed` scanning `shed` reports nothing to
remove, which is the shortest description of what the tool is for.

Built for the [Zero Dependency hackathon](https://zerodepshack.com), **Track A —
Developer Tools & CLI**.

---

## Quick start

```bash
git clone https://github.com/CallMeAtif/shed && cd shed
make            # builds dist/shed.mjs — no install step, because there is nothing to install
node dist/shed.mjs /path/to/your/project
```

There is no `npm install`. There is nothing to install. `make` runs one Node
script that inlines the module graph into a single file.

Run it straight from source if you prefer: `node bin/shed.mjs /path/to/project`.

**Node ≥ 22.17.0.** The full suite is run on **v22.17.0** — the declared floor —
and on **v24.4.1**. 257 tests pass on both, and both produce a byte-identical
artifact.

---

## What it looks like

Against a small Express API found on the author's laptop (the project is
unnamed on disk; `api-server` is substituted here for readability, and is the
only edit to this transcript):

```
shed 0.1.0  ·  api-server  ·  Node floor 24.4.1 (assumed from the running Node)
scanned 7 files, 10 declared dependencies

REMOVABLE (4) - the standard library covers every use shed can see
  cors                    20M/wk      Access-Control-* response headers
    A permissive CORS policy is four setHeader calls; per-origin allow-lists and
    preflight caching are yours.
    index.js:3
  cookie-parser           8M/wk       splitting the Cookie header
    Parsing is a split and a decodeURIComponent; signed cookies need an HMAC you
    write over node:crypto.
    index.js:4
  helmet                  4M/wk       response headers set by hand
    Every header helmet sets is one setHeader call, but you take on tracking the
    defaults it maintains.
    index.js:2
  bcryptjs                3M/wk       crypto.scrypt()
    Same trade as bcrypt, and the pure-JS implementation is slower than the core
    one it would be replaced by.
    utils/hashing.js:1

BLOCKED (1) - the code uses something the replacement does not cover
  express                 35M/wk      node:http
    node:http does not cover app.use(, app.get(, res.json(, app.listen(, express.Router
    index.js:10 app.use(cors());
    index.js:11 app.use(helmet());
    index.js:12 app.use(cookieParser());
    … and 7 more

4 dependencies the standard library already replaces, worth ~35M weekly downloads.
Removing them takes 6 packages out of node_modules.
The 3 unreferenced packages would take a further 17 packages, 1 of which runs an
install script (bcrypt).
```

That run found something the author did not know: the project has **both**
`bcrypt` and `bcryptjs` installed and imports only one of them. (`bcrypt` is
among the unreferenced packages, which `--all` lists.)

Note what the last two lines do **not** do: they keep the removable set and the
unreferenced set apart. Folding them into one figure would have credited four
packages with a saving that seven produce.

---

## The six verdicts

`shed` never says "delete this" without saying why, and it distinguishes five
different reasons a dependency might not be deletable.

| Verdict | Meaning |
|---|---|
| **removable** | Nothing in your code blocks the swap, on this project's Node floor. Entries marked `(partial)` name what the replacement still costs — read the rationale. |
| **bump** | The replacement exists, but above the floor the project declares in `engines.node`. Reports the version needed. |
| **blocked** | The code uses API surface the stdlib replacement does not cover. Cites the line. |
| **unreferenced** | Declared in the manifest, but nothing imports it anywhere `shed` looked. |
| **tooling** | Never imported, and never should be — a script runs it, a config names it, another package requires it as a peer, the project shape implies it (`tsconfig.json` ⇒ `typescript`), or its name says so (`@types/*`, `eslint-plugin-*`). |
| **unknown** | Not in the knowledge base. `shed` has no opinion and says so. |

`removable`, `bump` and `blocked` are shown by default. `--all` adds the other three.

`tooling` exists because it is this genre of tool's classic false positive. Nothing
imports `nodemon`, so a naive scan calls it dead and tells you to delete the thing
that runs your dev server. `shed` recognises three kinds:

- **a script runs it** — the package name appears in a `scripts` command
- **something requires it as a peer** — `next` requires `react-dom`, so `react-dom`
  sits in your manifest and appears in none of your source
- **the project shape implies it** — a `tsconfig.json` means `typescript`, a
  `tailwind.config.js` means `tailwindcss`, a `.eslintrc` means `eslint`. None of
  them are named anywhere: `next lint` does not contain the string "eslint"
- **a config names it** — it is named in `tsconfig.json`, `.releaserc`, a CI
  workflow, or a manifest section like `lint-staged` (dependency blocks are
  excluded from that search, or every package would match itself)
- **its name says so** — `@types/*`, `eslint-plugin-*`, `babel-preset-*` and
  friends are resolved by name and never imported by anyone

`--fix` will not touch any of them.

The bar for `removable` is deliberately high. A false "you can delete this" costs
more trust than ten correct ones earn, so every heuristic here is biased toward
leaving a dependency in place.

### How the floor is decided

A recommendation has to clear the Node version the project promises to run on,
not the one you happen to have installed. `shed` reads `engines.node`, takes the
**lowest** version its range admits, and judges against that. With no `engines`
field it falls back to the running Node and labels the report accordingly.
`--node 22.0.0` overrides both.

---

## Usage

```
shed [command] [options] [dir]

COMMANDS
  scan [dir]       Audit a project (the default: `shed .` is `shed scan .`)
  why <pkg> [dir]  Explain one package in full, including what it found here
  list             Print the whole knowledge base, so you can audit its opinions

OPTIONS
      --json            Machine-readable report
      --fix             Remove dependencies nothing imports from package.json
      --node <version>  Judge against this Node version instead of engines.node
                        (must be a version; anything else is a usage error)
      --ignore <pkg>    Exclude a package (repeatable)
  -a, --all             Also show unreferenced and unmapped packages
      --[no-]color      Force colour on or off. NO_COLOR wins over both;
                        otherwise the flag, then FORCE_COLOR, then TTY
  -q, --quiet           Summary line only
  -h, --help
  -v, --version
```

### What it actually costs you

A download count describes a package's reach in the ecosystem. It says nothing
about what the package costs *your* project. So when a `package-lock.json` is
present, `shed` reads it, builds the resolution graph, and computes the
transitive closure that becomes unreachable if the removable packages go:

```
Removing them takes 6 packages out of node_modules.
The 3 unreferenced packages would take a further 17 packages, 1 of which runs an
install script (bcrypt).
```

The arithmetic is deliberately conservative. A transitive package that some
*surviving* dependency still needs is not counted — that is the difference
between "cors depends on 2 packages" and "removing cors removes 2 packages",
and only the second is true. Resolution walks outward from each importer the
way Node does, so a nested copy beats the hoisted one.

Install scripts are called out separately because they are the part of a
dependency that runs code on your machine at install time.

Lockfile v2 and v3 only (npm 7+). v1 is detected and reported as unsupported
rather than half-parsed. No lockfile means the numbers are simply omitted.

### `--fix`

`--fix` makes exactly one kind of edit: it removes dependencies nothing imports
from `package.json`, preserving your indentation and key order.

It deliberately does **not** rewrite source code. A codemod turning `chalk.red(x)`
into `styleText('red', x)` is easy to write and easy to get wrong on the fifth
variation, and a tool that silently corrupts source is worse than no tool.

Three guards stand between a finding and an edit:

1. only the `unreferenced` verdict qualifies — never `tooling`, and never one a
   permissive second-opinion scan disagreed about
2. the scan must have **accounted for every file**, and there must be at least
   one. A parse error, a file skipped for size, a nested manifest, or an empty
   scan all block the edit: an unexamined file is exactly as dangerous as an
   unparsed one
3. there must be a readable `package-lock.json`. Without one, peer requirements
   are invisible, and a peer is the classic dependency that nothing imports and
   everything needs
4. the rewritten manifest is re-parsed and compared against the intended object
   before anything is written; a mismatch aborts

```
$ shed . --fix
Removed 1 unreferenced dependency from package.json:
  - uuid

Nothing else was touched. Run your tests, then delete the lockfile entries with
your package manager.
```

It does not touch your lockfile — that is your package manager's job.

### As a CI gate

`shed` exits **1** when anything is removable, **0** when nothing is, and **2** on
a usage error:

```yaml
- run: node dist/shed.mjs . --quiet    # fails the build if a dependency became redundant
```

### `--json`

The shape is stable; future changes will be additive.

```jsonc
{
  "shed": "0.1.0",
  "project": { "dir": "...", "name": "api-server", "version": "1.0.0" },
  "node": { "version": "22.0.0", "source": "engines" },   // or "flag" | "runtime"
  "scanned": 7,
  "totals": { "declared": 10, "byVerdict": { "removable": 4, ... }, "weeklyRemovable": 35000000 },
  "findings": [
    {
      "name": "chalk",
      "range": "^5.0.0",
      "field": "dependencies",
      "verdict": "removable",
      "because": "...",
      "replacement": { "api": "util.styleText()", "since": "20.12.0", "confidence": "partial", "weekly": 319800000 },
      "sites": [{ "file": "src/log.js", "line": 1, "col": 19, "kind": "static", "specifier": "chalk" }],
      "siteCount": 1,
      "caveats": [],
      "caveatCount": 0
    }
  ],
  "errors": []
}
```

---

## How this compares to depcheck and knip

Worth stating plainly, because the overlap is real and the difference is the
point.

**The job nothing else does.** No other tool asks whether the *standard library*
has made a dependency redundant. `depcheck` finds packages nothing imports;
`knip` finds dead code and unused exports; `npm-check` finds outdated versions.
None has any concept of "Node core does this now", so none will ever tell you
`uuid → crypto.randomUUID()`, `cors → four setHeader calls`, or that the
replacement needs Node 22 while your `engines` field says 18. That is the
`removable`, `bump` and `blocked` half of the report, and it is why this exists.

**The job depcheck also does.** The `unreferenced` half — "which declared
packages does nothing import" — is depcheck's core competency, and it has years
of accumulated special-casing. If unused-dependency detection is all you want,
depcheck is a mature tool and a reasonable choice. `shed` reads peer
requirements, config files and project-shape conventions for the same job, and
`--fix` refuses outright on any project it cannot fully account for.

## Why the import scanner is not a regular expression

Finding `require('x')` with a regex is a two-minute job that is wrong in ways
that matter for a tool whose output is "delete this code". All of these appear in
real source, and all of them defeat the regex approach:

```js
// const x = require('chalk');          ← a comment
const doc = "call require('chalk')";    // ← a string
const q = /['"]/g;                      // ← a regex literal containing quotes
const p = /[a-z/]+/;                    // ← a slash inside a character class
const s = `a ${ `b ${ c } d` } e`;      // ← a template literal nested in a template literal
loader.require('chalk');                // ← a property, not the global
const ratio = width / 2;                // ← division that is not a regex
</div>                                  // ← JSX, where `/` starts nothing at all
```

So `src/scanner/imports.mjs` is a character scanner with a **mode stack**: it
tracks whether it is inside a string, a comment, a regex literal, or a template
literal, and for template literals it counts brace depth so that the `}` closing
a `${}` interpolation can be told apart from the one closing an object literal
inside it. Regex-versus-division is decided from the previous significant token.

Two passes, deliberately: `tokenize()` decides what is code, `extractImports()`
reads import forms out of the token stream. Both are independently tested.

One rule earns its own note. **An unclosed `/` is not an error.** A regex literal
cannot span a line, so a `/` with no closing `/` on the same line was never a
regex — it is division, or the slash in `</div>`. The scanner rewinds and treats
it as punctuation. On a real React codebase that single rule took the false
diagnostic count from **2,326 to 9**.

---

## Zero dependencies, proved

```bash
make deps-proof     # regenerates deps-proof.txt
```

The proof asserts three independent things, because an empty manifest on its own
proves nothing if the code still reaches for a bare specifier at runtime:

1. `package.json` declares no dependencies of any kind.
2. No `node_modules` directory exists.
3. **Every import in `src/`, `bin/`, `tools/` and `tests/` resolves to a `node:`
   builtin or a relative path in this repo** — checked by running shed's own
   import scanner over shed.

Current output is in [`deps-proof.txt`](deps-proof.txt). Every substitution made
along the way is written up in [`STDLIB.md`](STDLIB.md).

## Reproducible build

`make build` inlines the module graph into `dist/shed.mjs`. Modules are emitted
in sorted path order and nothing time-varying is written, so two builds on the
same toolchain are byte-identical:

Verified on both supported Node versions: the floor and the current release
produce the same bytes.

```
$ make build && sha256sum dist/shed.mjs
d977d6b1f56d0aed5574e5f995ae35fa38cc7fda6b8f8858a1730c317c56ab8d  dist/shed.mjs

$ rm -rf dist && make build && sha256sum dist/shed.mjs
d977d6b1f56d0aed5574e5f995ae35fa38cc7fda6b8f8858a1730c317c56ab8d  dist/shed.mjs
```

---

## Limits

Written before the tool felt finished, and kept honest.

**The knowledge base is a curated list, not a registry.** 100 entries. Anything
outside it is reported `unknown`, never guessed at. On a large React
application that means roughly a third of dependencies get a verdict: most of
the rest — UI component libraries, a rendering framework, a test runner's
ecosystem — have no standard-library answer, and inventing one for them would be
worse than saying nothing. Download counts are static
figures noted by hand on 31 August 2026 and will age — `shed` makes no network
requests, by design.

**Caveat detection is a substring probe, not semantic analysis.** If a file
imports `chalk` and the text `.hex(` appears anywhere in its *code*, that package
is reported `blocked`. Comments are blanked first using the tokenizer's own
ranges, so a caveat mentioned only in prose no longer blocks — which does mean a
commented-out call site is not counted as usage either. Strings are still
matched, and the bias remains deliberate: a false `blocked` leaves a dependency
in place, a false `removable` breaks a build.

**Only the root `.gitignore` is read.** Nested `.gitignore` files are not, and
`\` escaping of a leading `!` or `#` is unimplemented. `node_modules`, `.git`,
`.hg` and `.svn` are always pruned regardless.

**Files over 2 MB are skipped** as presumed bundles. `--fix` refuses to edit a
project where anything was skipped, since the import that would have vouched for
a package could be in the file nobody read.

**JSX text is not tokenized.** An apostrophe or a double quote in JSX text
(`don't`, `say "hi"`) is read as a string literal. With an odd number on a line
that produces a recoverable diagnostic; with an even number the "string" closes
cleanly and anything between is swallowed silently — including a `require()`
inside a JSX expression.

Rather than refusing to touch JSX projects at all, `shed` runs a second,
deliberately permissive scan that ignores string and comment context. It is never
used to claim a package **is** used — only to refuse to claim it is not. If the
loose scan sees a name the strict one did not, that package is reported as too
close to call and `--fix` will not touch it. The same veto covers a package
named as a string literal rather than imported — `pino({ transport: { target:
'pino-pretty' } })` — decided by the string's *position*, not its spelling. A
string in property-value position is a name being loaded; a comparison operand
(`if (level === 'debug')`) is not, and does not shield anything. On a 290-file React project the
strict scan produced 9 diagnostics; none affected a verdict.

**Tooling detection is evidence-based, and evidence can be missing.** A package
used only by a tool `shed` does not know about, named nowhere it looks and
required as nobody's peer, is still reported `unreferenced`. Run with `--all`
and read the list before `--fix` — the default view does not show it.

**`--fix` edits line-wise.** A manifest with a dependency block written on one
line is left alone with a reason, rather than reformatted.

**Nested manifests are not scanned.** A directory with its own `package.json` is
a different project answering to a different manifest, so `shed` stops at it,
names it, and refuses to `--fix`. Because part of the tree then went unread, no
package is reported as confidently unimported either — absence cannot be proven
from a partial scan. Point `shed` at each package. Workspaces are not resolved
as a unit.

**Browser targets get a narrower answer, not a wrong one.** Every version
judgement `shed` makes is about Node. When a project looks browser-targeted — a
bundler config, a `browserslist` or `browser` field — any replacement naming a
`node:` builtin, `Buffer`, or a Node-only `crypto` function is reported
`blocked` rather than recommended, since it does not exist there at all. APIs
browsers do have are still offered, with a header warning: `crypto.randomUUID`
is real in a browser but only in a secure context, and `shed` cannot check that
for you.

**A peer requirement shields a package from being called dead.** If anything in
the lockfile declares a package as a non-optional peer, `shed` classifies it
`tooling` and `--fix` will not remove it — even if it is genuinely unused. That
is deliberate: it is what stops `react-dom` being deleted from a Next.js app. It
also means a package named as a peer by some unrelated plugin will never be
reported as dead weight. Optional peers do not shield.

**`--fix` needs an npm lockfile.** Only `package-lock.json` v2/v3 is read, so on
a yarn or pnpm project `--fix` refuses and the scan runs without transitive
counts. Reading those formats is not implemented.

**An unreadable `engines.node` fails toward generosity.** If the range cannot be
parsed, `shed` falls back to the running Node — usually a *higher* version — and
says so in the header, because that turns "needs a bump" into "removable".

**Escape sequences inside a module specifier are not decoded.** `'ch\u0061lk'`
reads as a different package name, so the real dependency gets no import site.
Legal, and vanishingly rare in real source; decoding it would mean touching the
string reader every specifier depends on.

**A `.gitignore` re-include under an excluded directory is honoured more
permissively than git honours it.** git will not re-include a file whose parent
directory is excluded; `shed` will.

**Phantom dependencies are not reported.** A package imported but *not* declared
in the manifest is invisible to `shed` today.

**The semver implementation is a subset.** Comparators, `^`, `~`, wildcards,
hyphen ranges, intersection and `||` union are supported, with whitespace between
an operator and its version normalised first (`>= 18.0.0` is `>=18.0.0`). Prerelease inclusion follows node-semver: a prerelease
satisfies a comparator set only if some comparator pins the same
major.minor.patch and is itself a prerelease. Build metadata is parsed and
ignored for ordering, per spec.

**`--fix` only edits `package.json`.** It never rewrites source and never touches
the lockfile. After a fix, run your package manager to prune the lock.

**Install size on disk is not reported.** `shed` counts the packages that would
leave `node_modules`, not the bytes: a lockfile records no sizes, and reading them
would mean walking an installed tree.

**Performance is unmeasured.** No benchmark was run against `depcheck` or
`knip`. The scan of a 555-file repository completes in well under a second on an
M-series laptop, which was enough to stop optimising.

---

## Tests

```bash
make test      # 278 tests, node:test only
```

The scanner's fixture corpus is the part worth reading:
`tests/imports.test.mjs` covers nested template literals, regex literals
containing quotes and slashes, `require` inside comments and strings, BOMs, CRLF
line endings, scoped packages, computed dynamic imports, and every malformed
input the scanner is expected to survive.

## Layout

```
bin/shed.mjs          entry point, deliberately thin
src/scanner/imports   the character scanner and token stream
src/semver.mjs        version comparison and range satisfaction
src/gitignore.mjs     .gitignore matching
src/knowledge.mjs     the 100-entry mapping table — data, not code
src/analyze.mjs       the verdict engine
src/fix.mjs           the only edit shed will make, and its three guards
src/lockfile/npm.mjs  the resolution graph, and what removal actually frees
src/report.mjs        text and JSON renderers
src/render/           colour, display width, wrapping
tools/bundle.mjs      the deterministic build
tools/deps-proof.mjs  the zero-dependency evidence
```

## Licence

MIT.
