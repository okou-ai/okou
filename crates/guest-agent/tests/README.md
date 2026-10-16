# Guest-agent integration tests

Use native module directories to share compilation within a domain. Each domain
target imports `common` once; its case modules import `crate::common`.

Neutral command/session cleanup, file readiness, HTTP recording, mock builds and
JSON/image fixtures compile in `cli-test-support`, enabled only as a development
dependency through its `test-support` feature. `common` re-exports those helpers
and retains guest runtime adapters, manifest-derived workspace lookup and
process-global environment/cwd, log and resource-limit setup. Sharing compiled
helpers does not combine the executables or relax their isolation requirements.

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
cargo test --manifest-path crates/Cargo.toml --profile local --locked -p guest-agent

# One shared domain, with ordinary Cargo case concurrency
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -p guest-agent --test fixture_contracts

# One exact ordinary parent, which invokes its own guarded child
cargo test --manifest-path crates/Cargo.toml --profile local --locked \
  -p guest-agent --test fixture_contracts \
  fixture_cases::mock_build_lock::mock_build_lock_recovers_after_holder_exit -- --exact
```

Use one compilation job on a constrained host, as described in the
[Rust testing guide](../../../docs/runner/rust-testing.md). Do not use
`--test-threads=1` to justify grouping process-global fixtures. Target count alone
does not prove a speedup: compare equivalent instrumented builds, complete
coverage jobs, peak memory and disk under matching runner/cache conditions.
