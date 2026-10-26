# Worker startup experiments

The current candidate uses [four direct domain entries](direct-domains.md).
PR #42640 runs build and native behavior checks, but its auxiliary Cloudflare
deployment is disabled: pushes do not activate a candidate or run uploads.

## Archived workflow schema experiment

This temporary experiment keeps the complete API in one Worker and shares
identical Zod leaf schemas within the workflow contract. It retains validation,
reflection, all routes, and the normal static Worker entry point.

The baseline is commit `197b2bc9d1e88e777dfe0882c503eba06bbb2012`. The build
adapter replaces only `workflows.ts` with that revision's contents for the
baseline build. It rejects any baseline bundle that differs from the frozen
complete Worker hash and any candidate that differs from the normal build.
Updating other runtime source or dependencies requires a new baseline.

## Local build

Install the locked repository toolchain, then run from the repository root:

```sh
pnpm --dir turbo/apps/api build:worker
node ops/worker-startup/build-workflow-schema-bench.mjs --out /tmp/workflow-schema-bundles
```

The output contains both complete bundles, source maps, esbuild metadata and a
manifest with source, lockfile and bundle identities. The builder makes no
network requests or deployments. It requires the baseline Git object locally;
historical sampling fetched that exact revision first. Current CI does not run this frozen experiment.

## Cloudflare measurement

The retained preview adapter supports the historical
`API_WORKER_STARTUP_BENCH=workflow-schema-reuse` mode. Its automatic CI opt-in
has been removed because the baseline no longer matches the candidate.
The following records the old measurement procedure; refreshing it requires
new frozen bundles and current provider permissions.

The experiment requires the existing PR Worker with version preview URLs
disabled. It inherits its secret bindings and reuses its Hyperdrive binding;
it does not create a Worker, update Hyperdrive, invoke the application or
activate a candidate version. It uploads 15 randomized baseline/candidate
pairs using the Cloudflare versions API. An explicit startup CPU rejection
remains in the results; other or uncertain outcomes stop without replay.
Before and after checks verify the active deployment, binding identities,
compatibility date and compatibility flags. Secret values are never read.

Safe receipts and summaries go to `generated/worker-startup-benchmark/` and
the historical Actions artifact. They contain bundle identities, numeric startup times,
version IDs and bounded failure classifications, never secret values or raw
provider diagnostics. Uploaded inactive versions remain under the existing
PR Worker and its normal PR-close cleanup owner.

Only successful uploads return numeric `startup_time_ms`. Report rejection
counts alongside timing distributions; do not discard failed attempts or call
these upload measurements request latency. Compiler-cache misses and fresh
independent isolates are not guaranteed by repeated uploads.

## Verification

The workflow contract's existing focused tests and contracts type checks cover
the unchanged public schema surface. The experiment additionally underwent
before/after parse, JSON Schema and expanded-source comparisons. These are
regression evidence, not an exhaustive equivalence proof or a substitute for
the PR's API/client integration checks.

Run the deployment safety checks locally without provider calls:

```sh
node --test .github/scripts/api-worker-workflow.test.cjs .github/scripts/api-worker-preview.test.cjs
```

The branch-specific deployment exclusion must be removed only when candidate
activation is intended. A measured speedup is not assumed.
