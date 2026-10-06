# Rust Crates

This workspace contains Rust crates for sandbox orchestration, guest execution,
control and RPC services, shared contracts, and developer/test support.

## Crates

| Crate                    | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| runner                   | Process-wide composition, `start` boot/configuration/lock policy, operational CLI and build packaging                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| runner-executor          | Claimed-run sandbox execution, session history, results, diagnostics and per-run telemetry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| runner-host              | Runner host filesystem and persisted process identity, live process registry, local control IPC, systemd identity/query/selected-config primitives, orphan-workspace GC, filesystem accounting and identity-aware lock cleanup, shared byte formatting, locks, paths and logging                                                                                                                                                                                                                                                                                                                         |
| runner-lifecycle         | Active-run handoff, idle sandbox, memory prefetch, status, home image and cache snapshot lifecycle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| runner-network           | Runner proxy process/recovery, DNS, CA, network log capture and bounded upload                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| runner-provider          | API/local job discovery, claiming, completion, active input, cancellation and queue coordination                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| runner-remote            | Guest RPC, remote usage, SSH authority/sessions/files, and VNC sessions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| runner-storage           | Storage planning, archive delivery, host archive/decoded-cache GC and R2 template cache                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| runner-supervisor        | Concrete retained reactor, ordered factory startup/teardown, dispatch and independent maintenance; idle replenishment and exact operator reclamation, pre-claim preference/admission/claim rollback and pending finalizing-candidate state, claimed-idle reservation/rollback, finalizing-successor arbitration, claimed resource selection/activation and status/failure recovery, post-executor finalizing and sandbox finalization, provider report ordering, active-run completion settlement, panic disposition recovery, heartbeat, ownership transitions, and orphan recovery above domain owners |
| runner-types             | Shared Runner identifiers, API payloads, storage manifest types and validation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| sandbox                  | Provider-neutral sandbox interfaces and shared lifecycle/control types                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| sandbox-firecracker      | Firecracker provider: VM lifecycle, networking, NBD COW and snapshot restore                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| sandbox-mock             | Test implementation of the sandbox interfaces                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| nbd-cow                  | Userspace Linux NBD block devices with copy-on-write storage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| guest-control-proto      | Wire messages and codecs for controlling guest operations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| guest-control-client     | Runner-side guest-control caller, response dispatch and operation tracking                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| guest-control-server     | Guest control service embedded by guest-init in its child process                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| guest-control-tests      | Real client/server integration tests over Unix sockets and executable fixtures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| runner-rpc-proto         | Bounded framing and stream contracts for calls to Runner services                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| runner-rpc-client        | Guest-side Runner RPC caller/helper, without business-method dispatch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| process-control-ipc      | Guest-local process control, Unix transport and descriptor handoff                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| guest-init               | Guest PID 1 initialization, signal supervision, child reaping and private duplex worker composition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| guest-agent              | Agent CLI lifecycle, heartbeat, events, checkpoints and session management                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| guest-tool-exec          | Tool hook adaptation and placement-before-exec launcher                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| guest-storage-apply      | Storage/artifact manifest application: cleanup, preparation, extraction and instruction normalization                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| guest-state-restore      | Entropy/clock restoration and timezone configuration, including timezone-only mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| guest-write-file         | Direct stdin-to-file writes, including private and batch modes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| guest-home-mount         | Fixed home mount identity checks and bounded pristine initialization, with one ext4 mount child                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| session-history-selector | Selects retained native history candidates without rewriting live sessions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| claude-mock              | Claude test double, currently emitting CLI JSONL and session artifacts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| codex-mock               | Codex test double, currently implementing app-server JSON-RPC and session artifacts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| guest-contracts          | Shared Runner/guest runtime agreements, paths and filesystem helpers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| api-contracts            | TypeScript-owned API bindings and shared decoding/route helpers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| guest-telemetry          | Structured guest logging and operation telemetry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ably-subscriber          | Subscribe-only Ably client with authentication and connection recovery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| shell-quote              | POSIX shell argument quoting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| linux-mountinfo          | Byte-preserving Linux mountinfo parsing shared by host and guest consumers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| tracing-test-support     | Structured tracing capture for tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| xtask                    | Workspace developer checks, invoked through the cargo xtask alias                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Architecture and naming

`linux-mountinfo` parses mount identities, device numbers and decoded root/target
bytes without filesystem I/O. Consumers own path normalization, caching and
invalid-record policy: cleanup and snapshot lookup skip malformed records;
the privileged home helper rejects malformed records and empty tables.

```text
Runner -> runner-provider -> runner-host -> runner-types
Runner -> runner-network  -> runner-host -> runner-types
Runner -> runner-remote   -> runner-network, runner-provider, runner-host, runner-types
Runner -> runner-storage  -> runner-host -> runner-types
Runner -> runner-lifecycle -> runner-storage, runner-host, runner-types, sandbox
Runner -> runner-executor -> runner-provider, runner-storage, runner-network, runner-remote, runner-lifecycle, runner-host, runner-types
Runner -> runner-supervisor -> runner-executor, runner-lifecycle, runner-network, runner-storage, runner-provider, runner-host, runner-types, sandbox
Runner -> guest-control-client -> guest-control-server (guest-init child)
Guest  -> guest-init::private_duplex -> private 52002 host listener (same child)
Guest  -> runner-rpc-client   -> Runner service endpoint
Guest  -> process-control-ipc  -> guest-local process control / placement
```

Client/server names describe application calling roles, not socket initiation.
The guest opens the guest-control connection; Runner accepts it and calls guest
operations. The transport remains vsock forwarded through Firecracker Unix
sockets (or direct Unix sockets in integration tests). These services do not
implement a generic vsock protocol. Runner uses sandbox-firecracker through the
sandbox interfaces; guest-init remains PID 1 and composes the control
service and its own private duplex worker module in the existing child.
Separating the 52002 protocol does not create a new daemon, binary or crate.

A `guest-` package prefix is not an artifact inventory. The authoritative
[guest binary inventory](runner/guest-binaries.json) separately records each
package, binary, build environment key and installed path.

### Systemd service ownership

`runner-host::service` owns validated runner service identities, bounded
systemctl/journalctl primitives, selected unit configuration parsing, and their
private tests. Runner retains service command policy, active-job decisions,
reload coordination, drain/signal/stop behavior, and unit generation/private
atomic publication. Existing service names, lock/unit paths, selected-config
semantics, error categories and machine-readable state fields are unchanged.

The three cross-owner state fixtures are available only through host's
non-default `test-support` feature, which Runner requests as a dev-dependency;
production state fields and normalization remain private. Moved tracing targets
use `runner_host::service` rather than `runner::cmd::service`; no old-target
aliases or duplicate logs are emitted.

### Storage-cache GC ownership

`runner-storage::cache_gc` owns archive/decoded-cache collection, staging cleanup,
and their filesystem/flock tests. Its concrete limits carry caller-supplied byte,
entry and minimum-age policy; its result carries only cleanup activity and freed
bytes. Runner retains the 1 GiB / 5,000-entry / 600-second defaults, CLI policy,
GC lock and phase ordering, error presentation, and phase/total report composition.

`runner-host::gc` owns the single shared filesystem-accounting and identity-aware
lock-cleanup implementations and their private tests. Completeness-aware scans,
symlink handling, scan/drop/reacquire, directory identity/mtime revalidation,
staging final-version locks, and decoded-cache reader pinning remain unchanged.
Shared byte formatting lives in `runner-host::byte_size` for both cache diagnostics
and command consumers. Directory-iteration faults and GC fixtures are available
only through the non-default Host `test-support` feature; fault state stays private.
Moved tracing targets follow their Host/Storage owners without old-target aliases
or duplicate records. This boundary alone does not establish whole-workload
memory improvement or complete the parent cold-build acceptance gate.

### Orphan-workspace GC ownership

`runner-host::gc::workspaces` owns initial free-lock discovery, process and live
registry snapshots, later held-lease acquisition, orphan deletion and retry-lock
cleanup, together with all 34 original private scenarios. Its concrete policy
accepts a caller-supplied minimum age; immutable report accessors keep workspace,
allocated-byte and base-dir-lock counts independent. Runner retains the
600-second default, CLI/dry-run and global GC policy, workspace-before-general-lock
ordering, typed error presentation and phase/total report composition.

The fixed pass reference, initially held-lock exclusion, complete ownership
snapshots, later held lease, raw-byte lock identity, fail-closed discovery,
symlink checks and retry metadata remain one Host-owned invariant. Root's general
lock pass uses the same canonical base-dir-lock classifier. Shared GC fixtures
and immutable report fixtures use Host's existing non-default `test-support`
feature; production report fields and candidate/lease/removal-hook state stay
private. Tracing targets follow `runner_host::gc::workspaces` without old-target
aliases or duplicate records; messages, severity and fields are unchanged.
This ownership boundary alone does not establish a whole-workload memory benefit.

### Runtime reactor ownership

`runner-supervisor::reactor` owns the concrete retained loop, ordered sandbox
factory startup/rollback, lifecycle signal consumption, job dispatch, maintenance
and teardown, together with their runtime tests. Runner retains validated
configuration translation, eager signal subscription, base-dir/image locks,
provider/runtime/network/executor boot, live-registry publication and removal,
and its executable release and logging field budget. Factory plans contain only
sandbox path/data inputs; cloning them does not clone a runtime or factory.

Initial status, prune binding, provider readiness and factory creation remain
inside the runtime entry in the same order. Discovery/watcher futures stay
retained, heartbeat/status/cache maintenance stays independently scheduled, and
normal teardown still joins required work and stops DNS before the runtime.
Typed runtime outcomes map back to the existing command categories and sources.
Host owns the single bounded UTF-8 suffix primitive; the sole Provider→Network
upload adapter follows Supervisor dispatch without reversing domain dependencies.

The provider fixture and observation hooks have one private unit-test owner.
Cross-owner early-signal and shutdown-recording controls are explicitly gated by
Supervisor's non-default `test-support` feature. Production features do not
include it. Source tracing targets follow `runner_supervisor::reactor` rather
than `runner::cmd::start` without old-target aliases or duplicate events; field,
message, severity, protocol, status and executable release semantics are unchanged.
This ownership boundary alone does not prove the parent cold-memory gate.

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

- [Host configuration and I/O capacity](../docs/runner/runner-host-configuration.md):
  configure host-local concurrency and aggregate I/O capacity overrides.
- [Multi-architecture rollout](../docs/runner/runner-multi-architecture.md): select,
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

The Runner reads the run's next steerable input prompt from
`GET /api/runners/runs/:runId/steerable-inputs/next` after a `runner-group`
notification or the 30s recheck, and forwards at most one input at a time to the
Guest. The Guest declares an accepted input steered through
`POST /api/runners/runs/:runId/steerable-inputs/:eventId/steered`; a `409`
(`INPUT_ALREADY_CONSUMED` or `RUN_NOT_RUNNING`) is final and ignored. The Runner
never forwards the same event twice, including after an uncertain Guest control
outcome, and neither side retries a declaration.

The Runner retries failed next-input reads with the existing jittered backoff
(200–250ms initially, capped at 3.2–4s). The HTTP request deadline remains 10s.
Notifications cannot bypass a pending failure delay; cancellation and run
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

A successful read resets the episode and emits
`active-input source read recovered` at INFO, including `next_outcome` (`input`
or `empty`), `recovered_after_failures`, `failure_elapsed_ms` and
`was_degraded`. An `input` outcome proves only a readable pending prompt, not
Guest acceptance or a steered declaration. Cancellation never fabricates read
recovery. Runner INFO records remain local; Axiom continues ingesting WARN+
only.

### API heartbeat delivery recovery

The Runner sends routine API heartbeats every 10s through one single-flight
owner. In `starting`, `running` and `draining` modes, send timeouts, connect
failures and a typed TCP connection reset participate in one Runner-local
heartbeat degradation episode. The first failure is INFO. If delivery keeps
failing for at least 30s after the first observed failure, the next failed
attempt emits one `heartbeat delivery degraded` WARN; later eligible failures
remain INFO with `degraded=true`. The threshold is an operational boundary
evaluated when a failed request completes, not a new timer or retry deadline.

The next successful heartbeat clears the episode and emits
`heartbeat delivery recovered` at INFO with the failure count, elapsed time and
whether the episode degraded. INFO remains local because Axiom ingests WARN+.
Stopping-mode heartbeats and unsupported construction, HTTP status, body,
decode, protocol, local and unclassified failures retain immediate WARN
visibility and do not advance an eligible episode.

This policy does not replay an ambiguously completed request. The next scheduled
heartbeat sends fresh Runner state using the existing cadence, request timeout,
single-flight ownership and freshness boundaries. Recovery proves that later
heartbeat delivery resumed; it does not identify the reset initiator or prove
whether an unlogged failed request reached server processing.

Before closing [#35470](https://github.com/vm0-ai/okou/issues/35470), identify the
deployed Runner release and commit and inspect a bounded real-traffic window for
the exact reset, degradation and recovery signatures. Group older draining
Runners separately because they retain the previous immediate warning policy.
Missing WARN records alone do not prove recovery, and verification does not
require or authorize production fault injection.

### Builtin firewall catalog refresh recovery

Startup still requires a successful catalog fetch, validation and private cache
publication. Periodic refresh keeps its five-minute interval and ten-second
request budget. A failed refresh never replaces the last published catalog.

A typed send-stage timeout or TCP connection reset, or an already classified
transient JSON body-read failure, is INFO only while the existing cache passes
the trusted, size-bounded reader and schema/firewall validation. Missing, corrupt
or untrusted cache, other send failures, HTTP status, JSON/schema/size and local
publication failures remain immediately actionable. No cache expiry or freshness
guarantee is introduced, and firewall enforcement is unchanged.

Eligible send and body failures share one catalog-owned episode. The first
failure is INFO; a later failed observation spanning at least five minutes emits
one `builtin firewall catalog refresh degraded` WARN. Further eligible failures
are INFO with `degraded=true`. This threshold is checked after a failed attempt,
not by an exact timer. A complete successful refresh emits
`builtin firewall catalog refresh recovered`, even if identical trusted cache
bytes need no rewrite. Cancellation does not report recovery.

Send-stage diagnostics include the existing request/session identity for API
correlation and `failure_stage=send`, without inventing a response status or
logging credentials or response content. INFO remains local; Axiom still ingests
WARN+ only. Before closing [#33373](https://github.com/vm0-ai/vm0/issues/33373) or
[#37447](https://github.com/okou-ai/okou/issues/37447),
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

### Native Kerberos redistribution package

The root-only operator commands `runner native-kerberos helper`,
`runner native-kerberos notices` and `runner native-kerberos identity` export
this Runner's immutable build-selected helper ELF, complete MIT/musl/Zig notices,
and target/digest/length identity to stdout. Helper output is binary; redirect it
to a private file and keep the notices alongside any redistributed helper.
These commands do not open a VNC/KDC connection, start a native worker, advertise
a profile/capability or enable a product feature. No backend/library/path
override is admitted. Existing commands and Runner's root requirement are unchanged.

`.github/scripts/check-runner-native-package.py` consumes the actual verified
Runner payload and its producer metadata on the matching native CPU. It checks
complete exported bytes against that Runner, full notice delivery and ELF64
machine/endianness with no `PT_INTERP` or `DT_NEEDED`. Its optional
`privileged-synthetic` mode exercises the **exported** helper's secret-free
Ready, invalid-initialize refusal, bad-profile refusal and close/reap/fixed-file
cleanup inside an already selected disposable native CI context. It neither
changes host policy nor elevates privilege. Package-only success is not runtime
success; unsupported bootstrap fails a required positive run.

Both release-derived thin-LTO `ci` and full-LTO `release` Runner consumers need
separate producer/target/profile-bound checks. The verifier labels HEAD, dirty
state, original producer, Runner/helper/notice identities, UID/kernel and its
limited scope. It does not establish mutual GSS, Rust supervisor cancellation or
non-root availability, and does not authorize production activation.

Runner Image's pre-merge `native-release-build` producer uses the unchanged pinned
release toolchain and the same-head verified CLI, then the ordinary two-phase
`--locked --release` guest/Runner recipe. Its target-specific, one-day conformance
input is not a production release asset or Runner cache entry. Original compiler
JSON, clean source/tree and input identities, full-LTO profile, native build-script
identities and payload hashes are validated before the matching Ubuntu x86/ARM
consumer executes the actual Runner and exported helper. No target/profile label
alone establishes that proof. A failed native probe retains available actual
package evidence with `runtimeVerified: false` and still fails the job. Required
optimized Rust-supervisor lifecycle evidence remains a separate mandatory gate.

The additional optimized integration producer stays inside that existing pinned
producer and its 25-minute budget. It compiles the unchanged public worker process,
parent-death and cleanup-uncertainty suites plus the independent controlled-peer
suite under both `ci` and `release`, without executing cross-target outputs.
Compiler receipts must identify an optimized **non-test production library** and
real optimized integration executables. Matching native x86/ARM consumers bind
the original source/tree, compiler, same-source CLI context and payload receipts,
then require their build-selected helper bytes to equal the corresponding actual
package exports. A difference refuses execution; no helper/environment override
repairs it. Fixture acceptor code is read from the verifier checkout, not a
producer-container compile-time path.

The privileged-synthetic namespace executes all 18 existing public process tests
and seven existing acquisition/renewal/mutual-GSS/RFC4752/TLS finality tests. Fixed
lifetimes, capacity, CPU and cancellation assertions are unchanged. Original
compiler/provider records and non-secret results are retained; synthetic fixture
credentials never leave the disposable child namespace. Missing tests, bootstrap
refusal, failed cleanup, timeout or unexpected skip cannot satisfy the selected
conformance gate. These are optimized production-library integration tests, not
a replacement for distributed Runner package checks, source-pinned full QEMU PNG,
non-root availability, whole-PR approval or K3 activation. Actual execution and
fit within the unchanged budget are required evidence, not source-level promises.

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

Request transport failures are INFO and remain in local Runner logs. Each
Runner process maintains an exact five-minute rolling window of eligible upload
sessions. A session is an eligible success only when it sends at least one HTTP
request, every response is a confirmed 2xx, and the session completes normally;
a request transport failure is an eligible failure. Confirmed rejection,
request construction, malformed input, capacity or source truncation, deadline
cancellation, and sessions that send no request are excluded even if an earlier
batch received 2xx.

When the window contains at least three eligible failures and a failure rate of
at least 20%, the Runner emits one `network log uploads degraded` ERROR with
bounded window, count, rate, and stable transport-cause fields. Further
qualifying outcomes do not repeat the ERROR while the threshold remains met.
The latch resets silently after a later eligible observation leaves either
threshold unmet, allowing a later incident to emit once. There is no recovery
log, background timer, persistence, cross-Runner aggregation, retry, or replay;
a Runner restart begins with an empty window.

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
  -p guest-agent -p guest-storage-apply -p guest-init -p claude-mock -p codex-mock -p guest-state-restore -p guest-tool-exec -p guest-write-file -p guest-home-mount -p runner-rpc-client \
  --profile ci

# Step 2: build runner with embedded Guest binaries and the CLI tarball.
# Build package.tgz + manifest.json from this same checkout first (see the Runner Image workflow).
# The explicitly supplied manifest provides compile-time install metadata; it is not embedded.
# Paths below are relative to crates/; set every Guest, CLI and manifest path or omit all.
GUEST_CLI_PATH="../runner-cli-intermediate/package.tgz" \
GUEST_CLI_MANIFEST_PATH="../runner-cli-intermediate/manifest.json" \
GUEST_AGENT_PATH="target/$TARGET_TRIPLE/ci/guest-agent" \
GUEST_STORAGE_APPLY_PATH="target/$TARGET_TRIPLE/ci/guest-storage-apply" \
GUEST_INIT_PATH="target/$TARGET_TRIPLE/ci/guest-init" \
CLAUDE_MOCK_PATH="target/$TARGET_TRIPLE/ci/claude-mock" \
CODEX_MOCK_PATH="target/$TARGET_TRIPLE/ci/codex-mock" \
GUEST_STATE_RESTORE_PATH="target/$TARGET_TRIPLE/ci/guest-state-restore" \
GUEST_TOOL_EXEC_PATH="target/$TARGET_TRIPLE/ci/guest-tool-exec" \
GUEST_WRITE_FILE_PATH="target/$TARGET_TRIPLE/ci/guest-write-file" \
GUEST_HOME_MOUNT_PATH="target/$TARGET_TRIPLE/ci/guest-home-mount" \
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

For affected-crate commands and serialized execution, see
[memory-constrained Rust testing](../docs/runner/rust-testing.md#memory-constrained-environments).
