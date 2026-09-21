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

Use the `local` profile for routine local validation. It retains source locations in backtraces
while omitting full debug information and incremental artifacts to reduce resource and disk use.
Omit `--profile local` when full debug information or incremental compilation is more useful.

```bash
# All crates
cargo test --manifest-path crates/Cargo.toml --profile local

# Specific crate
cargo test --manifest-path crates/Cargo.toml --profile local -p guest-agent

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

Runner's inline tests are split into ten explicit Cargo test targets so a
serialized build fits constrained hosts. Prepare the locked Python integration
environment, then compile or run the complete partitioned suite with:

```bash
uv sync --locked --project crates/runner/mitm-addon
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -j 1 -p runner --tests --no-run
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -j 1 -p runner --tests -- --test-threads=1
```

Use `--test <target>` before a test-name filter when only one Runner domain is
needed. The targets are `runner-cmd-start`, `runner-cmd-service`,
`runner-cmd-gc-build`, `runner-cmd-other`, `runner-executor`, `runner-provider`,
`runner-storage`, `runner-network`, `runner-runtime-control`, and
`runner-platform-support`. For example, SSH tests belong to `runner-network`:

```bash
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -j 1 -p runner --test runner-network ssh::tests::pooling -- --test-threads=1
```

The production `runner` binary test harness is disabled for ordinary `cargo
test`; explicit `--bin runner` remains a compatibility fallback and rebuilds the
original monolithic harness, so it is unsuitable for a memory-constrained host.

Pre-commit hooks run `cargo fmt` and `cargo doc --profile local` on staged Rust
files. Clippy remains in the Crates CI workflow. To run it locally from `crates/`,
use `cargo clippy --profile local --all-targets --all-features`.

## Test Organization

### Shared firewall contract in CI

The Crates coverage job runs
`types::tests::firewall_base_url_validation_matches_shared_contract` as part of
the full Rust suite. When coverage is selected, the dedicated
`runner-firewall-contract-test` job is skipped to avoid compiling the runner test
executable twice.

A change only to
`turbo/packages/connectors/src/__tests__/firewall-base-url-validation-contract.json`
still selects the dedicated Rust check and existing Python contract validation,
without selecting full Rust coverage or runner images. The dedicated check keeps
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

Runner keeps its production module tree private and selects inline test items at
the source item boundary. New Runner test modules must be wrapped with
`runner_test_group!(group; ...)` and assigned to the narrowest domain above.
Test-only support items use `runner_test_support!(owner; ...)`; the deliberately
shared support modules are allowlisted by the partition check. Do not add a
crate-wide unused-code allowance or duplicate production source in a test root.

Run the static ownership/target-registry check after changing Runner test
organization. Add `--list` to compile the partitions and verify the exact-once
4,006-test inventory:

```bash
.github/scripts/check-runner-test-partitions.py
.github/scripts/check-runner-test-partitions.py --list
```

Crates CI runs the exact `--list` form in its own serialized
`runner-test-partitions` job whenever Runner or its CI configuration changes.

## Patterns

### HTTP Mocking with httpmock

Use `httpmock` for mocking external HTTP services:

```rust
use httpmock::prelude::*;

static MOCK_SERVER: LazyLock<MockServer> = LazyLock::new(|| {
    let server = MockServer::start();
    unsafe {
        std::env::set_var("OKOU_API_BACKEND_URL", server.base_url());
    }
    server
});

#[tokio::test]
async fn post_json_success() {
    let server = &*MOCK_SERVER;
    let mock = server.mock(|when, then| {
        when.method(POST).path("/test");
        then.status(200).json_body(json!({"status": "ok"}));
    });

    let result = http::post_json(&format!("{}/test", server.base_url()), &json!({}), 1).await;

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

For inline runner tests, reuse `run_ignored_child_test` from `crates/runner/src/test_fixtures.rs`. It invokes one exact ignored test in a bounded child process and accepts per-child environment settings and removals.

### Temp Directories

Use `tempfile` crate (auto-cleanup via `Drop`):

```rust
let dir = tempfile::tempdir().unwrap();
let config_path = dir.path().join("runner.yaml");
tokio::fs::write(&config_path, yaml).await.unwrap();

let config = load(&config_path).await.unwrap();
assert_eq!(config.name, "test-runner");
// dir is cleaned up when dropped
```

### Test Harness for Complex Setup

When multiple tests need shared setup/teardown:

```rust
struct Harness {
    dir: PathBuf,
    host: Option<GuestControlClient>,
}

impl Harness {
    async fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        Self { dir, host: None }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
```

### Async Tests

Use `#[tokio::test]` for async code:

```rust
#[tokio::test]
async fn downloads_and_extracts() {
    let dir = tempfile::tempdir().unwrap();
    // ... async operations with .await
}
```

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
`cmd/start/tests/idle_reuse`. Use the external sandbox mock's
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
