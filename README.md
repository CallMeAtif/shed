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

**Node ≥ 22.17.0.** Developed and tested on **v24.4.1**.

---

## What it looks like

Against a small Express API found on the author's laptop:

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
    node:http does not cover app.use(, express.Router
    index.js:10 app.use(cors());
    index.js:11 app.use(helmet());
    index.js:12 app.use(cookieParser());
    … and 4 more

UNREFERENCED (3) - declared, but nothing imports it
  jsonwebtoken            18M/wk      crypto.createHmac + base64url
  bcrypt                  3M/wk       crypto.scrypt()
  nodemailer

4 dependencies the standard library already replaces, worth ~35M weekly downloads.
```

That run found something the author did not know: the project has **both**
`bcrypt` and `bcryptjs` installed and imports only one of them.

---

## The five verdicts

`shed` never says "delete this" without saying why, and it distinguishes four
different reasons a dependency might not be deletable.

| Verdict | Meaning |
|---|---|
| **removable** | Every use `shed` can see is covered by a stdlib API available on this project's Node floor. |
| **bump** | The replacement exists, but above the floor the project declares in `engines.node`. Reports the version needed. |
| **blocked** | The code uses API surface the stdlib replacement does not cover. Cites the line. |
| **unreferenced** | Declared in the manifest, but nothing imports it anywhere `shed` looked. |
| **unknown** | Not in the knowledge base. `shed` has no opinion and says so. |

`removable`, `bump` and `blocked` are shown by default. `--all` adds the other two.

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
      --fix             (not implemented in 0.1.0)
      --node <version>  Judge against this Node version instead of engines.node
      --ignore <pkg>    Exclude a package (repeatable)
  -a, --all             Also show unreferenced and unmapped packages
      --[no-]color      Force colour (default: auto, honours NO_COLOR)
  -q, --quiet           Summary line only
  -h, --help
  -v, --version
```

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

```
$ make build && sha256sum dist/shed.mjs
feebf12c7ff9663a1a87728bad40d0cf1ebae52eef65957b5c2a723097164446  dist/shed.mjs

$ rm -rf dist && make build && sha256sum dist/shed.mjs
feebf12c7ff9663a1a87728bad40d0cf1ebae52eef65957b5c2a723097164446  dist/shed.mjs
```

---

## Limits

Written before the tool felt finished, and kept honest.

**The knowledge base is a curated list, not a registry.** 62 entries. Anything
outside it is reported `unknown`, never guessed at. Download counts are static
figures noted by hand on 31 August 2026 and will age — `shed` makes no network
requests, by design.

**Caveat detection is a substring probe, not semantic analysis.** If a file
imports `chalk` and the text `.hex(` appears anywhere in it — including inside a
comment — that package is reported `blocked`. The bias is deliberate: a false
`blocked` leaves a dependency in place, a false `removable` breaks a build.

**Only the root `.gitignore` is read.** Nested `.gitignore` files are not, and
`\` escaping of a leading `!` or `#` is unimplemented. `node_modules`, `.git`,
`.hg` and `.svn` are always pruned regardless.

**Files over 2 MB are skipped** as presumed bundles, and counted as skipped.

**JSX text is not tokenized.** Imports are still found because they precede the
JSX, but a stray apostrophe in JSX text (`don't`) is read as an unterminated
string and reported as a recoverable diagnostic. On a 290-file React project this
produced 9 such diagnostics; none affected a verdict.

**Phantom dependencies are not reported.** A package imported but *not* declared
in the manifest is invisible to `shed` today.

**The semver implementation is a subset.** Comparators, `^`, `~`, wildcards,
hyphen ranges, intersection and `||` union are supported. Prerelease handling is
stricter than node-semver's: a prerelease satisfies a range only when it is at or
above the range's lower bound. Build metadata is ignored, per spec.

**`--fix` is declared in the help and not implemented in 0.1.0.** It is listed
because the flag is reserved, not because it works. It does nothing today.

**No `package-lock.json` reading yet.** The impact numbers `shed` reports are
weekly-download reach, not transitive package counts or install size on disk.

**Performance is unmeasured.** No benchmark was run against `depcheck` or
`knip`. The scan of a 555-file repository completes in well under a second on an
M-series laptop, which was enough to stop optimising.

---

## Tests

```bash
make test      # 159 tests, node:test only
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
src/knowledge.mjs     the 62-entry mapping table — data, not code
src/analyze.mjs       the verdict engine
src/report.mjs        text and JSON renderers
src/render/           colour, display width, wrapping
tools/bundle.mjs      the deterministic build
tools/deps-proof.mjs  the zero-dependency evidence
```

## Licence

MIT.
