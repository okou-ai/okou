# Rust Testing Guide

## Overview

Rust crates live in `crates/` and use `cargo test` for testing. The same principles from [testing.md](../testing.md) apply: integration tests are primary, mock at the boundary, use real infrastructure.

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

Pre-commit hooks run `cargo fmt` and `cargo doc --profile local` on staged Rust
files. Clippy remains in the Crates CI workflow. To run it locally from `crates/`,
use `cargo clippy --profile local --all-targets --all-features`.

## Test Organization

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
