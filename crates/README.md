# Rust Crates

This workspace contains Rust crates for sandbox orchestration, guest execution,
control and RPC services, shared contracts, and developer/test support.

## Crates

| Crate                    | Responsibility                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| runner                   | Host-side run orchestration, sandbox lifecycle, proxy, images and operational CLI                     |
| sandbox                  | Provider-neutral sandbox interfaces and shared lifecycle/control types                                |
| sandbox-firecracker      | Firecracker provider: VM lifecycle, networking, NBD COW and snapshot restore                          |
| sandbox-mock             | Test implementation of the sandbox interfaces                                                         |
| nbd-cow                  | Userspace Linux NBD block devices with copy-on-write storage                                          |
| guest-control-proto      | Wire messages and codecs for controlling guest operations                                             |
| guest-control-client     | Runner-side guest-control caller, response dispatch and operation tracking                            |
| guest-control-server     | Guest control service embedded by guest-init in its child process                                     |
| guest-control-tests      | Real client/server integration tests over Unix sockets and executable fixtures                        |
| runner-rpc-proto         | Bounded framing and stream contracts for calls to Runner services                                     |
| runner-rpc-client        | Guest-side Runner RPC caller/helper, without business-method dispatch                                 |
| process-control-ipc      | Guest-local process control, Unix transport and descriptor handoff                                    |
| guest-init               | Guest PID 1 initialization, signal supervision and child reaping                                      |
| guest-agent              | Agent CLI lifecycle, heartbeat, events, checkpoints and session management                            |
| guest-tool-exec          | Tool hook adaptation and placement-before-exec launcher                                               |
| guest-storage-apply      | Storage/artifact manifest application: cleanup, preparation, extraction and instruction normalization |
| guest-state-restore      | Entropy/clock restoration and timezone configuration, including timezone-only mode                    |
| guest-write-file         | Direct stdin-to-file writes, including private and batch modes                                        |
| guest-workspace-mount    | Fixed workspace mount checks and ownership repair, with one ext4 mount child                          |
| session-history-selector | Selects retained native history candidates without rewriting live sessions                            |
| claude-mock              | Claude test double, currently emitting CLI JSONL and session artifacts                                |
| codex-mock               | Codex test double, currently implementing app-server JSON-RPC and session artifacts                   |
| guest-contracts          | Shared Runner/guest runtime agreements, paths and filesystem helpers                                  |
| api-contracts            | TypeScript-owned API bindings and shared decoding/route helpers                                       |
| guest-telemetry          | Structured guest logging and operation telemetry                                                      |
| ably-subscriber          | Subscribe-only Ably client with authentication and connection recovery                                |
| shell-quote              | POSIX shell argument quoting                                                                          |
| linux-mountinfo          | Byte-preserving Linux mountinfo parsing shared by host and guest consumers                            |
| tracing-test-support     | Structured tracing capture for tests                                                                  |
| xtask                    | Workspace developer checks, invoked through the cargo xtask alias                                     |

## Architecture and naming

`linux-mountinfo` parses mount identities, device numbers and decoded target
bytes without filesystem I/O. Consumers own path normalization, caching and
invalid-record policy: cleanup and snapshot lookup skip malformed records;
the privileged workspace helper rejects malformed records and empty tables.

```text
Runner -> guest-control-client -> guest-control-server (guest-init child)
Guest  -> runner-rpc-client    -> Runner service endpoint
Guest  -> process-control-ipc  -> guest-local process control / placement
```

Client/server names describe application calling roles, not socket initiation.
The guest opens the guest-control connection; Runner accepts it and calls guest
operations. The transport remains vsock forwarded through Firecracker Unix
sockets (or direct Unix sockets in integration tests). These services do not
implement a generic vsock protocol. Runner uses sandbox-firecracker through the
sandbox interfaces; guest-init remains PID 1 and embeds the control service in
its child. No new daemon or crate boundary is implied by these names.

A `guest-` package prefix is not an artifact inventory. The authoritative
[guest binary inventory](runner/guest-binaries.json) separately records each
package, binary, build environment key and installed path.

### Source, executable and release identities

Cargo package/directory/import names describe source responsibilities. Executable
packages use the same name for their binary and runner build flag; their build
environment variables use the uppercase underscore form. For example,
`cargo build -p runner-rpc-client` produces `runner-rpc-client`, installed at
`/usr/local/bin/runner-rpc-client`, with build flag `--runner-rpc-client` and
build environment key `RUNNER_RPC_CLIENT_PATH`.

The inventory records all installation directories and build environment keys.
Privileged helpers keep their `/sbin` placement; other helpers stay under
`/usr/local/bin`. API-owned mock selection settings such as
`OKOU_MOCK_CLAUDE_PATH` remain separate from these build-time identities.

Release configuration and workflow output keys use the new directory paths.
Renamed crates use their new
Cargo names as default release components and future tag prefixes, without
old-name component overrides. Manifest path keys move with unchanged numeric
versions; Release Please continues from those versions when new-name tags do not
yet exist. Historical tags and changelog entries are unchanged. The first release
under a new name may have a comparison link to a nonexistent new-name prior tag.
Existing unrelated component overrides (such as runner-rs and api-contracts-rs)
remain unchanged.

Component-specific log tags, operation labels and test fixtures use the current
component names. Guest-control worker threads use `gctl-` plus their task, with
names limited to 15 bytes for Linux thread-name visibility. Rust tracing targets
use their underscore form.
External log/metric queries and local tracing filters must use the new identifiers.
No old-name aliases or duplicate telemetry are emitted.

Runner and its bundled guest helpers are built together. Local rootfs hashes
include binary installation destinations and contents, and snapshot hashes include
the rootfs hash. Binary cache digests include the source tree and guest inventory.
Changing executable identities therefore creates distinct artifacts; existing
instances drain on their existing artifacts while new builds use the new paths.
Shared templates do not contain the injected helpers. Build scripts and explicit
binary overrides must use flags and environment keys matching the runner revision.

## Runner Operations

- [Host configuration and I/O capacity](../docs/runner-host-configuration.md):
  configure host-local concurrency and aggregate I/O capacity overrides.
- [Multi-architecture rollout](../docs/runner-multi-architecture.md): select,
  build, deploy, and validate architecture-specific runner artifacts.

### Local control socket limits

Each sandbox's owner-only control socket admits at most 32 concurrent request
handlers and 64 MiB of raw request payloads in aggregate. Declared lengths reserve
that byte budget before payload allocation. Excess connections or requests that
cannot reserve their full declared size are closed without a response.

A request must deliver its entire length prefix and body within 5 seconds of
acceptance. Timeout, EOF, and server shutdown release the pending receive resources.
After parsing, the raw buffer and byte budget are released before executing the
command or waiting for termination acknowledgment. Execution retains its own
timeout; the existing 64 MiB per-frame ceiling and exec response limits still apply.

Saturated or unusually slow local clients can therefore receive connection errors.
These limits apply per socket. The payload budget does not include parsed commands,
responses, allocator overhead, or kernel socket buffers, and does not bound host-wide RSS.

### Local active input

`runner local input` requires a claimed local job with active-input forwarding
enabled. Ordinary submissions leave forwarding disabled. Enable it when submitting
the job with `runner local submit --active-input after=1s,text=hello` and the other
required submission arguments. An already-running job cannot enable forwarding
retroactively; resubmit it with the option when input is needed.

The input command rejects disabled forwarding or unavailable job metadata without
creating an input entry. A successful command reports file publication, not an
acknowledgement that the running agent consumed the input.

Input publication and terminal input cleanup take the same cross-process lock on
the existing group directory. Publication rechecks the terminal result and
retained job under that lock, so a late input command cannot recreate a completed
run's input directory after cleanup. Delayed inputs can still be published before
the runner claims the job. The lock serializes these short filesystem operations
within one group and creates no per-run lock files.

Queue paths and JSON payloads are unchanged. Older local submit, input, or runner
processes can still read the queue, but do not participate in this synchronization;
the race is closed once the publishers and cleanup owners use the updated binary.

### API active-input read recovery

The Runner retries failed active-input reserve reads with the existing jittered
backoff (200–250ms initially, capped at 3.2–4s). The HTTP request deadline remains
10s. Notifications cannot bypass a pending failure delay; cancellation and run
completion still interrupt reads and retry waits.

For a send-stage timeout or TCP connection reset, the first failure is INFO.
If reads continue failing for at least 30s after that first observed failure,
the next failed response emits one `active-input source reads degraded; retrying`
WARN. This is an operational threshold, not an input-delivery deadline: the
initial failed request and subsequent request/backoff durations are separate.
The threshold does not add a timer, change retries, or stop the run. Other read
errors retain an immediate WARN, including when they follow an INFO-only
transient failure. Further consecutive failures retain local retry scheduling
records without repeating the episode warning.

A successful reserve response resets the episode and emits
`active-input source read recovered` at INFO, including `reserve_outcome`,
`recovered_after_failures`, `failure_elapsed_ms` and `was_degraded`. An `empty`,
`held`, `terminal` or `rejected_*` response is explicitly not delivery. Even
`reserved` proves only readable reservation state, not Guest acceptance or an
API delivery receipt. Guest-control uncertainty and receipt-recovery warnings
are unchanged. Cancellation never fabricates read recovery.

Runner INFO records remain local; Axiom continues ingesting WARN+ only. Before
closing [#33079](https://github.com/vm0-ai/vm0/issues/33079), record the deployed
Runner release/commit and a bounded real-traffic window (for example, the first
24 hours after rollout). Correlate local retry/recovery records by run ID and
time, separate empty/readable-terminal outcomes from actual pending input, and
verify durable delivery receipts for sampled inputs that were reserved. Inspect
degraded and unclassified warning episodes separately, including episodes that
ended with cancellation or run completion. Report unavailable evidence rather
than inferring recovery from missing warnings. Old draining Runners can still
emit the previous immediate warnings, so group evidence by deployed identity.
This observation does not require or authorize production fault injection.

### Builtin firewall catalog refresh recovery

Startup still requires a successful catalog fetch, validation and private cache
publication. Periodic refresh keeps its five-minute interval and ten-second
request budget. A failed refresh never replaces the last published catalog.

A typed send-stage timeout, or an already classified transient JSON body-read
failure, is INFO only while the existing cache passes the trusted, size-bounded
reader and schema/firewall validation. Missing, corrupt or untrusted cache,
non-timeout send failures, HTTP status, JSON/schema/size and local publication
failures remain immediately actionable. No cache expiry or freshness guarantee
is introduced, and firewall enforcement is unchanged.

Eligible send and body failures share one catalog-owned episode. The first
failure is INFO; a later failed observation spanning at least five minutes emits
one `builtin firewall catalog refresh degraded` WARN. Further eligible failures
are INFO with `degraded=true`. This threshold is checked after a failed attempt,
not by an exact timer. A complete successful refresh emits
`builtin firewall catalog refresh recovered`, even if identical trusted cache
bytes need no rewrite. Cancellation does not report recovery.

Send-timeout diagnostics include the existing request/session identity for API
correlation and `failure_stage=send`, without inventing a response status or
logging credentials or response content. INFO remains local; Axiom still ingests
WARN+ only. Before closing [#33373](https://github.com/vm0-ai/vm0/issues/33373),
record the deployed Runner artifact and a bounded real-traffic window (for
example, 24 hours), and inspect Runner-local failure/recovery and cache-usability
evidence. Group old draining releases separately. API-wide HTTP 200 counts,
cache publication timestamps or no repeated warning do not prove that a
particular Runner completed a refresh. Report missing evidence explicitly;
this verification does not authorize production fault injection.

### Orphan sandbox termination

`runner kill --sandbox <ID>` first asks the owning runner to terminate the
sandbox. If that owner is gone, orphan termination validates the Firecracker
process and workspace through a retained `/proc/<pid>` directory handle and
signals the entire process group through that same kernel identity. A reused
numeric PID or PGID cannot redirect the signal to a different process group.

This orphan path requires Linux 6.9+ support for `pidfd_send_signal` with
`PIDFD_SIGNAL_PROCESS_GROUP`, and the verified target must be the group leader.
If the kernel or security policy rejects that operation, termination fails
without falling back to numeric signaling or deleting the sandbox's resources.
Inspect the reported error and host support before retrying. Normal termination
through an owning runner still uses its owned child lifecycle and does not gain
this new kernel requirement. `--run` targets do not fall back to orphan killing.

## nbd-cow Benchmark

The `nbd-cow` benchmark compares NBD COW with dm-snapshot using fio workloads. It is an opt-in,
feature-gated benchmark that must run as root on a host with the required device tooling.

Run it from the repository root:

```bash
cargo run --manifest-path crates/Cargo.toml -p nbd-cow --features bench --bin bench -- [base-size-mb]
```

`base-size-mb` is optional. It specifies the base image size in MB, defaults to 1024 MB, and must
be at least 1024 MB (inclusive).

Before running the benchmark, ensure that:

- the process runs as root;
- `fio`, `losetup`, and `dmsetup` are available on `PATH`; and
- the NBD kernel module is loaded:

  ```bash
  modprobe nbd nbds_max=4096
  ```

## Logging

Runner Rust logs are recorded to local files, stderr, and CI at `info` and
above by default. Axiom ingests `warn` and above. Use `debug` or `trace` only
for local diagnostics that are acceptable to miss in production logs.

Per-run network-log uploads have a 30-second total budget, with a separate
10-second timeout for each sequential HTTP request. Uploads remain best-effort,
limited to 64 MiB of source data and 64 batches, with no automatic retries.
They run after completion reporting and sandbox ownership settlement, but
graceful Runner shutdown waits for outstanding uploads. Deadline cancellation
can leave a request's result unknown; it does not prove that ingestion failed.

### Guest root filesystem usage after abnormal exits

The existing abnormal-exit probe records `guest_root_fs_usage` separately from
`diagnostic_stdout`, so Axiom's 4 KiB text-field limit cannot let preceding
binary or kernel output crowd out directory evidence. The usage section is
limited to 3600 bytes plus an explicit output-limit marker.

The embedded Python 3 sampler prioritizes `/tmp` and `/home/user/.pi`, then
known CLI state/cache directories, home and system locations. It reads only
metadata through no-follow directory descriptors, skips other devices and the
canonical workspace, `/proc`, `/sys`, `/dev` and `/run`, and prints fixed labels
without discovered names or contents. `bytes` uses allocated blocks, including
directory metadata, with hard links deduplicated within each observation.

Each target has a 4096-entry, 120 ms and 32-level traversal budget; the whole
sample has 32768 entries and 2.2 seconds. The shell imposes a 3-second timeout
with a 200 ms kill grace inside the existing 5-second/64 KiB guest probe. These
time budgets do not make a blocking filesystem syscall interruptible; the
outer process deadline still owns termination. Python runs isolated and
without bytecode writes, using Python/coreutils already in supported templates.

`complete` means the eligible traversal finished; it is not an atomic snapshot.
`partial` retains observed bytes with `entries`, `time`, `depth`, `io` or
`changed` reasons. Missing, unavailable and other-filesystem targets have no
fabricated byte total. A `started` row without its result, no final `done`, or
`sampler_failed_or_timed_out` indicates interrupted evidence. Overlapping
targets and cross-target hard links make observations non-additive. Incomplete
small observations cannot rule out a large directory; named entries that have
been unlinked but are still open are outside this scan.

This diagnostic does not alter capacity, data, mounts, resource classification
or recovery. Before closing [#34463](https://github.com/vm0-ai/okou/issues/34463),
record the deployed Runner/Guest artifact and a bounded production window,
evaluate observation completeness and correlate the actual root-writing
workload. Historical writer attribution and the first ENOSPC operation remain
unconfirmed. A diagnostics deployment or a window without failures alone does
not establish remediation.

## TLS in Guest Binaries

Guest crates (`guest-agent`, `guest-storage-apply`) **must** use system certificate roots, not bundled webpki roots. The host runs a mitmproxy transparent proxy that intercepts HTTPS traffic with its own CA certificate, which is installed into the guest's system certificate store at boot. Using bundled roots would bypass the proxy CA and cause TLS verification failures.

Both HTTP clients in the workspace use `rustls-platform-verifier` to read from the system certificate store:

- **`reqwest`** (async) — used by `guest-agent`, `runner`, `ably-subscriber` with the `rustls` feature (aws-lc-rs crypto provider auto-installed).
- **`ureq`** (sync, no tokio) — used by `guest-storage-apply` with the `platform-verifier` feature. Uses `ring` by default.

## Building

```bash
# Native build
cargo build
cargo build --release

# Cross-compile with the faster CI/dev profile.
# Supported targets:
#   aarch64-unknown-linux-musl
#   x86_64-unknown-linux-musl
TARGET_TRIPLE=aarch64-unknown-linux-musl

# Step 1: build guest binaries
cargo build --target "$TARGET_TRIPLE" \
  -p guest-agent -p guest-storage-apply -p guest-init -p claude-mock -p codex-mock -p guest-state-restore -p guest-tool-exec -p guest-write-file -p guest-workspace-mount -p runner-rpc-client \
  --profile ci

# Step 2: build runner with embedded guests
GUEST_AGENT_PATH="target/$TARGET_TRIPLE/ci/guest-agent" \
GUEST_STORAGE_APPLY_PATH="target/$TARGET_TRIPLE/ci/guest-storage-apply" \
GUEST_INIT_PATH="target/$TARGET_TRIPLE/ci/guest-init" \
CLAUDE_MOCK_PATH="target/$TARGET_TRIPLE/ci/claude-mock" \
CODEX_MOCK_PATH="target/$TARGET_TRIPLE/ci/codex-mock" \
GUEST_STATE_RESTORE_PATH="target/$TARGET_TRIPLE/ci/guest-state-restore" \
GUEST_TOOL_EXEC_PATH="target/$TARGET_TRIPLE/ci/guest-tool-exec" \
GUEST_WRITE_FILE_PATH="target/$TARGET_TRIPLE/ci/guest-write-file" \
GUEST_WORKSPACE_MOUNT_PATH="target/$TARGET_TRIPLE/ci/guest-workspace-mount" \
RUNNER_RPC_CLIENT_PATH="target/$TARGET_TRIPLE/ci/runner-rpc-client" \
cargo build --target "$TARGET_TRIPLE" -p runner --profile ci
```

## Testing

Use the `local` profile for routine local validation. Omit it when full debug information or
incremental compilation is more useful.

```bash
cargo test --profile local
cargo clippy --profile local --all-targets
```
