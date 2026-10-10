# Rust Testing Guide

## Overview

Rust crates live in `crates/` and use `cargo test` for testing. The same principles from [testing.md](../testing.md) apply: integration tests are primary, mock at the boundary, use real infrastructure.

Runner's full suite includes a real Rust/Python registry-control round trip.
First run `uv sync --locked --project crates/runner/mitm-addon` from the repository
root, as described in the [addon guide](mitm-addon-testing.md). The test uses that
locked `.venv/bin/python` directly and fails if it is unavailable; it does not
download dependencies, contact APIs, or silently skip the integration. Crates
coverage prepares the same environment before running tests. The status/log-only
control tests retain their standard-library Python boundary.

## Running Tests

Use the `local` profile for routine local validation. It retains source locations in
backtraces for workspace crates and omits full debug information and incremental
artifacts. Non-workspace dependencies omit debug information entirely to reduce
build output and file-cache pressure, so their frames may lack source lines.
Omit `--profile local` when dependency source lines, full debug information, or
incremental compilation are more useful.

```bash
# All crates
cargo test --manifest-path crates/Cargo.toml --profile local

# Specific crate
cargo test --manifest-path crates/Cargo.toml --profile local -p guest-agent

# Extracted Runner host primitives and their owner tests
# Host covers process-identity persistence. Runner's start integration checks
# identity allocation before later setup failure.
cargo test --manifest-path crates/Cargo.toml --profile local \
  -j 1 -p runner-host -- --test-threads=1

# Host-owned systemd primitives and retained Runner command composition
# Runner covers reload, stop, drain/resume, unit generation and output composition.
# Private Host fixtures use its non-default test-support feature, requested by
# Runner only as a dev-dependency.
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -j 1 -p runner-host -p runner -- --test-threads=1

# Extracted Runner provider coordination and its owner tests
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -j 1 -p runner-provider -- --test-threads=1

# Extracted Runner network behavior, mitmdump recovery, and owner tests
# Recovery includes fatal cleanup and cancelled wait coverage.
# Main-loop crash/panic/shutdown coverage belongs to the Supervisor reactor;
# select that ordinary owner target separately below.
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -j 1 -p runner-network -- --test-threads=1

# Extracted Runner guest RPC, usage, SSH, and VNC owner tests
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -j 1 -p runner-remote -- --test-threads=1

# Extracted Runner storage planning and cache owner tests
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -j 1 -p runner-storage -- --test-threads=1

# Storage-cache GC and retained Runner policy/report composition
# Exercise explicit age propagation and Runner's defaults, grace, dry-run,
# zero-byte/allocated-byte activity, reports and errors.
# The low-NOFILE ordinary parent invokes exactly one guarded ignored child:
# cache_gc::tests::gc_storage_cache_many_candidates_low_fd_child,
# with OKOU_RUNNER_STORAGE_LOW_FD_STORAGE_GC_CHILD=1 and its 60s bound.
# Private directory iteration faults use Host's non-default test-support feature;
# normal production builds do not enable it. Warm scoped tests do not replace
# the complete native target selection below.
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -j 1 -p runner-host -p runner-storage -p runner -- --test-threads=1

# Host-owned orphan-workspace GC and retained Runner policy/report composition
# Run both owner and composition targets for workspace/held-lease/retry behavior,
# explicit-age propagation and Runner's defaults, reports and errors.
# Shared GC and immutable report fixtures use non-default Host test-support;
# production report, candidate, lease and removal-hook state stay private.
# Preserve ordering between initial candidates, the fixed age reference,
# complete ownership snapshots and later held leases. Cover Runner's global
# lock/phase policy as well.
# Scoped correctness tests do not replace the complete native target selection
# below or establish compile-memory savings.
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -j 1 -p runner-host -p runner -- --test-threads=1

# Extracted Runner active-run, idle sandbox, workspace and cache snapshot owner tests
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -j 1 -p runner-lifecycle -- --test-threads=1

# Extracted Runner claimed-run execution and session-history owner tests
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -j 1 -p runner-executor -- --test-threads=1

# Extracted Runner idle, pre-claim admission/rollback and pending-candidate state, finalizing-successor arbitration, claimed activation, post-executor finalizing/report ordering/sandbox finalization/settlement, heartbeat, and orphan-recovery owner tests
# Supervisor's ordinary unit target covers policy and cross-domain runtime through
# the actual reactor/factory/dispatch/maintenance entries, without test=false,
# source inclusion, filtering or copied provider fixtures. Runner retains boot,
# configuration, CPU-placement and early-signal coverage, including guarded ignored
# children invoked by their ordinary parents. Root/Host tests cover the seams.
# Explicitly gated signal/shutdown controls use non-default test-support; default
# production dependencies do not enable that feature.
# Run both Supervisor and retained Root/Host coverage for this boundary.
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -j 1 -p runner-host -p runner-supervisor -p runner -- --test-threads=1

# Guarded idle terminal phases, physical memory ownership and retained callers.
# Native packaged-guest saving is a separate opt-in fixture; see below.
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p runner-host -p runner-lifecycle -p runner-supervisor -p runner \
  -- --test-threads=1

# Complete native Runner and extracted-domain test set, with ordinary Cargo targets
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p runner-types -p runner-host -p runner-provider -p runner-storage \
  -p runner-network -p runner-remote -p runner-lifecycle -p runner-executor -p runner-supervisor \
  -p runner -- --test-threads=1

# Specific test by name
cargo test --manifest-path crates/Cargo.toml --profile local \
  -p shell-quote --lib tests::quoted_words_round_trip_through_posix_shell -- --exact

# With output (for debugging)
cargo test --manifest-path crates/Cargo.toml --profile local -- --nocapture
```

### Memory-constrained environments

Keep local validation scoped to the affected crate or test target. When the
machine is memory-constrained, serialize both compilation and test execution:

```bash
cargo test --manifest-path crates/Cargo.toml --profile local \
  -j 1 -p guest-agent -- --test-threads=1
```

`-j 1` limits Cargo to one compilation job, while `--test-threads=1` limits
concurrency inside each test executable. They control different stages and may
both be necessary.

A test-name filter, including `--exact`, is applied only after Cargo compiles
the crate's complete test executable. It therefore does not reduce compile-time
memory for a crate with a large inline test suite. If one test target still
exceeds the available memory when serialized, use a larger execution profile or
split the test target into smaller compilation units. A narrower local check
does not replace required CI.

Pre-commit hooks run `cargo fmt` and `cargo doc --profile local` on staged Rust
files. Clippy remains in the Crates CI workflow. To run it locally from `crates/`,
use `cargo clippy --profile local --all-targets --all-features`.

### Native terminal saving

The [guarded idle fixture](../../crates/runner/tests/guarded_idle_native/README.md)
defines matching packaged artifacts, disposable workspaces and required supplied
memory measurements for its root/KVM/NBD test. Ordinary Cargo targets compile it;
execution requires explicitly selecting the ignored native case. Keep native
execution separate from ordinary mock-boundary coverage, and report unavailable
native prerequisites as unverified rather than a passing result.

## Coverage in CI

The Crates coverage job installs pinned `cargo-llvm-cov` and `cargo-nextest`
versions and runs the full target/feature selection through nextest. It limits
execution to eight concurrent tests on the eight-core runner, while retaining
R2 sccache, the existing Rust cache, line-tables-only debug information, and the
locked Python addon setup.

After preparing the addon environment from the repository root, run the same
coverage command from `crates/`:

```bash
cargo llvm-cov nextest --all-targets --all-features --test-threads 8 \
  --lcov --output-path lcov.info
```

Nextest schedules tests across executables and runs each case in a separate
process. Guest mock fixtures recognize the verified Cargo or nextest parent
session so the mock binaries are built once per invocation, not once per case.
The job requires a nonempty LCOV report with at least one source file, then
logs the unique normalized source-file count and source-set SHA-256 before
uploading to Codecov. It does not compare the digest against an expected value;
failed coverage still fails the Crates gate.

## Test Organization

### Keep large fixtures cheap without weakening their contracts

Remove redundant setup and observation instead of reducing a slow test's workload.
A sequential authentication matrix may share freshly generated invariant synthetic
server material within that test, but each client exchange and session proof must
remain independent. Do not commit private keys or cache production credentials.
Batch consecutive fixture filesystem setup in one blocking task only when no
assertion, peer interaction or scheduling gate lies between the operations.
Retain every real filesystem operation and await the batch before publishing
metadata or entering the behavior under test. Immutable descriptor prefixes may
be reused only while each original on-disk entry and resource state stays independent.

Count recorded events under their owner's lock when waiting for quiescence;
clone complete bodies only when an owned snapshot is needed. Never hold a
synchronous guard across an await. Consume owned parsed arrays rather than
cloning them, and reuse canonical fixture bytes for exact-original checks.
Textual JSON observations must include member names and preserve the caller's
search domain; they are not arbitrary serialized-JSON substring searches.

Keep one canonical serialized fixture for writing and exact-byte verification,
and consume already-owned observation snapshots instead of immediately cloning
another. Response gates may borrow raw JSON when extracting sequence metadata;
retain complete parsed-body assertions and reject missing or invalid sequences.
Reuse periodic synthetic pixel rows only when all original dimensions, pixel
values, compression settings and actual encoded/retained buffers remain intact.

Test-owned HTTP recorders should move complete requests into their owner when
only a path is needed afterward. Parse headers once, grow body buffers from
received bytes rather than untrusted declared lengths, and consume valid UTF-8
buffers without another full-body copy. Preserve fragmented headers, exact
Content-Length boundaries, empty bodies, existing lossy decoding, early-close
failures and response gates. Repeated JSONL budget fixtures may reuse one owned
entry while writing every canonical line; keep map ordering, full source files,
request counts and exact overflow diagnostics unchanged.

`json!` borrows and serializes expressions, including already-owned `Value`s.
Move large owned content into a `Map` envelope instead of rebuilding it through
the macro. Retain the original field insertion order for `preserve_order` builds
without unchecked indexing or new panic paths. Consume a parsed event when
normalizing it for an exact comparison; keep independent expected snapshots and complete canonical
byte oracles in both map-order configurations. When a fixture exists only to be
serialized, borrow its fields in a serializable descriptor rather than building
an intermediate owned `Value`. Share invariant compressed fixture bytes within
a test, while retaining every independent source file, lock and actual decode.
Serialize repeated JSONL records directly into their final canonical buffer;
retain every line, delimiter and independent original-file comparison. Compute
validation metadata before moving an owned payload into its fixture envelope,
rather than cloning that payload solely to keep reading its length or hash.
For length-only observations, count actual serialized bytes without retaining
throwaway JSON strings. Borrow body text for literal observations while preserving
the same decoding semantics and complete payload assertions. When omitting a
fixture field, preserve the map's removal order with key-only metadata and borrow
the unchanged values. Source-only repeated JSONL may serialize invariant fragments
once and encode every sequence between them; derive boundaries from map iteration,
not text matching, and verify complete bytes across ordering and digit boundaries.
Build expected reduced values directly rather than cloning large values to replace.

Keep real process/socket deadlines, full payload/file/pixel boundaries, key/KDF
strengths, every assertion and actual retained image buffers. Compare complete
unchanged target selections with matching profile/instrumentation/thread settings;
exclude compilation and warm-build differences from speed claims. Local samples
do not establish stable CI speedup or memory reduction.

### Shared firewall contract in CI

The Crates coverage job runs the `runner-types` integration tests
`firewall_base_url_validation_matches_shared_contract` and
`firewall_rule_validation_matches_shared_contract` as part of the full Rust
suite. When coverage is selected, the dedicated
`runner-firewall-contract-test` job is skipped to avoid compiling the same
integration tests twice.

A change only to either
`turbo/packages/connectors/src/__tests__/firewall-base-url-validation-contract.json`
or `turbo/packages/connectors/src/__tests__/firewall-semantics-contract.json`
still selects the dedicated Rust checks and existing Python contract validation,
without selecting full Rust coverage or runner images. The dedicated job keeps
its existing `runner-firewall-contract` rust-cache snapshot.

The Crates gate requires the selected owner to succeed. Failed, cancelled, or
unexpectedly skipped coverage cannot be replaced by a standalone result; a
fixture-only change likewise requires the dedicated check to succeed.

### Integration Tests (`tests/`)

Preferred for testing public APIs and cross-module behavior:

```
crates/guest-agent/
  src/
    http.rs
    masker.rs
  tests/
    integration.rs     # Integration tests
```

### Inline Tests (`#[cfg(test)]`)

For testing module-internal logic that isn't exposed publicly:

```rust
// src/config.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn load_full_config() {
        let dir = tempfile::tempdir().unwrap();
        // ... setup and assertions
    }
}
```

### Out-of-line unit modules (`tests/mod.rs`)

Use the native `tests/` directory layout for production-disabled unit modules:

```rust
// src/config.rs
#[cfg(test)]
mod tests;
// Unit tests live in src/config/tests/mod.rs.
```

Keep the guard on the production parent. The module namespace and child modules
are the same as for `tests.rs`; relative fixture includes must follow the new
source location. Cargo tests and coverage use the complete checkout and still
select these modules.

Runner binary hashing and compilation share a committed-source inventory that
excludes complete `tests/` directory segments. Organize a module there only after
confirming that production build/include readers do not consume its source.
Other test-named files remain conservatively included. Production sources and
embedded runtime/license inputs must stay outside excluded directories; adding
a production reader changes the key, but cannot make omitted source available
in the materialized build context.

## Patterns

### HTTP Mocking with httpmock

Use `httpmock` for mocking external HTTP services:

```rust
use httpmock::prelude::*;
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn post_json_success() {
    let server = MockServer::start();
    let http = guest_agent::http::HttpClient::with_api_config(
        server.base_url(),
        "test-token",
        "test-vercel-bypass",
        "test-client-session",
        Duration::ZERO,
    )
    .expect("build explicit API client");

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test");
        then.status(200).json_body(json!({"status": "ok"}));
    });

    let url = format!("{}/test", server.base_url());
    let result = http.post_json(&url, &json!({}), 1).await;

    mock.assert_calls_async(1).await;
    assert_eq!(result.unwrap().unwrap()["status"], "ok");
    mock.delete_async().await;
}
```

### Shared State and Process Environment

Use a mutex only for Rust-owned shared state when every access participates in the same lock. Prefer `std::sync::Mutex` when the guard does not cross an `.await`; use an async mutex when it must.

Neither kind of mutex makes `std::env::set_var` or `std::env::remove_var` safe in a multi-threaded test process. On non-Windows platforms, unrelated standard-library or dependency code may read the environment without taking the project lock, so the lock cannot satisfy those functions' safety contract.

Configure environment-dependent scenarios before spawning a child process instead:

```rust
use std::path::Path;
use std::process::Command;

fn command_with_test_env(binary: &Path) -> Command {
    let mut command = Command::new(binary);
    command
        .env("TZ", "UTC")
        .env_remove("R2_SECRET_ACCESS_KEY");
    command
}
```

For inline runner tests, reuse `run_ignored_child_test` from `crates/runner-host/src/test_fixtures/ignored_child.rs`. It invokes one exact ignored test in a bounded child process and accepts per-child environment settings and removals. The helper is available only through test-support paths, not the production API.

### Temp Directories

Use `tempfile` crate (auto-cleanup via `Drop`):

```rust
#[tokio::test]
async fn reads_written_fixture() {
    let dir = tempfile::tempdir().unwrap();
    let fixture_path = dir.path().join("fixture.txt");
    tokio::fs::write(&fixture_path, "fixture contents")
        .await
        .unwrap();

    let contents = tokio::fs::read_to_string(&fixture_path).await.unwrap();
    assert_eq!(contents, "fixture contents");
    // dir is cleaned up when dropped
}
```

### Test Harness for Complex Setup

When multiple tests need shared setup/teardown:

```rust
use tempfile::TempDir;

struct Harness {
    host: Option<GuestControlClient>,
    dir: TempDir,
}

impl Harness {
    async fn new() -> Self {
        let dir = tempfile::tempdir().expect("create unique temp dir");
        Self { host: None, dir }
    }
}
```

Each harness owns a unique directory. Use `harness.dir.path()` to access it;
`TempDir` removes it when the harness is dropped.

### Async Tests

Use `#[tokio::test]` for async code:

```rust
#[tokio::test]
async fn downloads_and_extracts() {
    let dir = tempfile::tempdir().unwrap();
    // ... async operations with .await
}
```

For in-process timer behavior, use Tokio's paused clock instead of waiting for
real time. `#[tokio::test(start_paused = true)]` and `tokio::time::advance(...)`
let the test exercise the production timer while keeping the test fast. See
`crates/runner-rpc-client/tests/helper.rs` and `tests/stream.rs` for examples.
Advance only after the timed task is armed, then assert its observable result.
When a timer case also uses real sockets, complete the peer's observable I/O on
running time before pausing just the timer phase. Keep a deliberately unpolled
future owned, advance to its unchanged deadline, and resume before polling it or
performing socket cleanup. Do not auto-advance through real I/O setup.
For external processes and kernel I/O, wait for the observable completion under
a bounded deadline; a paused Tokio clock does not control those systems. A
completed `dd` followed by `sync` already supplies that completion boundary in
`crates/nbd-cow/tests/integration.rs`, so an additional fixed sleep adds no
signal.

For sync-only logic, plain `#[test]` is fine:

```rust
#[test]
fn masks_nested_json() {
    let masker = SecretMasker { patterns: vec!["secret".into()] };
    let mut val = json!({"key": "has secret inside"});
    masker.mask_value(&mut val);
    assert_eq!(val["key"], "has *** inside");
}
```

## What to Test

### Runner session-history overlap

Exercise discovery and history planning through the full `run()` fixture in
`runner-supervisor/src/reactor/tests/idle_reuse`. Use the external sandbox mock's
`set_storage_manifest_lifecycle_gate` to hold storage apply and a controlled local
HTTP response to hold history materialization. A received history request while
storage is blocked proves automatic prestart; a manually constructed `Prestarted`
plan does not cover that dispatch decision. Verify restored bytes and unchanged
reuse attribution, and keep guest history writes and process start behind their
required preparation boundaries.

Use `RawHttpAction::WaitForDisconnect` when cancellation or an earlier preparation
failure must release a pending download. Its bounded completion observes the
client closing the request without making the response available. Synchronization
deadlines bound test liveness; do not use elapsed-time thresholds to claim a
performance improvement.

### General coverage

- **Config parsing**: round-trip (generate → load), validation of invalid inputs
- **HTTP clients**: success, retry, error responses (via httpmock)
- **Serialization**: serde round-trips for protocol types
- **Business logic**: masking, matching, path manipulation

## What NOT to Test

- Firecracker VM creation (requires root + KVM)
- Network namespace operations (requires root)
- Sandbox lifecycle (requires full runner environment)

These are covered by E2E tests in CI with real runner infrastructure.
