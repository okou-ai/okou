# Storage preparation preview observations

## Status: incomplete acceptance; keep the PR Draft

The implementation and deterministic entrypoint tests are available for review.
This is **not** evidence that the planned production latency saving has been
achieved. Native fresh-creation before/after samples are still missing, and the
collected CI fixtures are observational rather than a matched benchmark.

## Provenance and query boundary

- Source base: `0b73927f3157dd385a24a1af2c4a61e1f0680cbc`.
- Before: behavior-neutral PR #37662 head
  `16f725cbb1d86018711a413ec128eac7d37dcc4f`; deployed merge `423dcbb`.
- After: PR #37664 runtime head
  `9f3344dafeb637d865ecbdcc219aa453c5fc1d83`; deployed merge `6ba6225`.
- Preview deployment jobs verified App/API/Runner success at those sources.
- Native CI cohorts are bound by exact `runner_group` dispatch dimensions:
  `vm0/development-pr-37662` and `vm0/development-pr-37664`. Their Run keys are
  used only for private correlation, not published here.
- Fixed UTC window: `[2026-10-04T01:12:00Z, 2026-10-04T02:07:04Z)`.
- Axiom requests include `startTime`/`endTime` and early `_time` predicates.
  Group projection: 5,996 rows; correlated operation projection: 15,531 rows;
  both nonpartial and below the 100,000-row cap.

The baseline and change use separate preview Runner namespaces/hosts and mixed
CI cases. Cache warmth, fixture selection and host effects are not controlled;
therefore subtracting their aggregate percentiles is **not a causal saving**.
The local account's protected test-token endpoint returned HTTP 404 and was not
used to invent an additional controlled fixture. Dataset-field discovery also
returned provider HTTP 403 despite an allowed connector policy; the source
schema and bounded operation queries were sufficient for this correlation.
No provider permissions, shared configuration or production state were changed.

## Coverage and actual path classification

| Cohort | API Run keys | Claim-to-spawn observations | Exact reuse | Blank-pool reuse | Actual fresh creation | No claim-to-spawn observation |
| ------ | -----------: | --------------------------: | ----------: | ---------------: | --------------------: | ----------------------------: |
| Before |           42 |                          36 |           9 |               27 |                     0 |                             6 |
| After  |           36 |                          26 |           7 |               19 |                     0 |                            10 |

Exact classification requires `sandbox_reuse_hit`; blank classification requires
`sandbox_blank_pool_hit`. Neither is called fresh because it started a new chat
or has a `cold` reuse label. All 62 measured Runs have the reused-sandbox
preparation marker. Missing observations remain unknown, not zero-duration or
assumed successes. One after observation lacks the separate shell-spawn record;
its reported claim-to-spawn metric is retained, but independent shell coverage
is 25/26. No failed Runner operation records appear in these selected cohorts;
that is not a statement that every API Run completed successfully.

## Observed distributions, not attributed improvements

Values are milliseconds, nearest-rank per-Run **p50 / p90**, on successful unique
operation observations. N is shown where a subsegment has less coverage.

| Path / segment                       |           Before |            After |
| ------------------------------------ | ---------------: | ---------------: |
| Exact reuse claim-to-spawn           |   26 / 308 (N=9) |    8 / 130 (N=7) |
| Blank reuse claim-to-spawn           | 382 / 458 (N=27) | 147 / 268 (N=19) |
| Blank claim-to-executor              |          11 / 19 |            6 / 8 |
| Blank executor-to-spawn              |        371 / 445 |        140 / 262 |
| Blank serial-equivalent storage work |        309 / 392 |        120 / 246 |
| Blank cache population               |        283 / 371 |        109 / 238 |
| Blank Guest staging write work       |    6 / 12 (N=27) |     2 / 3 (N=19) |
| Blank instruction normalization      |     0 / 1 (N=27) |     0 / 0 (N=17) |
| Blank planning-to-registration       |            1 / 1 |            0 / 0 |
| Blank shell spawn                    |   10 / 15 (N=27) |     6 / 9 (N=18) |

The much lower after cache-population/claim-to-spawn values cannot be credited
to this concurrency change: measured registration is already submillisecond in
this preview, unlike the earlier production engineering estimate.

After-only concurrent branches (all reused paths, N=26):

| Segment                            | p50 / p90 |
| ---------------------------------- | --------: |
| Proxy registration                 |     0 / 0 |
| Early runtime-state/staging branch | 102 / 233 |
| Concurrent wall-time parent        | 102 / 233 |
| Per-Run `proxy + staging - parent` |     0 / 0 |

The last quantity is computed on paired branches, not by subtracting cohort
percentiles. Its quantized histogram is 25 observations at 0ms and one at -1ms
(rounding/parent overhead); negative observations are not rounded into a gain.
**No material overlap saving was demonstrated in this preview.** These small
Guest-write/normalization samples also do not justify a new duplicate-content
skip policy or extrapolate to large production artifacts. Existing strict
version reuse and mutable-artifact behavior are preserved instead.

## Remaining acceptance boundary

- Native fresh VM creation has N=0 in both cohorts: no fresh-path before/after
  latency or regression-control conclusion is claimed.
- A matched controlled fixture, including actual fresh creation and failures,
  remains necessary before claiming a causal improvement.
- Deterministic production-entrypoint tests cover fresh ordering, reused success
  and failure/cancellation fences with mocked external Sandbox RPCs. The native
  CI evidence above is separate from those tests.
- Runner rootfs/process tests on both architectures and native Runner E2E checks
  passed at the measured runtime head. Guest/CLI contracts and the canonical
  release checks remain unchanged; no production release was run.

The PR stays Draft for user review. No `/pr-auto`, approval, merge queue, merge,
release, pool-warming change or additional operational chat thread is requested.
