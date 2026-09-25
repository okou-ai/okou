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

# Extracted Runner host primitives and their owner tests
cargo test --manifest-path crates/Cargo.toml --profile local \
  -j 1 -p runner-host -- --test-threads=1

# Extracted Runner provider coordination and its owner tests
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -j 1 -p runner-provider -- --test-threads=1

# Extracted Runner network behavior, mitmdump recovery, and owner tests
# Seven focused mitmdump restart tests moved from runner/src/cmd/start/mitm_restart.rs
# into runner-network/src/proxy/recovery.rs, plus fatal cleanup and cancelled
# wait coverage (9 recovery tests total); none intentionally removed.
# Runner's main-loop crash, panic, and shutdown tests remain in runner.
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -j 1 -p runner-network -- --test-threads=1

# Extracted Runner guest RPC, usage, SSH, and VNC owner tests
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -j 1 -p runner-remote -- --test-threads=1

# Extracted Runner storage planning and cache owner tests
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -j 1 -p runner-storage -- --test-threads=1

# Extracted Runner active-run, idle sandbox, workspace and cache snapshot owner tests
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -j 1 -p runner-lifecycle -- --test-threads=1

# Extracted Runner claimed-run execution and session-history owner tests
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -j 1 -p runner-executor -- --test-threads=1

# Extracted Runner idle, pre-claim admission/rollback and pending-candidate state, finalizing-successor arbitration, claimed activation, post-executor finalizing/report ordering/sandbox finalization/settlement, heartbeat, and orphan-recovery owner tests
# The pending-candidate policy has three supervisor unit tests; existing Runner
# main-loop admission/expiry/duplicate tests remain as cross-domain coverage.
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -j 1 -p runner-supervisor -- --test-threads=1

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

## Test Organization

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

For in-process timer behavior, use Tokio's paused clock instead of waiting for
real time. `#[tokio::test(start_paused = true)]` and `tokio::time::advance(...)`
let the test exercise the production timer while keeping the test fast. See
`crates/runner-rpc-client/tests/helper.rs` and `tests/stream.rs` for examples.
Advance only after the timed task is armed, then assert its observable result.
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
