# Rust Testing Guide

## Overview

Rust crates live in `crates/` and use `cargo test` for testing. The same principles from [testing.md](../testing.md) apply: integration tests are primary, mock at the boundary, use real infrastructure.

Native command/fixture invocation belongs with its owning tests:
[Runner behavior](../../crates/runner/tests/behavior/),
[sandbox-firecracker native drivers](../../crates/sandbox-firecracker/tests/native/),
[nbd-cow native execution](../../crates/nbd-cow/tests/README.md),
[Kerberos worker](../../crates/kerberos-worker/README.md) and
[RFB/GSSAPI fixtures](../../crates/rfb-client/tests/QEMU_GSSAPI.md).
Their local infrastructure regressions remain registered in the existing CI
script shards; GitHub-specific artifact and workflow adapters stay in `.github`.

Runner's full suite includes real Rust/Python control round trips and process fixtures.
First run `uv sync --locked --project crates/runner/mitm-addon` from the repository
root, as described in the [addon guide](mitm-addon-testing.md). These tests use that
locked `.venv/bin/python` directly, including status/log-only control and fake
mitmdump processes. They fail if it is unavailable; they do not download
dependencies, contact APIs, or silently skip the integration. Crates coverage
prepares the same environment before running tests. All fixtures that import
addon source use its pinned Python 3.14.0 interpreter.

Ordinary Supervisor reactor fixtures retain a loopback startup API in the test's
Tokio runtime so paused time cannot outrun a separate server thread. The peer
acknowledges startup reports with HTTP 204. Keep the run environment alive through
Runner shutdown; the shared shutdown helper joins delivery before cancelling and
joining the peer. Tests that control response failure or timing use the
explicit-URL variants and keep their supplied server alive through shutdown.

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

# Complete guest-agent selection, including its separate integration-test owner
cargo test --manifest-path crates/Cargo.toml --profile local \
  -p guest-agent -p guest-agent-tests

# Shared raw HTTP transport fixtures and their single contract suite
# Consumers use dev-dependencies or opt-in test-support builds; default production
# builds do not include the fixture API or its Tokio dependency.
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -j 1 -p raw-http-test-support --all-features -- --test-threads=1

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

# Extracted Runner guest RPC, usage, SSH, and VNC owner tests.
# Includes native TLS/Noise/DERP/TCP and common SSH tests with synthetic external
# services, real encrypted traffic, binary transfers and physical IO retirement.
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

# Real constrained Guest-home preparation: private 128 MiB tmpfs, including
# complete byte/inode exhaustion. Requires Linux user/mount namespaces.
# Crates CI runs these in its selected guest-home-cleanup-test container;
# ordinary coverage keeps its existing permissions and compiles these fixtures.
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j1 \
  -p guest-agent --test bootstrap_contracts bootstrap_cases::home_reuse_cleanup \
  -- --ignored --test-threads=1

# With output (for debugging)
cargo test --manifest-path crates/Cargo.toml --profile local -- --nocapture
```

### Workspace dependency policy

Workspace crates must form an acyclic graph, including normal, development,
build, target-specific, and optional dependency declarations. The policy combines
all targets and features, even when a particular build would not activate both
edges. Cargo permits some development-dependency cycles, but release-please
requires an acyclic declared workspace graph.

Check the policy and release workspace coverage from the repository root:

```bash
.github/scripts/checks/check-release-please-workspace-coverage.sh
```

The check reuses `cargo metadata --locked --no-deps`, without compiling crates or
fetching dependencies. It follows inherited and renamed local workspace
dependencies, includes crates excluded from publication, and reports a complete
cycle with dependency kinds and source manifests. Ordinary and release PRs and
Merge Queue entries enforce it through the required `ci-gate-security` check.

Place cross-crate integration tests in the crate that already depends on the
tested contracts, or in a separate test crate above its participants. Adding a
reverse development dependency to a lower-level contract crate creates a cycle.

### Memory-constrained environments

Keep local validation scoped to the affected crate or test target. When the
machine is memory-constrained, serialize both compilation and test execution:

```bash
cargo test --manifest-path crates/Cargo.toml --profile local \
  -j 1 -p guest-agent -p guest-agent-tests -- --test-threads=1
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
  --lcov --output-path lcov.info --timings
```

Nextest schedules tests across executables and runs each case in a separate
process. Guest mock fixtures recognize the verified Cargo or nextest parent
session so the mock binaries are built once per invocation, not once per case.
The workspace config at `crates/.config/nextest.toml` reserves all configured
test slots for large-payload Guest Agent delivery scenarios. Their
multi-MiB JSON processing must fit the existing real delivery and termination
deadlines without competing with other tests. Each scenario retains its own
process and HTTP concurrency; other tests keep the configured parallelism.
On Linux CI, `LLVM_PROFILE_FILE_NAME=crates-%b-%8m.profraw` separates executable
build IDs and gives each profile signature up to eight raw files. LLVM manages
locking and merging across test processes and their children. Default fresh
coverage cleanup still removes profiles from earlier invocations.
The job requires a nonempty LCOV report with at least one source file, then
logs the unique normalized source-file count and source-set SHA-256 before
uploading to Codecov. It does not compare the digest against an expected value;
failed coverage still fails the Crates gate.

The coverage job retains its fresh Cargo build timing report for seven days in
the run's `rust-coverage-build-timings-<attempt>` artifact. Open `cargo-timing.html`
to inspect build-unit durations, dependencies and concurrent work. Each unit
includes its compilation and linking work; these timings do not isolate linker
CPU time, and overlapping unit durations do not add up to total build wall time.
Timing uploads are best-effort diagnostics and do not replace the coverage result.

The job also logs the count and summed file bytes of its fresh raw profiles.
The `rust-coverage-profile-evidence-<attempt>` artifact retains those statistics
and the fresh LCOV report for seven days. Match its attempt and source checkout
when comparing coverage or collection cost; asynchronous hit counts can vary.
Raw-profile file bytes measure retained data footprint, not physical writes,
process memory or runner cost. Evidence uploads are bounded diagnostics and
cannot replace a failed coverage run.

## Test Organization

Guest CLI integration executables share compiled neutral fixtures through
`cli-test-support` and its non-default `test-support` feature. Production crates keep
that edge in development dependencies. The private `guest-agent-tests` package owns integration
executables without original-package binary/version/source bindings. Its Cargo
library root explicitly binds the canonical `guest-agent/tests/common/mod.rs`,
compiling guest-specific adapters and process-global setup once for those targets.
Original-bound guest-agent targets retain that same source module. The test-owner
package depends on guest-agent; production guest-agent must not depend back on it.
Both packages are required for complete guest-agent testing and included in the
default workspace coverage selection. Reusing a library does not make process-global
tests safe to combine into one executable. Existing fixture contracts exercise the
real command, file, HTTP and verified Cargo/nextest mock-session boundaries.

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

Guest-agent's [integration layout](../../crates/guest-agent/tests/README.md)
groups cases with explicit configuration and independent resources into domain
targets. Retain separate executables for process environment/cwd, global
telemetry/log sinks, signals and resource-limit fixtures, including transitive
setup helpers.
Ordinary Cargo can execute cases concurrently in one binary; nextest's separate
case processes do not replace that isolation contract. Existing guarded-child
parents may share a target only when their child remains exact, ignored and
guarded. After moving a case, update its module-qualified self-spawn filter and
any source-relative fixture include, then compare case ownership and ignored
policy before and after the move.

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
performing socket cleanup. For an exact-deadline admission check, one explicit
manual poll may inspect synchronous rejection at the paused instant; resume
before awaiting a `Pending` future or performing socket cleanup. Do not
auto-advance through real I/O setup or waits.
For a spawned timer owner, the test-support
[`advance_timer_phase`](../../crates/raw-http-test-support/src/clock.rs) helper
resumes the clock before Tokio's advance yield can schedule awakened I/O. Observe
request or retry admission first; keep real transport and cleanup on running time.
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
