# Guest-agent integration tests

Integration executables live in `guest-agent` and the private
[`guest-agent-tests`](../../guest-agent-tests/README.md) workspace package.
The latter owns targets without original-package binary, version or source-path
bindings. Each remains a separate executable, including process-global fixtures.
Native case modules retain their existing `crate::common` imports and identities.

Neutral command/session cleanup, file readiness, HTTP recording, mock builds and
JSON/image fixtures compile in `cli-test-support` through its opt-in `test-support`
feature. Production crates keep that edge in development dependencies; the private
test-owner library enables it for its own build. The canonical `common/mod.rs`
re-exports those helpers and owns guest runtime adapters, manifest-derived workspace
lookup and process-global environment/cwd, log and resource-limit setup.
`guest-agent-tests` explicitly declares that source as its Cargo library root;
its executables use the compiled library as `common`. Original-package-bound
targets retain `mod common` against the same source, avoiding a reverse dependency
or a second implementation. Both manifests live directly under `crates/`, so
their workspace-parent lookup is identical. Sharing compiled helpers does not
combine executables or relax isolation requirements.

| Target                   | Ownership                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `api_contracts`          | API configuration, active input, search policy and public surface                  |
| `bootstrap_contracts`    | Runtime/control endpoint capture, startup helpers and session-history identity     |
| `codex_client_contracts` | App-server client transport, initialization, input bounds and session resume       |
| `codex_setup_contracts`  | Codex auth, model catalog, fail-closed setup and startup telemetry                 |
| `codex_input_contracts`  | Active-input parents with isolated stale/queued-terminal children                  |
| `delivery_contracts`     | API-mode and event-delivery recovery/overload boundaries                           |
| `fixture_contracts`      | Native command cleanup, readiness, JSON/image observation, masking and mock builds |
| `pi_delivery_contracts`  | Pi startup, oversized drain controls and isolated RPC overload                     |
| `runtime_contracts`      | Native continuation, reasoning, cancellation, deadlines and process control        |

`codex_input_contracts` and `fixture_contracts` belong to `guest-agent-tests`;
the other listed domains and `integration` retain their original package bindings.
Package moves retain target/case names and child `--exact` filters;
package-qualified nextest identities use the owning package above.

The existing `integration` target owns `integration_cases/`. Other top-level
roots remain separate when they change process environment, cwd, the shared
system-log or sandbox-ops telemetry sink, signal disposition or resource limits.
For example, `artifact_finalization_content_hash` owns a global telemetry sink.
Follow transitive setup calls: the fast/standard Codex startup roots delegate environment mutation to
`codex_app_server_startup`. A mutex cannot make environment mutation safe against
unrelated readers. Retain these executable boundaries for ordinary Cargo even
though nextest runs each case in a separate process.

Cases that use explicit configuration and own independent files, sockets and
child environments can share a domain target. An existing guarded-child parent
may also share it if only that exact child changes process-global state. Keep
the child ignored and preserve its guard, deadline, payload and cleanup checks.
Do not add child wrappers around otherwise isolated cases just to group targets:
the shared mock builder verifies its direct Cargo/nextest parent for reuse.

Moving a root `old_target.rs` under `domain/old_target.rs` changes its case
identity from `case` to `domain::old_target::case`, including any pre-existing
nested case namespace. Update every self-spawn `--exact` argument to that full
identity; a successful process running zero tests does not validate a child.
Keep manual ignored benchmarks opt-in.

From the repository root:

```bash
# Complete package selection, including retained isolated targets
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -p guest-agent -p guest-agent-tests

# One shared domain, with ordinary Cargo case concurrency
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -p guest-agent-tests --test fixture_contracts

# One exact ordinary parent, which invokes its own guarded child
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -p guest-agent-tests --test fixture_contracts \
  fixture_cases::mock_build_lock::mock_build_lock_recovers_after_holder_exit -- --exact
```

Use one compilation job on a constrained host, as described in the
[Rust testing guide](../../../docs/runner/rust-testing.md). Do not use
`--test-threads=1` to justify grouping process-global fixtures. Target count alone
does not prove a speedup: compare equivalent instrumented builds, complete
coverage jobs, peak memory and disk under matching runner/cache conditions.

Linux session-history fixtures require temporary files on the `/home/user` mount.
When `/tmp` is on another mount, supply a short, test-owned `TMPDIR` on the home
mount and remove it after execution. Keep paths short enough for the native Unix
socket path limit; deeply nested temporary roots can exceed that limit.
