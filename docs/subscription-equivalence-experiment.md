# Paired subscription equivalence experiment (#34722)

Retain the joined pair. Two reversed-order rounds show repeatable complete-caller
benefit beyond equal-ciphertext control noise, with unchanged successful call
counts and no unjoined decrypts. The first-failure cost is deliberately retained
and quantified below; this decision does not establish production KMS capacity.

## Boundary and ownership

This experiment compares the existing serial canonical/mirror decryption in
`subscriptionBundlesMatch` with a joined pair. The field loop remains sequential:
equal ciphertext skips KMS, and mismatches or errors stop before another field.
Both started calls settle before inspecting errors in canonical/mirror order.
Shape, auth method, credential names and Claude secret identity checks remain
unchanged. `credentialValues` retains its separately evaluated two-wide batches.

The measured callers are complete `preparePersonalSubscriptionAdmission` and
complete `readPersonalSubscriptionCredentialBundle`, including transaction
completion. Preparation captures encrypted state under locks and proves it
after releasing them. The locked reader proves and materializes credentials
while retaining provider ownership. Final admission still validates a fresh
post-storage snapshot without KMS or profile calls.

These are controlled local measurements, not production savings, KMS attribution,
or an `api_to_spawn` result. The production observations motivating the issue are
not mixed with these measurements. Parent #24203 remains independent.

## Reproduction

Use the existing local PostgreSQL setup and synthetic configuration described in
[the materialization experiment](subscription-decryption-experiment.md), adding
`--equivalence` to the same command:

```sh
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
SECRETS_KMS_KEY_ID=synthetic-benchmark-key \
AXIOM_TOKEN_SESSIONS=synthetic AXIOM_TOKEN_TELEMETRY=synthetic ENV=development \
pnpm -F api exec dotenv -e .env.local -- tsx src/scripts/bench-subscription-decryption.ts --equivalence
```

The harness rejects non-local database hosts and scopes KMS to a synthetic
external client. Real AES-GCM encryption, production caller code and PostgreSQL
transactions run against UUID-owned fixture rows. It removes only those rows,
does not flush telemetry, and prints no plaintext or SQL parameters. Without
`--equivalence`, the original materialization workload remains available.

Each of 41 scenarios has one warm-up and 20 measured repetitions. Four-request
workloads have 80 observations. Fixtures are recreated outside the timed region
for each repetition, preserving field order and the same comparison position.
Normal logical KMS service is 20 ms. Slow siblings take 80 ms; this represents
logical-call latency including possible retry delay, not the AWS retry algorithm.
The matrix owns a five-minute experiment deadline; production timeouts are
unchanged. Run baseline/candidate, then candidate/baseline, sequentially with no
other checks or dependency installation running.

Unequal Claude plaintext is measured through preparation, which rejects it;
the locked Claude reconciliation path requires an external identity/profile
lookup and remains covered by historical-writer API tests. Request cancellation
is measured through preparation's existing checkpoint. Locked readers instead
exercise KMS AbortError ownership, since they do not own that request checkpoint.

Report whole-proof timing only for preparation. Total time includes its snapshot
transaction and caller completion. Client-observed lock duration runs from
advisory-query completion to COMMIT/ROLLBACK completion, so it excludes lock
acquisition transport and includes completion transport. For preparation that
duration excludes the proof; for the locked reader it includes proof and
materialization. Advisory and other SQL times include driver round trips.
Overlapping KMS service sums and independently ranked percentiles are not added.

## Recorded environment

Final runs on September 17, 2026 (Asia/Shanghai) used Node v24.21.0, pnpm 10.33.4,
PostgreSQL 18.6, Linux 6.18.44+, two CPUs, reported 4 GiB RAM and a 2 GiB
local swap file. This was a shared sandbox; dependency installation and static
checks had finished before measurement. No checks ran alongside the four
experiments. The PostgreSQL pool maximum was eight and its timezone was UTC.

Baseline service was byte-identical to main
`d1312dca7973bcd5615ca7a55123e4e5ee4906da`. Candidate production source differed
only in pair scheduling. Both rounds used the same final harness and locked
dependencies; round 1 ran baseline then candidate, round 2 candidate then
baseline. The harness records dirty source because its extension was uncommitted
during both versions; service digests establish which implementation ran.

| Input             | SHA-256                                                            |
| ----------------- | ------------------------------------------------------------------ |
| Baseline service  | `3a38d18ca8cc98af8e9d5b8ae940b000b4283ee3a611bd08d60d375a2447a027` |
| Candidate service | `e3c3f58010d6c22730ce28fd4ec60f8611dd9e9aff48ec20a0f9944f528be0ca` |
| Harness           | `a39b8d7caf16539ceabd2543011f2ddf6a82b9c4643e9a5915d435df185dcc97` |
| Lockfile          | `dd7f65c8751f996c7823d84fddbad45458257c013f4f3b8558dc2db9f14ff4a0` |

## Complete-caller results

All times are milliseconds; arrows are baseline to candidate. The
[complete result matrix](subscription-equivalence-results.csv) contains all 164
scenario summaries and 5,200 measured operations, including both providers,
whole-proof/whole-caller/lock-held p50/p90/p95/p99, SQL and advisory times,
overlapping KMS service sums, logical calls, peaks, errors and active calls at
return. `proofMs` is only applicable to preparation; its zero in bundle rows is
not a separately measured proof. Nearest-rank p99 equals the maximum at these
20/80-sample sizes, so these are mechanism checks, not stable population tails.

| Caller / provider | Ciphertext | Round 1 total p50 | Round 2 total p50 | Calls/op |
| ----------------- | ---------- | ----------------: | ----------------: | -------: |
| Prepare Claude    | Equal      |       6.21 → 5.39 |       5.53 → 5.49 |    0 → 0 |
| Prepare Claude    | Equivalent |     45.32 → 24.94 |     45.58 → 25.09 |    2 → 2 |
| Prepare Codex     | Equal      |       2.66 → 3.88 |       4.92 → 2.63 |    0 → 0 |
| Prepare Codex     | Equivalent |    167.54 → 86.52 |    167.89 → 86.45 |    8 → 8 |
| Locked Claude     | Equal      |     24.02 → 23.81 |     24.17 → 24.01 |    1 → 1 |
| Locked Claude     | Equivalent |     65.95 → 45.08 |     65.62 → 44.30 |    3 → 3 |
| Locked Codex      | Equal      |     45.29 → 45.89 |     45.65 → 45.80 |    4 → 4 |
| Locked Codex      | Equivalent |   210.82 → 130.33 |   210.95 → 130.07 |  12 → 12 |

In round 2, complete equivalent preparation proof p50 was Claude 41.01 → 20.64 and Codex 163.88 → 82.76.
Equivalent locked-reader lock-held p50 was Claude 64.68 → 43.69 and Codex 210.55 → 129.46.
Preparation's snapshot lock stays outside its proof and is not shortened by
overlapping KMS. Successful equivalent-caller improvements repeat in both rounds;
equal-ciphertext controls show local host/SQL noise rather than a KMS speedup.
SQL count and successful logical KMS count remain unchanged in corresponding
scenarios. All local tails are retained without filtering or pooling; separately
ranked stage percentiles must not be summed or assigned to a common request.

Round 2 Codex error and cancellation results below show total **p50/p95/p99**.
Both providers and both rounds remain in the complete matrix.

| Caller / scenario                             |                 Baseline |                Candidate | Calls/op |
| --------------------------------------------- | -----------------------: | -----------------------: | -------: |
| Prepare / unequal plaintext                   |    45.07 / 46.34 / 46.45 |    24.68 / 25.69 / 25.84 |    2 → 2 |
| Prepare / canonical error, slow mirror        |    23.42 / 25.49 / 25.63 |    84.68 / 85.45 / 85.72 |    1 → 2 |
| Prepare / mirror error                        |    44.35 / 45.22 / 45.54 |    24.28 / 25.58 / 26.42 |    2 → 2 |
| Prepare / both errors, mirror finishes first  |    84.27 / 85.33 / 85.46 |    84.15 / 85.35 / 86.12 |    1 → 2 |
| Prepare / successful slow sibling             | 228.17 / 230.78 / 233.45 | 146.62 / 147.64 / 147.76 |    8 → 8 |
| Prepare / KMS AbortError, slow mirror         |    23.83 / 25.07 / 37.99 |    84.14 / 86.00 / 86.22 |    1 → 2 |
| Prepare / request cancellation during proof   | 228.21 / 230.07 / 230.62 | 147.12 / 148.70 / 149.77 |    8 → 8 |
| Locked / unequal plaintext and reconciliation | 266.70 / 271.74 / 275.81 | 225.91 / 228.79 / 236.80 |  20 → 20 |
| Locked / canonical error, slow mirror         |    23.54 / 25.07 / 25.08 |   84.84 / 93.85 / 151.10 |    1 → 2 |
| Locked / mirror error                         |    44.83 / 45.87 / 49.43 |    24.35 / 25.66 / 26.40 |    2 → 2 |
| Locked / both errors, mirror finishes first   |    83.98 / 85.63 / 85.88 |    83.79 / 85.63 / 85.91 |    1 → 2 |
| Locked / successful slow sibling              | 272.62 / 277.80 / 284.04 | 191.37 / 193.06 / 195.36 |  12 → 12 |
| Locked / KMS AbortError, slow mirror          |    24.21 / 25.01 / 25.45 |    84.35 / 85.60 / 86.37 |    1 → 2 |

The candidate's round-2 locked canonical-error p99 of 151.10 ms is retained;
round 1 was 86.53 ms. Round 2 also had a 54.47 ms non-advisory SQL maximum,
while its overlapping KMS service-sum maximum was 103.42 ms. These separately
ranked measurements cannot be added or used to attribute one request's tail.
The small shared-host samples do not establish a production tail bound.

Round 2's four-request equivalent Codex workloads show where the pair bound
multiplies. Lock-held p50 applies to each operation, not the whole workload.

| Workload                      |       Total p50 |                 Total p95/p99 |   Lock-held p50 | Workload KMS peak |
| ----------------------------- | --------------: | ----------------------------: | --------------: | ----------------: |
| Prepare / same provider       |  173.00 → 91.61 |  179.98/183.07 → 98.58/107.96 |     3.24 → 3.22 |             4 → 8 |
| Prepare / different providers |  170.27 → 87.50 |   173.46/176.26 → 90.69/91.62 |     4.32 → 3.65 |             4 → 8 |
| Locked / same provider        | 430.16 → 265.47 | 854.79/857.10 → 525.78/526.81 | 212.78 → 130.53 |             2 → 2 |
| Locked / different providers  | 216.95 → 134.18 | 228.28/235.77 → 139.23/141.34 | 214.97 → 133.19 |             8 → 8 |

Locked-reader peaks already include the earlier two-wide materialization, so
their maximum does not rise even though the proof's own fan-out doubles.

## Safety and compatibility

- Each comparison owns at most two active decrypts. Different providers multiply
  that bound. Unlocked preparation for the same provider also overlaps after its
  short snapshot transactions; the bound is not a process or fleet quota.
- A canonical failure can start one extra mirror request and wait for its slow
  sibling. Both-error workloads finish the mirror failure first but still return
  the canonical error. A later field never starts after a decrypt failure or
  mismatch. Every operation verifies zero active decrypts at return.
- KMS has no transport AbortSignal. A KMS AbortError joins its sibling before
  propagating. Request cancellation during preparation is observed at the
  existing post-proof checkpoint; the complete proof still drains. This does
  not add early transport cancellation or promise a new maximum lock duration.
- Equal-ciphertext preparation verifies zero KMS calls; successful equivalent
  Claude/Codex preparation verifies exactly 2/8 calls. Locked complete reads
  add the existing 1/4 materialization calls. API regression tests independently
  verify retained authorization and provider mutation ownership after either
  member of an equivalence pair fails.
- No plaintext cache, early unlock, retry, timeout, identity/profile, account
  selection or token-rotation change. No persisted shape or frontend/Runner
  contract changes; old/new APIs retain the same rows and locks. Existing
  historical-writer, activation/disconnect, retention, revocation and final
  admission behavior remains covered by route tests.

Production quota headroom, throttling probability, SDK retry attempts and outage
tails remain unmeasured. The synthetic resource/error results describe the
trade-off; they do not establish those production properties.
