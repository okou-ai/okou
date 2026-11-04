# Cold App contract initialization benchmark

From `turbo/`, after installing the repository's existing dependencies:

```sh
node scripts/benchmark-client-contracts/cli.mjs \
  --baseline 4e343a03c9a5068dc18f4f36c7e66a479124a9d3 \
  --iterations 100 --rounds 3 \
  --output /tmp/okou-client-contracts-benchmark
```

This launches **only** the dedicated local Vitest benchmark, with one worker; it
never launches full tests or a dev server. Coordinate with other local Vitest
users before running. `--prepare-only` builds and verifies bundles and performs
the separate construction-count pass without starting Vitest. No new packages,
lockfile changes, package scripts, or changes to generic type checking are needed.
Use an output directory outside the repository to keep generated bundles/results
out of a PR.

Tooling-only checks (no Vitest process):

```sh
node --test scripts/benchmark-client-contracts/tooling.test.mjs
pnpm exec tsc6 -p scripts/benchmark-client-contracts/tsconfig.json
```

## Compared surface

The CLI scans production `apps/platform/src` TypeScript/TSX files using the
TypeScript AST after type erasure. It excludes test/mock/benchmark files and
directories, recording the exclusion expression and scanned-file digest. It
collects imported/re-exported runtime symbols from `@okouai/api-contracts`, plus
API imports in recursively App-reachable Core source modules (including
`pi-execution` and `onboarding-industry`), not every contract in the package.
Reachable Core module paths/hashes and App/Core scan counts are recorded. Other
workspace indirections are not traversed; within a reachable Core module all API
imports are conservatively retained, without timing the Core computation code. Each imported value is live in a global result
array; neither variant calls contract functions or executes requests.

The pinned baseline package **and baseline App import scan** come from `git
archive`, extracted into a temporary directory that is removed after preparation.
Baseline contract sources are not rewritten. Candidate `client/<module>` and
`validators/<module>` imports map to their original baseline
`contracts/<module>` symbols. The schema-free transport maps back to
`contracts/trpc-contract`; the candidate `validateClientResponse` helper maps to
baseline `validateResponse` (initialization only; neither function is called).
Newly direct schema imports explicitly map to their original baseline router
property expressions in `baseline-roots.mjs`; no baseline schema source is
rewritten. These fields are added as retained baseline roots and their router
must exist in the original baseline App import set. All nine mappings are
reported. The composer-draft schema alias, SSH credential constants, and VNC
transport constants also map back to their old contract export paths, recorded
separately as source aliases. The CLI
fails if the baseline/candidate logical router/export identity
sets differ, a retained root is missing, or App/Core/api-contracts source
fingerprints change during preparation.

Both variants bundle against **the same current installed dependencies** and
identical esbuild browser/IIFE/minification options. esbuild is imported from the
existing turbo root dependency. The baseline resolver redirects only the
api-contracts package to its archive and resolves its external dependencies from
the current workspace.

## Timing and correctness

Bundles are self-contained IIFEs. Each is compiled once into a `vm.Script`
**before** timing. Every measured call creates a fresh VM context, evaluates the
entire IIFE, obtains the retained array and assigns a sink. This is cold **module
state and evaluation**, not a repeatedly cached ESM import. Common context
creation and retention overhead is included in both variants. A separate empty
IIFE control measures the same VM overhead; it is reported, not subtracted.

Vitest 5's test-context `bench` fixture runs sequential baseline/candidate/control
comparisons. Round order alternates; each variant has five fresh-context warmups
per round, then the requested fixed number of samples. There is no time-budget
extension and no pass/fail performance threshold. The full Vitest latency
samples/distributions and pooled P50/P95 (linear interpolation) are saved.

An **untimed separate instrumented build** increments a counter only when Zod
first installs `_zod` on an instance. A single WeakSet records each object once;
classification is disjoint (`def.type` means schema, otherwise `def.check` means
check). A schema inheriting check traits is counted only as a schema. A separate
`initInvocations` counter includes all trait initializer calls (including
composition). Neither metric counts schema parse calls. Unique-object counts and
trait initializer invocations measure different work and must not be equated.
The unmodified bundle is the only timed one. Module-set equality between counted and
timed builds is included, so instrumentation-induced retention is visible.

## Outputs

- `results.json`: versions, refs, candidate dirty state/source diff digest,
  baseline/candidate import manifests and reconciliation, module/source hashes,
  schema/check counts, VM control, repetitions, pooled P50/P95, full per-round
  Vitest distributions, and limitations.
- `metadata.json`: preparation metadata, available with `--prepare-only`.
- `baseline.js`, `candidate.js`: exact **uninstrumented** timed IIFEs.
- `*.entry.ts`: retained import manifests as executable entrypoints.
- `*.metafile.json`: esbuild contribution accounting. Module counts include only
  inputs with nonzero output bytes. Actual module counts exclude the synthetic
  benchmark entry (total input count is separate); API package/contracts/generated
  descriptors/client-support/validators/Zod counts are reported separately.

## Limits

This is **not browser FCP** or a browser-startup estimate. It does not time source
compilation, network requests, App rendering, parsing, or request runtime. V8 may
reuse compiled/JIT code across evaluations; module-local objects, globals and
schemas are recreated. The App import union includes lazy routes and workers,
not just the initial chunk. Retaining whole imported values can retain more than
App property-level tree shaking. Current external/workspace dependencies are
shared even for the historical baseline. Host CPU/GC contention and VM overhead
remain; alternating order does not eliminate them. Rerun on an idle, pinned Node
runtime before generalizing a distribution.
