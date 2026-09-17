# Decoded-cache first-warm attribution (#34821)

## Decision and scope

This investigation supports an **insufficient-evidence conclusion for a causal
first-warm regression or production startup improvement**. It preserves the
original adverse observation and the separately established avoided-work benefit
of [#34823](https://github.com/vm0-ai/okou/pull/34823). It does not justify another
runtime optimization, permanent telemetry, or a production rollout.

The measurement issue is [#34821](https://github.com/vm0-ai/okou/issues/34821),
under [#34790](https://github.com/vm0-ai/okou/issues/34790). Scheduler fairness
(#34816), positive-observation suppression (#34823), and rejection classification
(#34964) are different treatments. Results from their different baselines must
not be pooled. This report changes no runtime behavior, budgets, or cache format.

## Measurement boundaries

All synthetic cells use real cache files, locks, decoding, admission and workers,
with external sandbox/HTTP boundaries mocked. Archives contain one 64 KiB file
compressed with stored gzip; rejected cells use 256 KiB + 1 byte. These fixtures
are not an observed production workload distribution.

- Preparation includes the real cache preparation/population entry point.
- Background time includes deferred admission, workers, local telemetry and
  coordinator drain. The existing idle helper polls at 1 ms, so small wall-time
  differences include completion-observation latency.
- Cache time is each sample's preparation plus background time **before** taking
  quantiles; independent percentiles are never added.
- CPU is test-process user plus system CPU, not exclusive decoder CPU.
  `/proc/self/io` supplies logical bytes/calls and kernel-accounted physical
  bytes. These include the harness and telemetry within the measured boundary.
- RSS is sampled process residency. HWM is lifetime process high-water memory,
  including earlier fixtures, mocks and allocator retention; neither measures
  the peak of one decoded task. Linux RSS/HWM accounting is approximate.
- First-warm publication verification runs after both timed windows. It checks
  exact contents without counting validation as warming cost, but can affect
  subsequent page-cache and allocator state.

The host page cache is warm; physical read bytes are zero in the retained
first-warm cohorts. Physical writes are kernel accounting during the interval,
not a disk-latency measurement. No host-wide cache drop was performed. Four
background workers, 32 waiting slots, two optional decoded workers and the
64 MiB decoded budget remain unchanged.

Synthetic quantiles use nearest rank. Each variant/cell has 20 samples: p95 is
the nineteenth ordered value and p99 is the observed maximum, not a reliable
estimate of a production p99. ABBA controls simple order drift but does not
eliminate shared-host noise or establish statistical significance.

## Original positive-observation experiment

Baseline: `9cf9d91452b2401e54ef6f8b84abdd4d378a10bb`; candidate: that source plus
the original positive-observation patch retained in the evidence. This predates
the scheduler and rejection-classifier changes. The four fixed ABBA blocks each
contain ten samples for eight cells, giving 320 rows. All rows are retained.

The original meter counts decoder entries. Unlike the later verified harness,
it does not independently inspect every first-warm publication after timing.

| First-warm cell | Decodes B / C | Cache p50 B / C (ms) |             p90 |             p95 |   p99 / maximum | Mean total CPU B / C (ms) |
| --------------- | ------------: | -------------------: | --------------: | --------------: | --------------: | ------------------------: |
| 1 key           |       20 / 20 |        6.424 / 6.488 |   7.011 / 7.260 |   7.323 / 7.591 |   7.890 / 7.676 |           2.1067 / 1.9600 |
| 32 keys         |       40 / 48 |      13.977 / 16.010 | 16.343 / 20.303 | 16.633 / 24.910 | 27.333 / 28.004 |         21.3946 / 23.1233 |

The 32-key preparation p90 is 7.708 / 7.567 ms; background p90 is
8.900 / 12.963 ms. Mean preparation CPU is 11.3098 / 11.7775 ms;
mean background CPU is 10.0848 / 11.3459 ms. The adverse wall-time difference is
in the background distribution, but these measurements do not identify a
specific slow operation.

Every baseline pass decodes two keys. Candidate passes decode two keys in 14
samples, three in four samples and four in two samples. This follows the
nonwaiting optional decoded-worker budget: worker scheduling changes how much
useful work is accepted, even though the budget itself is unchanged.

Restricting the candidate descriptively to its 14 two-decode samples gives cache
p50/p90/p95/p99 of 14.886/17.281/28.004/28.004 ms, versus
13.977/16.343/16.633/27.333 ms for all 20 baseline two-decode samples. The p90
gap becomes 0.938 ms, but the worst candidate remains. This is a
post-treatment stratum, **not** a randomized equal-work experiment; it cannot
prove that extra decoding explains the entire original 3.960 ms p90 gap.

Resource totals below cover all 20 first-warm samples per variant. Preparation
logical reads are identical: 1,375,884 bytes for one key and 42,981,140 bytes for
32 keys in each variant. Preparation physical reads/writes are zero.

| First-warm cell | Background logical read B / C (bytes) | Background logical write B / C (bytes) | Background physical write B / C (bytes) | Max sampled RSS B / C (KiB) | Lifetime HWM max B / C (KiB) |
| --------------- | ------------------------------------: | -------------------------------------: | --------------------------------------: | --------------------------: | ---------------------------: |
| 1 key           |                 1,375,884 / 1,375,884 |                  1,331,788 / 1,331,780 |                   1,392,640 / 1,392,640 |             34,180 / 32,088 |              32,532 / 30,528 |
| 32 keys         |                 2,718,140 / 3,254,980 |                  3,120,938 / 3,647,179 |                   2,785,280 / 3,342,336 |             58,596 / 54,728 |              82,200 / 80,324 |

The additional 536,840 logical read bytes and 557,056 physical write bytes in
the 32-key candidate are consistent with eight extra decodes/publication writes.
They do not isolate the CPU or scheduling cost of those decodes. The one-key
control does equal decoder work with identical logical reads and physical
writes; its small p90 increase accompanies lower mean CPU.

The ready/conflicted cell's avoided work remains a separate valid result:
640 redundant worker admissions become zero, with no decompression in either
variant. Its timing is not evidence about useful first warming or actual startup.

## Fixed equal-work replication

The follow-up ran once at 13:57:48–13:57:51 UTC on September 17 on dev-11:
64 logical CPUs, Xeon Platinum 8581C, about 125 GiB RAM, Rust 1.98.1.
Both binaries were rebuilt from the original pinned baseline and candidate
patch with identical meter hooks and publication-verifying harness. Builds used
locked dependencies, optimized `ci`, LTO disabled, 16 codegen units and eight
jobs. This is not the production release profile. Copied caches and restored
compile-time fixtures were isolated from the previous experiments.

The predeclared cells were first-warm with 1, 2 and 32 keys, plus one ready-selected
key. Four ABBA blocks of ten samples/cell produced 160 rows. All four tests and
content assertions passed; no setup failures, discarded samples or timing-driven
reruns occurred. All requested one-/two-key contents were published. Each
32-key contention pass published exactly two keys in both variants, so it still
skipped 30 optional warms rather than completing all requested keys.

| Cell                  | Verified new publications B / C | Cache p50 B / C (ms) |             p90 |             p95 |   p99 / maximum | Mean total CPU B / C (ms) |
| --------------------- | ------------------------------: | -------------------: | --------------: | --------------: | --------------: | ------------------------: |
| First-warm, 1 key     |                         20 / 20 |        6.560 / 6.164 |   7.769 / 8.062 |   7.844 / 8.332 | 10.854 / 10.036 |           2.1373 / 2.1525 |
| First-warm, 2 keys    |                         40 / 40 |        7.240 / 7.363 |   8.390 / 8.988 |   8.654 / 9.197 |   9.815 / 9.372 |           3.2780 / 3.3513 |
| First-warm, 32 keys   |                         40 / 40 |      14.415 / 13.996 | 16.256 / 15.979 | 16.279 / 16.405 | 16.791 / 16.593 |         20.5230 / 19.4952 |
| Ready-selected, 1 key |                           0 / 0 |        0.348 / 0.331 |   0.426 / 0.522 |   2.624 / 2.312 |   3.527 / 2.416 |           0.4866 / 0.4833 |

Ready-selected still verifies delivered existing contents; it requires no new
publication. Its first pass per block retires the existing archive, so its tail
includes that unchanged lifecycle work.

| First-warm cell | Preparation p90 B / C (ms) | Background p90 B / C (ms) | Mean preparation CPU B / C (ms) | Mean background CPU B / C (ms) |
| --------------- | -------------------------: | ------------------------: | ------------------------------: | -----------------------------: |
| 1 key           |              0.690 / 0.680 |             7.236 / 7.152 |                 0.6077 / 0.6088 |                1.5296 / 1.5437 |
| 2 keys          |              0.810 / 0.728 |             7.544 / 8.380 |                 0.9169 / 0.9342 |                2.3611 / 2.4171 |
| 32 keys         |              7.635 / 7.148 |             8.725 / 9.013 |               11.4381 / 10.8489 |                9.0849 / 8.6463 |

The original 3.960 ms adverse 32-key cache p90 gap is not reproduced in this
fixed equal-completion cohort. Smaller adverse one-/two-key p90 differences
(0.293 / 0.598 ms) remain, as does a slightly higher 32-key background p90 despite
lower total p90. These results neither erase the original tail nor prove
no regression. The host had unrelated Runner activity; recorded load averages
were about 4–6 across 64 CPUs. Our builds had finished before measurement.
Snapshots cannot exclude transient contention, and the short experiment does
not sample long-term host variability.

| First-warm cell | Background logical read B / C (bytes) | Background logical write B / C (bytes) | Physical write, each variant (bytes) | Max sampled RSS B / C (KiB) | Lifetime HWM max B / C (KiB) |
| --------------- | ------------------------------------: | -------------------------------------: | -----------------------------------: | --------------------------: | ---------------------------: |
| 1 key           |                 1,375,732 / 1,375,732 |                  1,331,844 / 1,331,828 |                            1,392,640 |             32,452 / 32,436 |              30,236 / 30,576 |
| 2 keys          |                 2,718,000 / 2,718,010 |                  2,662,304 / 2,662,368 |                            2,785,280 |             34,260 / 34,548 |              30,236 / 31,088 |
| 32 keys         |                 2,718,088 / 2,718,088 |                  3,122,064 / 3,121,464 |                            2,785,280 |             46,520 / 45,632 |              40,988 / 42,260 |

These are totals/maxima over 20 samples, not per-pass values. All physical reads
and preparation physical writes are zero. Preparation logical read totals are
1,375,730 / 1,375,730; 2,718,000 / 2,718,014; and
42,981,098 / 42,981,094 bytes for 1/2/32 keys respectively. Small logical-byte
differences include `/proc` snapshots. The evidence contains every phase's
CPU/I/O distribution and read/write call counts, including unchanged controls.

## Later rejection-classifier control

The separate [#34820 experiment](https://github.com/vm0-ai/okou/issues/34820#issuecomment-5712160912)
uses baseline `e9001cdc0e69e7246209e62e2995a388a82077b5`, already containing the
scheduler and positive-observation changes. Its candidate adds the bounded
post-spawn rejection classifier. All 320 fixed ABBA rows are retained, including
adverse cells; first-warm contents are independently verified after timing.

| First-warm cell | Verified publications B / C | Cache p50 B / C (ms) |             p90 |             p95 |   p99 / maximum | Mean total CPU B / C (ms) |
| --------------- | --------------------------: | -------------------: | --------------: | --------------: | --------------: | ------------------------: |
| 1 key           |                     20 / 20 |        5.310 / 6.629 |   6.724 / 7.614 |   7.015 / 7.941 |   7.110 / 8.312 |           2.0049 / 2.4096 |
| 32 keys         |                     41 / 41 |      14.576 / 14.114 | 15.946 / 16.265 | 16.730 / 16.715 | 20.158 / 16.993 |         21.5054 / 21.5051 |

The one-key classifier has real overhead: mean background CPU rises from
1.4784 to 1.9042 ms, while preparation CPU falls from 0.5265 to 0.5054 ms.
Preparation p90 is 0.603 / 0.614 ms and background p90 is 6.149 / 7.150 ms.
An extra source/rejection observation, classifier ownership and telemetry are
added by this different treatment. Its +0.890 ms cache p90 and +0.4047 ms mean
total CPU passed that experiment's predeclared +1 ms / +0.5 ms adverse gates;
that is an accepted trade-off, not absence of cost or a startup improvement.

At 32 keys, both variants have nineteen two-publication samples and one
three-publication sample. Mean background CPU still rises 10.0117 → 10.8670 ms;
lower preparation CPU offsets it in the total. Equal total CPU does not mean
every phase improved. The unchanged ready/conflicted 32-key control's p90 also
rises 11.766 → 12.958 ms without classifier/worker work, illustrating noise.

Logical read totals and physical writes match within each first-warm cell.
One-key background logical writes rise 1,331,700 → 1,344,708 bytes; 32-key writes
rise 3,131,827 → 3,199,759 bytes. Max sampled RSS is 32,576 / 33,312 KiB for one
key and 54,172 / 55,948 KiB for 32 keys. Corresponding lifetime HWM maxima are
31,436 / 30,812 and 81,600 / 80,308 KiB. Full phase distributions and syscall
counts remain in the evidence; these process-level memory figures are not
per-classifier peak measurements.

## Production evidence and provenance

Eight read-only Axiom queries cover fixed September 17, 2026 UTC windows
02:30–03:30 and 12:30–13:30 in `vm0-sandbox-op-log-prod`. Every response returned
HTTP 200, `isPartial=false`, matching request/response ranges and reconciled
group/event counts. Results describe records ingested when queried; ingestion
was not frozen, and missing producer events are not ruled out.

All filtered cache/startup records have canonical host and version fields on
prod-11/12/13. Full-dataset records also include missing attribution and a small
older-version residue; those are not silently assigned to these cohorts.

| Window (UTC) | Reported package version | Release source                             |
| ------------ | ------------------------ | ------------------------------------------ |
| 02:30–03:30  | 0.196.2                  | `6c6426fdc90432395c27f3abf4dc5c43ec4630d1` |
| 12:30–13:30  | 0.197.3                  | `771703233e671808a6a3f4c5e7c535721adfd948` |

Source commits are resolved from the live `runner-rs-v<version>` tags and their
Cargo package versions. This establishes telemetry version-to-release mapping,
not binary hash attestation. The later release contains #34823 and #34816 plus
other timing changes. It does **not** contain rejection classification #34964,
which merged at 13:33:29 UTC, after the sampled window. That change is present in
inspected main `03c5bb16012c48891f6784e01c3555cb232812f4`, but merged current
main is not proof of deployment. The later production window therefore cannot
evaluate the rejection classifier's production benefit or overhead.

| Emitted operation records         | Early count | Early duration sum (ms) | Later count | Later duration sum (ms) |
| --------------------------------- | ----------: | ----------------------: | ----------: | ----------------------: |
| `background_fill_already_cached`  |         962 |                     859 |          93 |                     109 |
| `background_fill_queue_saturated` |       2,502 |                       0 |          11 |                       0 |
| `background_fill_filled`          |           1 |                     122 |  0 observed |              0 observed |
| `decode_lookup`                   |         112 |                     482 |          37 |                     400 |
| `decoded` delivery                |       2,850 |                       0 |         959 |                       0 |

Operation names above have the `storage_cache_` prefix. Counts are not unique
physical jobs. `already_cached` identifies a compressed archive hit and can
include useful decoding, a positive/rejected skip, or unavailable decoded
capacity. A deduplicated worker reports the same result/duration to each run
subscriber. `decoded` counts selected deliveries, not ready-but-unselected
observations. Queue saturation has no rejected-key/purpose dimension. Bucket
counts are not exact job counts; `17_plus` is open-ended. Zero-duration category
records do not mean zero resource use.

These interpretations follow the deployed release's
[worker and subscriber reporting](https://github.com/vm0-ai/okou/blob/771703233e671808a6a3f4c5e7c535721adfd948/crates/runner/src/storage_cache.rs#L860),
[archive-hit result](https://github.com/vm0-ai/okou/blob/771703233e671808a6a3f4c5e7c535721adfd948/crates/runner/src/storage_cache.rs#L2914)
and the [host/version attribution contract](runner-host-configuration.md).

The existing records provide neither decoded-outcome incidence nor exclusive
CPU/I/O/memory cost for positive, rejected and useful warming. Worker durations
exclude queue residence; deferred delay ends at deferred start, not worker
dispatch. Duration rounding also limits sub-millisecond attribution. No ratio
or sum of these records recovers the missing classification. The count decrease
between windows is descriptive and cannot be credited to one cache change.
Reported-duration sums are not an upper bound on queue harm or startup impact.

The original evidence package has a provenance mismatch: its archived request
and response span **September 16 21:30–September 17 03:30 UTC**, six hours, while
the narrative cites one-hour figures. The archived response has 1,113
`already_cached` and 2,691 saturation records; it cannot reproduce the narrative
961 / 2,316 one-hour counts. A separate unarchived query or later ingestion may
explain the difference, but is unverified. Use the fresh exact one-hour queries
above for that window, not the mislabeled package as a one-hour rate.

## Actual startup remains a separate observation

Each window contains 156 / 96 successful `api_to_agent_ready` observations and
the same numbers for `api_to_spawn`. They are not matched to decoded workload,
API revision, concurrency or page-cache state. This is not a failure-rate sample.

| Agent-ready cohort    | Early n | Early p50 / p90 / p99 (ms) |    Later n | Later p50 / p90 / p99 (ms) |
| --------------------- | ------: | -------------------------: | ---------: | -------------------------: |
| cold / pool miss      |      30 |      1,070 / 1,657 / 2,877 |         19 |      1,028 / 1,488 / 1,603 |
| sandbox / reused      |      81 |        784 / 1,261 / 1,664 |         67 |      1,364 / 2,069 / 3,012 |
| workspace / pool miss |      37 |      1,773 / 2,323 / 3,006 |         10 |      1,962 / 2,838 / 2,838 |
| cold / no reuse key   |       8 |   32,133 / 62,605 / 62,605 | 0 observed |                unavailable |

These are Axiom-computed cohort quantiles, rounded to milliseconds; raw values,
spawn distributions and host subdivisions are preserved in the evidence.
Workload mix and multiple intervening changes prevent a causal comparison.
The adverse reused/workspace observations are retained. Neither these data nor
the synthetic cache-phase results justify a general startup-speed claim.

## Reproduction and verification

The [issue evidence receipt](https://github.com/vm0-ai/okou/issues/34821#issuecomment-5715659066)
supplies the [full raw package](https://a.okou.io/mq8soocpwv.zip), checksums,
analysis scripts, exact Axiom requests/responses, patches and harnesses. Archive
SHA-256: `e2393d58c87a673e06c20f331d105ab48286c3a0c24f77a94d8fd837c9c7803c`. The
original evidence is retained unchanged alongside its correction. Recompute
all 800 fixed ABBA samples with the package's `analyze.py`; it checks exact
cells/sample indices, successful test exits, foreground-work exclusions and
available publication invariants before producing distributions.

To repeat the synthetic experiment, use an isolated checkout of
`9cf9d91452b2401e54ef6f8b84abdd4d378a10bb`, Rust 1.98.1 and `umask 077`.
Copy the replication's `probe.rs`/`meter.rs` into
`codex-work/research/issue-34790/` and apply its `instrumentation.patch`.
Build baseline with:

```sh
cargo test --locked --manifest-path crates/Cargo.toml --profile ci \
  --config profile.ci.lto=false --config profile.ci.codegen-units=16 \
  -j 8 -p runner --bin runner --no-run --message-format=json-render-diagnostics
```

Preserve the exact executable emitted by Cargo's runner test artifact, then
apply the original `candidate.patch`, rebuild with identical flags and preserve
the candidate executable. Do not select a stale executable by a filename glob.
The package's `build.sh` records the executed offline build, including copied
caches and missing compile-time fixtures; adapt those development-only paths
for a fresh checkout. The synthetic measurement uses neither production files
nor credentials.

Run the exact ignored test
`storage_cache::tests::issue_34821_measure` with `PROBE_SAMPLES=10`,
`--exact --ignored --nocapture --test-threads=1` in the recorded ABBA order
(`measure.sh`). Do not compile concurrently or rerun to select better results.
Post-measurement content verification, phase/resource snapshots and all adverse
samples are mandatory. Compiler/harness/source hashes are in the package;
the measured binary SHA-256 values are:

- Baseline: `c02ac5a94287897ac283e1cb199713a031b4947f87d34f26ad44806bc1788b6f`.
- Candidate: `bc58a1a36b9092df47ba36a909cfac061d859a12cc111b1c897d568f61dd609d`.

The report's validation includes all three cohort recomputations, independent
numeric/source review, complete production-response reconciliation, Markdown
formatting, relative-link checks and diff/file-size checks. A documentation-only
change does not require unrelated runtime suites. The manual measurement tests
are evidence for the pinned experimental source, not current-main runtime tests.

## Acceptance disposition

Useful work, phase timing, CPU, logical/physical I/O and memory are reported
separately, with adverse samples retained. Existing production versions and
event incidence are established; classification-specific incidence and impact
remain unidentifiable from these records. Cold-page-cache and causal
VM/Agent/API startup effects remain unmeasured.

This is the issue's allowed insufficient-evidence outcome, not a claim that all
regressions are excluded. A future production experiment would need a
predeclared matched workload and stable work/outcome identity, explicit rollout
authority, and separate resource/startup measurements. No permanent telemetry is
added merely to fill that gap. Parent #34790 and its ancestors remain open.
