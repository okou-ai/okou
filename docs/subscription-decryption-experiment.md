# Subscription decryption experiment (#34376)

## Decision and boundary

Retain two-wide joined batches in `credentialValues`. This reduces serial
dependency waits without changing the locked snapshot, account authority, SQL,
or caller protocol. No lock is released early. Every started batch settles
before its first input-order error propagates, and later batches do not start
after failure. Claude's one-field bundle has no expected speedup.

This is a controlled local experiment, **not measured production savings or
evidence that KMS caused #34344**. It measures complete bundle materialization
including transaction completion, not full HTTP/OAuth refresh or `api_to_spawn`.
Management, Pi initial/validation reads, runtime firewall auth and exceptional
legacy coordination use this leaf at different lifecycle stages. Coherent
ordinary Sandbox environment preparation remains lazy; final admission remains
KMS/profile-free. Do not add nested percentile deltas to an end-to-end metric.

## Reproduction and environment

From `turbo`, with locked dependencies and the local database migrated:

```sh
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
SECRETS_KMS_KEY_ID=synthetic-benchmark-key \
AXIOM_TOKEN_SESSIONS=synthetic AXIOM_TOKEN_TELEMETRY=synthetic ENV=development \
pnpm -F api exec dotenv -e .env.local -- tsx src/scripts/bench-subscription-decryption.ts
```

The API environment file supplies required application configuration; the
command explicitly selects local PostgreSQL and synthetic KMS/telemetry values.
The script rejects non-local DB hosts and replaces KMS through its scoped
external client. It creates unique synthetic providers/secrets and removes
only those owned rows on completion; it neither exports credentials nor logs
plaintext/SQL parameters. It does not use production KMS, OAuth or profile APIs.

Baseline main: `344201de328c71e9263a61c78901fcafbdd4798c`. The baseline
service was byte-identical to that commit. The candidate differs only in
`credentialValues` scheduling. Both ran sequentially in the same checkout on
2026-09-15 with the identical harness; no other test/check process overlapped.
Initial exploratory runs with random comparison order are excluded.

- Node v22.23.2, pnpm 10.33.4, PostgreSQL 17.11 on Linux.
- cgroup CPU/memory/swap quotas: `max`; shared host, not dedicated CPU/I/O.
- PostgreSQL pool max 8, five fixture owners, one warm-up plus five repetitions
  per scenario; concurrent scenarios have 20 measured operations each.
- Each logical KMS call simulates 20ms; the failure scenario fails call 1 and
  gives call 2 an 80ms service time. This models a slow sibling, not AWS's
  retry algorithm or a measured throttling rate. There is no simulated SQL delay.
- Lockfile SHA-256: `24e98fc1636b7054465e9216e53f27306065f381b514279f301e53c647c3b120`.
- Baseline service SHA-256: `61704fc4e3064cc31e850969608e269074e5fd5a6a90f57b083fc3b1253dc316`.
- Candidate service SHA-256: `1a8de8be2b03268c889f97b540680052ef972c6ab882841c41d803ee5251c6bc`.
- Harness SHA-256: `677d63e23c5c817d4cce4e5644e18995f94555d6950c669a4d4267c146fb63b0`.

The harness emits JSON summaries and source digests. To reproduce a serial
comparison, use the same harness and dependencies with the baseline service
from the above revision in a separate local checkout. Do not mix differing
short-circuit positions: mirror row IDs deliberately preserve field order.

## Results

All times are milliseconds. Values are baseline → candidate; p90 is nearest
rank and, with five samples, equals the maximum. These small samples establish
mechanism and bounded fan-out, not statistical production percentiles.

| Workload              | Queries/op | Logical KMS calls/op | Workload KMS peak |       Total p50 |       Total p90 |   Lock-held p50 |
| --------------------- | ---------: | -------------------: | ----------------: | --------------: | --------------: | --------------: |
| claude                |      7 → 7 |                1 → 1 |             1 → 1 |   28.09 → 28.23 |   29.74 → 30.24 |   25.69 → 27.86 |
| codex                 |      7 → 7 |                4 → 4 |             1 → 2 |   92.76 → 47.51 |  110.44 → 57.26 |   91.93 → 47.16 |
| same-provider-4       |      7 → 7 |                4 → 4 |             1 → 2 | 193.63 → 113.11 | 359.16 → 200.45 |   89.49 → 49.55 |
| different-providers-4 |      7 → 7 |                4 → 4 |             4 → 8 |   95.00 → 51.22 |   99.27 → 92.51 |   92.41 → 48.54 |
| equivalent            |      7 → 7 |              12 → 12 |             1 → 2 | 256.76 → 235.67 | 259.78 → 239.83 | 255.70 → 234.37 |
| replacement           |    22 → 22 |              20 → 20 |             1 → 2 | 437.00 → 291.58 | 451.30 → 304.92 | 436.55 → 291.54 |
| expiry                |      8 → 8 |                4 → 4 |             1 → 2 |   90.47 → 50.09 |   92.66 → 63.04 |   89.44 → 49.38 |
| failure-slow-sibling  |      7 → 7 |                1 → 2 |             1 → 2 |   23.47 → 91.46 |   27.72 → 94.09 |   23.14 → 89.75 |

| Workload              | Advisory wait + round trip p50 | SQL excluding advisory p50 | Summed KMS service p50 |
| --------------------- | -----------------------------: | -------------------------: | ---------------------: |
| claude                |                    0.27 → 0.34 |                4.61 → 5.51 |          21.35 → 20.29 |
| codex                 |                    0.18 → 0.18 |                5.34 → 3.55 |          83.58 → 82.07 |
| same-provider-4       |                 100.57 → 50.21 |                4.67 → 6.01 |          84.23 → 84.73 |
| different-providers-4 |                    0.59 → 0.40 |                9.09 → 7.04 |          83.20 → 83.47 |
| equivalent            |                    0.12 → 0.46 |                4.56 → 9.26 |        247.70 → 260.48 |
| replacement           |                    0.13 → 0.23 |               8.67 → 18.51 |        418.98 → 436.17 |
| expiry                |                    0.18 → 0.30 |                4.31 → 5.52 |          83.29 → 84.15 |
| failure-slow-sibling  |                    0.15 → 0.96 |                2.23 → 5.37 |         20.35 → 102.45 |

Query counts include BEGIN and COMMIT/ROLLBACK. Advisory timing includes its
network/execution round trip, not pure server wait. Held time runs from that
query's client-observed completion through COMMIT/ROLLBACK completion. It
therefore excludes lock acquisition transport and includes commit transport;
tracer timestamp conversion can introduce sub-millisecond rounding/skew.
SQL figures include observed driver round trips and host jitter; differences
are not SQL optimizations. The candidate's four-provider p90 includes a local
SQL outlier. Summed KMS durations overlap in the candidate and cannot be added
to total time.

Equivalent ciphertext performs eight unchanged serial comparison decrypts
plus four materialization decrypts. The legacy same-identity replacement keeps
20 logical decrypts and 22 queries; its four bundle materializations benefit,
but short-circuit comparison is unchanged. Expiry measures reconciliation of
provider-only expired/reconnect metadata, not the OAuth exchange. Actual
rotating refresh is covered through production route tests separately.

## Safety and trade-offs

- Successful Codex work keeps four logical KMS calls but allows two concurrently.
  Four independent provider owners peak at eight instead of four. This is a
  per-bundle cap, **not a process/fleet quota**; ordinary same-provider requests
  remain serialized by the existing lock.
- The deliberate failure case rejects all five operations in each version and
  has zero active decrypts at every return. It starts one extra call and takes
  about 91ms instead of 23ms because the slow sibling is joined. No later batch
  starts. A sibling's real SDK retry/timeout can extend this error wait further.
- SDK retry/backoff configuration is unchanged; there is no application retry
  or new throttle. [AWS retry documentation](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html)
  describes retry ownership. This experiment does not measure production quota
  headroom, retry attempts, throttling probability or outage tails.
- The inherited KMS boundary has no transport AbortSignal. The transaction owner
  joins started calls, including rejections, rather than returning and leaving
  unobserved requests. This change does not promise immediate HTTP-cancelled
  KMS or a new maximum lock duration.
- No plaintext cache, snapshot persistence, sensitive telemetry or route/model/
  payment reselection. Connected/inactive/retained account predicates and
  lifecycle-before-provider order are unchanged.
- Old/new API instances use the same locks and encrypted rows; no migration,
  frontend/Runner dependency, coordinated rollout or new fallback is needed.
  Keep the historical writer and rollback/cleanup gates owned by #34010.

## Behavioral verification

The subscription identity route suite covers Claude/Codex admission, inactive
and retained sources, independently re-encrypted bundles and actual historical
writers, management recovery, supported Pi execution and hard revocation.
Additional delayed-KMS cases exercise same-identity reconnect, activation,
disconnect, membership removal, final retained-reference cancellation and a
failed batch with a pending sibling. PostgreSQL waiter observation is an
explicit infrastructure synchronization exception; assertions use production
HTTP responses and emitted Authorization/account-ID headers.

The retained refresh regression also holds bundle decrypts while another
runtime request waits, then verifies exactly one upstream refresh and the
same paired token/account for both requests. Performance thresholds are not
correctness assertions. Broader provider-management/firewall/Pi checks and CI
are recorded in the PR separately from these local experiment results.
