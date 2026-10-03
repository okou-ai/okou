# Local Guest archive profiling

This tool investigates the extraction interval already attributed by the local
archive telemetry. It runs the real `guest-storage-apply` extractor on synthetic
local tar.gz files. It does **not** change storage behavior, select an optimization,
measure startup savings, or add production telemetry.

The collector, reader wrappers and phase scopes are compiled only with
`cfg(test)`. Ordinary helper builds contain none of them. The profiling test is
ignored by default; normal correctness tests do not run the repeated workload.

## Run

From the repository root, record the compiler, filesystem and resolved backend
features alongside the measurement. The temporary targets use `TMPDIR`, or the
system temporary directory when it is unset.

```bash
set -o pipefail
mkdir -p codex-work/archive-profile
rustc --version
# On Linux; record whether targets are on tmpfs, overlayfs, or another filesystem.
df -T "${TMPDIR:-/tmp}"
cargo tree --manifest-path crates/Cargo.toml --locked \
  -p guest-storage-apply -e features
cargo test --manifest-path crates/Cargo.toml --release --locked -j 1 \
  -p guest-storage-apply --lib archive::profile::tests::local_archive_profile \
  -- --ignored --exact --nocapture --test-threads=1 \
  | tee codex-work/archive-profile/local.log
```

Do not run other heavy checks or benchmarks concurrently. Use the documented
release build rather than an unoptimized local build for performance readings.
Record the commit and Cargo arguments with results. A synthetic host filesystem
is not the production Guest filesystem; do not transfer its timings directly.

## Workloads and measurement boundary

All files have deterministic bytes, mode `0640` and a fixed modification time.
The gzip compression level is the library default. There are no network requests
or customer archives, paths, URLs, names or content in the output.

| Case                   | Files | Bytes per file | Directory depth | Content                  |
| ---------------------- | ----: | -------------: | --------------: | ------------------------ |
| `small_many_files`     |   128 |          2,048 |               2 | Repeated bytes           |
| `tiny_high_fanout`     | 1,024 |            128 |               6 | Repeated bytes           |
| `large_compressible`   |     8 |        262,144 |               1 | Repeated bytes           |
| `large_incompressible` |     8 |        262,144 |               1 | Fixed-seed xorshift data |

Archive generation/writing, source opening, target creation/canonicalization,
output content/metadata checks and cleanup are outside extraction timing. Every
iteration extracts into a fresh empty target. The source remains in the warm
page cache; this is not a cold-disk or durable-write benchmark. There is no fsync.

Each case has two warmups per mode and 21 measured samples per mode. Baseline and
profiled order alternates between iterations. Both call the same extractor; the
baseline is an **inactive-observer test build**, not the production binary. Reader
wrappers still exist in that baseline, so it cannot establish zero overhead
against production. Compare its wall/CPU distribution with profiled samples to
understand observer perturbation, not a code speedup.

## Phase meanings

Each profile sample reports fixed phases with call counts and inclusive/exclusive
nanoseconds. A nested scope's elapsed interval is subtracted from its parent
within that sample. Never subtract independently aggregated phase percentiles.

| Phase              | Inclusive boundary                                       | Exclusive interpretation                                      |
| ------------------ | -------------------------------------------------------- | ------------------------------------------------------------- |
| `compressed_read`  | Underlying source `Read::read` calls                     | Source-read wall time                                         |
| `gzip_read`        | GzDecoder `read` calls, including compressed reads       | Decoder/buffering work outside observed compressed reads      |
| `tar_metadata`     | Tar setup, iteration and per-member metadata-budget work | Tar/metadata work outside nested reader scopes                |
| `entry_validation` | Entry path, link and physical-ancestor checks            | Validation outside any nested reader calls                    |
| `unpack`           | Accepted entry `unpack_in`                               | Filesystem operations **and tar bookkeeping** outside readers |
| `trailer`          | Final same-decoder drain after the tar end marker        | Drain/metadata overhead outside readers                       |

Gzip reader work occurs during tar iteration, unpacking and trailer validation;
those inclusive columns overlap. Their exclusive columns partition observed
scope work, but do not include all observer bookkeeping or setup. Total extraction
wall also includes work outside the scopes. Whole-sample exclusive sums are
checked against whole extraction wall; sums of separate p90s are not meaningful.

`gzip_read` exclusive wall time is **not pure CPU**: scheduling and observer
bookkeeping are included. `unpack` exclusive is **not pure syscall time**. Use a
host flamegraph or syscall profiler if a later investigation needs that distinction.
Do not cache or remove required path/link/integrity checks based on these labels.

## Output

The Cargo harness surrounds JSON lines with its ordinary test output. Parse lines
with these prefixes; keep the raw samples, not just the summary:

- `ARCHIVE_PROFILE_CONTEXT`: architecture, OS, crate version, optimized-build
  indication, warmup/sample counts and observation scope.
- `ARCHIVE_PROFILE_SAMPLE`: case, zero-based iteration, mode, `wall_ns`, `cpu_ns`,
  `outside_scopes_ns` and `phases`. Baseline phase/residual data is `null`, not zero.
  Each profiled phase has `calls`, `inclusive_ns` and `exclusive_ns`. The residual
  includes setup and observer bookkeeping not timed within scopes.
- `ARCHIVE_PROFILE_SUMMARY`: case shape, compressed bytes and distributions for
  each mode. Every distribution reports `n`, nearest-rank `p50`, `p90`, `p95`;
  fields with no observations are `null`.
- `ARCHIVE_PROFILE_RESOURCES`: Linux peak process RSS in KiB, or `null` when
  unsupported. It covers the **whole test process**, including fixture generation
  and verification, not extraction-only memory or a per-iteration allocation cap.

CPU samples use Linux `clock_gettime(CLOCK_THREAD_CPUTIME_ID)` around the whole
extraction and include measurement/observer bookkeeping. Non-Linux CPU fields are
unavailable (`null`); a failed supported-platform query fails the harness instead
of emitting zero. CPU and wall values use nanoseconds, not a claim of nanosecond
measurement accuracy. The harness does not report actual syscall counts,
user/system CPU splits or per-phase CPU usage.

## Correctness and interpretation

The extractor still validates metadata budgets, entry paths, symlink/hardlink
sources, physical ancestors and the gzip CRC/size trailer. Extraction remains
non-atomic: files accepted before a late error remain in place. Normal tests check
profile state cleanup, nested-session rejection, reported quantiles, output/metadata
and late corrupt/missing-trailer behavior; existing archive/property and integration
security tests remain unchanged. There are no elapsed-time assertions.

Use the result to name a concrete candidate, then validate that candidate with
controlled correctness/resource tests and production same-run, startup-path
attribution. Storage overlaps other preparation on eligible Workspace runs, so
removing even a whole local component interval is only an optimistic bound. This
tool alone cannot satisfy the production startup retention gate or justify a
codec, ownership, batch-limit, scheduling, cancellation or protocol rewrite.
