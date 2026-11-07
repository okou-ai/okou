# Rust Crates

This workspace contains Rust crates for sandbox orchestration, guest execution,
control and RPC services, shared contracts, and developer/test support.

## Crates

| Crate                | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| runner               | Process-wide composition, `start` boot/configuration/lock policy, operational CLI and build packaging                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| runner-executor      | Claimed-run sandbox execution, session history, results, diagnostics and per-run telemetry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| runner-host          | Runner host filesystem and persisted process identity, live process registry, local control IPC, systemd identity/query/selected-config primitives, orphan-workspace GC, filesystem accounting and identity-aware lock cleanup, shared byte formatting, locks, paths and logging                                                                                                                                                                                                                                                                                                                         |
| runner-lifecycle     | Active-run handoff, idle sandbox, status, home image and cache snapshot lifecycle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| runner-network       | Runner proxy process/recovery, DNS, CA, network log capture and bounded upload                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| runner-provider      | API/local job discovery, claiming, completion, active input, cancellation and queue coordination                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| runner-remote        | Guest RPC, remote usage, SSH authority/sessions/files, and VNC sessions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| runner-storage       | Storage planning, archive delivery, host archive/decoded-cache GC and R2 template cache                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| runner-supervisor    | Concrete retained reactor, ordered factory startup/teardown, dispatch and independent maintenance; idle replenishment and exact operator reclamation, pre-claim preference/admission/claim rollback and pending finalizing-candidate state, claimed-idle reservation/rollback, finalizing-successor arbitration, claimed resource selection/activation and status/failure recovery, post-executor finalizing and sandbox finalization, provider report ordering, active-run completion settlement, panic disposition recovery, heartbeat, ownership transitions, and orphan recovery above domain owners |
| runner-types         | Shared Runner identifiers, API payloads, storage manifest types and validation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| sandbox              | Provider-neutral sandbox interfaces and shared lifecycle/control types                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| sandbox-firecracker  | Firecracker provider: VM lifecycle, networking, NBD COW and snapshot restore                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| sandbox-mock         | Test implementation of the sandbox interfaces                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| nbd-cow              | Userspace Linux NBD block devices with copy-on-write storage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| guest-control-proto  | Wire messages and codecs for controlling guest operations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| guest-control-client | Runner-side guest-control caller, response dispatch and operation tracking                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| guest-control-server | Guest control service embedded by guest-init in its child process                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| guest-control-tests  | Real client/server integration tests over Unix sockets and executable fixtures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| runner-rpc-proto     | Bounded framing and stream contracts for calls to Runner services                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| runner-rpc-client    | Guest-side Runner RPC caller/helper, without business-method dispatch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| process-control-ipc  | Guest-local process control, Unix transport and descriptor handoff                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| guest-init           | Guest PID 1 initialization, signal supervision, child reaping and control-service composition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| guest-agent          | Agent CLI lifecycle, heartbeat, events, native session history and artifact persistence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| guest-tool-exec      | Tool hook adaptation and placement-before-exec launcher                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| guest-storage-apply  | Storage/artifact manifest application: cleanup, preparation, extraction and instruction normalization                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| guest-state-restore  | Entropy/clock restoration and timezone configuration, including timezone-only mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| guest-write-file     | Direct stdin-to-file writes, including private and batch modes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| guest-home-mount     | Fixed home mount identity checks and bounded pristine initialization, with one ext4 mount child                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| claude-mock          | Claude test double, currently emitting CLI JSONL and session artifacts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| codex-mock           | Codex test double, currently implementing app-server JSON-RPC and session artifacts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| guest-contracts      | Shared Runner/guest runtime agreements, paths and filesystem helpers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| api-contracts        | TypeScript-owned API bindings and shared decoding/route helpers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| guest-telemetry      | Structured guest logging and operation telemetry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ably-subscriber      | Subscribe-only Ably client with authentication and connection recovery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| shell-quote          | POSIX shell argument quoting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| linux-mountinfo      | Byte-preserving Linux mountinfo parsing shared by host and guest consumers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| tracing-test-support | Structured tracing capture for tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| xtask                | Workspace developer checks, invoked through the cargo xtask alias                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

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
Guest  -> runner-rpc-client   -> Runner service endpoint
Guest  -> process-control-ipc  -> guest-local process control / placement
```

Client/server names describe application calling roles, not socket initiation.
The guest opens the guest-control connection; Runner accepts it and calls guest
operations. The transport remains vsock forwarded through Firecracker Unix
sockets (or direct Unix sockets in integration tests). These services do not
implement a generic vsock protocol. Runner uses sandbox-firecracker through the
sandbox interfaces; guest-init remains PID 1 and composes the control
service in the existing child.

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

An exec response, including an error, must be fully written and flushed within
5 seconds of becoming available. This separate response deadline is not extended
by write progress. Expiry closes the connection and releases the completed output
and handler slot, even when the peer stays connected. A slow reader can receive an
incomplete response and a transport error; the command's execution budget is unchanged.

Saturated or unusually slow local clients can therefore receive connection errors.
These limits apply per socket. The payload budget does not include parsed commands,
responses, allocator overhead, or kernel socket buffers, and does not bound host-wide RSS.

### Local submit result delivery

`runner local submit` writes the completed job's JSON result and a newline to
stdout, then flushes it before cleaning up the queue files. After successful
delivery, a zero job exit code returns success; any nonzero job exit code returns
failure.

If writing or flushing stdout fails, the command returns an error and reports
the retained completed-result file path. Recover the JSON from that file after
fixing the output destination. Do not resubmit the job to recover its output:
the job has already completed, and the retained result prevents re-execution.

### Local active input

`runner local input` requires a claimed local job with active-input forwarding
enabled. Ordinary submissions leave forwarding disabled. Enable it when submitting
the job with `runner local submit --active-input after=1s,text=hello` and the other
required submission arguments. An already-running job cannot enable forwarding
retroactively; resubmit it with the option when input is needed.

The input command rejects disabled forwarding or unavailable job metadata without
creating an input entry. A successful command reports file publication, not an
acknowledgement that the running agent consumed the input.

The runner reads only the next sequence from its canonical queue path, with a
2 MiB limit on each serialized entry including metadata. A missing or invalid
entry holds later inputs in order. Accepted inputs drain immediately; missing
entries and definite Guest backpressure retain the 250 ms local polling delay.
The Guest control payload still has its separate 1 MiB limit.

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
`GET /api/runners/runs/:runId/steerable-inputs/next` initially and after a wakeup:
an `active-input` push for that run, or an Ably subscription connection or
reconnection that wakes all active runs. A lagged notification receiver also
wakes its reader because it may have missed a matching push. There is no periodic
API recheck; the 250 ms polling delay applies only to the local queue. An eligible
request-stage reset can recover once in the shared HTTP transport described below.

A failed read emits `active-input source read failed; waiting for the next wakeup`
at ERROR, then waits for another wakeup. Without one, the input can remain unread
for the rest of the run. There is no read-failure backoff or degradation/recovery
episode log. The HTTP request deadline remains 10s; cancellation and run
completion still interrupt reads and wakeup waits.

Reading a pending prompt does not prove Guest acceptance or a steered declaration.
The Runner forwards at most one input at a time to the Guest and does not resend
an accepted input or one with an uncertain Guest control outcome on subsequent
reads. An input the Guest definitely did not accept can be offered again after a
later wakeup. The Guest declares a backend-accepted input steered through
`POST /api/runners/runs/:runId/steerable-inputs/:eventId/steered`; a `409`
(`INPUT_ALREADY_CONSUMED` or `RUN_NOT_RUNNING`) is final and ignored. The Runner
does not make this declaration; the Guest makes a single attempt without retry.

The [provider source](runner-provider/src/active_input.rs),
[Ably wakeup routing](runner-provider/src/provider/api_ably_supervisor.rs),
[executor](runner-executor/src/executor/active_input.rs), and
[Guest declaration worker](guest-agent/src/steered_inputs.rs) own these boundaries.
The [active-input regression tests](runner-executor/src/executor/tests/agent_run_tests/active_input.rs)
cover failed-read waits, the absence of periodic API reads, and reconnect wakeups.

### Shared API request recovery

The shared Runner HTTP owner recovers a request-stage TCP reset once for
GET/HEAD/OPTIONS and audited replay-safe poll, heartbeat and catalog POSTs. It
waits 100–150 ms, preserves authentication, body and query, and assigns a fresh
client request ID to each attempt it owns. Both attempts and the wait share the
original request timeout (normally 10s; catalog resolution overrides it to 60s).
At most eight logical requests per shared client can be recovering concurrently;
original requests do not wait for this capacity. Dropping the caller cancels the
pending wait or attempt.

Preferred reuse claims declare their existing conditional policy to this same
owner: one retry after 100 ms on HTTP 500 or reset, while the local preference is
valid and shutdown has not begun. The first admitted request still drains, and
each attempt retains its 10s allowance. Completion declares its existing three
attempts, two-second waits and transient HTTP/transport eligibility, with 10s per
attempt and a 34s total ceiling. The provider retains admission, cooldowns,
ownership and final outcome handling without another transport retry loop.
Executor startup reporting uses the same bounded transient policy with three
two-second attempts and two-second waits (a 10s ceiling); its outer cancellation
still interrupts either a request or backoff, and its report task remains owned.
Claim replay rebuilds its typed request telemetry so discovery/admission timing
includes the first failure and backoff; other request payloads stay unchanged.

Cloneable bytes alone do not grant replay permission. Other writes, including
append-style telemetry and network logs, are not replayed. Failures while reading
a response body after headers are returned are not transparently retried.
Caller-owned raw transport paths, including uncertain remote-control commands,
keep their existing ownership. Fault diagnostics remain local INFO, one record
per failed attempt plus bounded recovery metadata; healthy requests add no
recovery log. Recovery reduces a reset's impact without identifying its sender.
Reqwest/Hyper's existing safe protocol recovery remains unchanged; these limits
count attempts owned by the shared client.

### API heartbeat delivery recovery

The Runner sends routine API heartbeats every 60s through one single-flight
owner. Capacity, idle-pool ownership, lifecycle and reusable-inventory changes
request prompt full snapshots; in-flight triggers coalesce into one live-state
follow-up. The API considers reuse inventory fresh for 180s. Local status retry
and passive host memory observation retain their independent 10s cadence.

Failed background heartbeats in `running` and `draining` retry fresh state after
10s without waiting for the routine timer. A new state report supersedes a
scheduled retry. Startup still requires initial delivery success; shutdown
drains owned work without starting a background retry loop.

In `starting`, `running` and `draining` modes, send timeouts, connect
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

The shared transport can replay the same monotonic heartbeat snapshot once on a
request-stage reset within the original timeout. Exhausted failures still enter
this episode; the next report sends fresh Runner state using the retry cadence
and single-flight ownership described above. Recovery proves that later
heartbeat delivery resumed; it does not identify the reset
initiator or prove whether an unlogged failed request reached server processing.

Before closing [#35470](https://github.com/vm0-ai/okou/issues/35470), identify the
deployed Runner release and commit and inspect a bounded real-traffic window for
the exact reset, degradation and recovery signatures. Group older draining
Runners separately because they retain the previous immediate warning policy.
Missing WARN records alone do not prove recovery, and verification does not
require or authorize production fault injection.

### Builtin firewall catalog refresh recovery

Startup still requires a successful catalog fetch, validation and private cache
publication. Periodic refresh keeps its five-minute interval and sixty-second
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
malformed input prevents an otherwise completed upload from qualifying as an
eligible success. A terminal typed request transport failure is an eligible
failure, even if malformed lines were skipped earlier. Confirmed rejection,
request construction failure, capacity or source truncation, deadline cancellation,
and sessions that send no request are excluded even if an earlier batch received 2xx.

For example, a JSONL file contains one malformed line and one valid entry. If
the valid entry's upload returns 2xx and the session completes normally, the
session is excluded because of the malformed input. If that request instead ends
in a typed transport failure before the overall deadline, the session is an
eligible failure. Three such failed sessions in an otherwise empty five-minute
window meet the alert threshold.

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

# Cross-compile with the shared production, CI and development release profile.
# Supported targets:
#   aarch64-unknown-linux-musl
#   x86_64-unknown-linux-musl
TARGET_TRIPLE=aarch64-unknown-linux-musl

# Step 1: build guest binaries
cargo build --target "$TARGET_TRIPLE" \
  -p guest-agent -p guest-storage-apply -p guest-init -p claude-mock -p codex-mock -p guest-state-restore -p guest-tool-exec -p guest-task-exec -p guest-write-file -p guest-home-mount -p runner-rpc-client \
  --release

# Step 2: build runner with embedded Guest binaries and the CLI tarball.
# Build package.tgz + manifest.json from this same checkout first (see the Runner Image workflow).
# The explicitly supplied manifest provides compile-time install metadata; it is not embedded.
# Paths below are relative to crates/; set every Guest, CLI and manifest path or omit all.
GUEST_CLI_PATH="../runner-cli-intermediate/package.tgz" \
GUEST_CLI_MANIFEST_PATH="../runner-cli-intermediate/manifest.json" \
GUEST_AGENT_PATH="target/$TARGET_TRIPLE/release/guest-agent" \
GUEST_STORAGE_APPLY_PATH="target/$TARGET_TRIPLE/release/guest-storage-apply" \
GUEST_INIT_PATH="target/$TARGET_TRIPLE/release/guest-init" \
CLAUDE_MOCK_PATH="target/$TARGET_TRIPLE/release/claude-mock" \
CODEX_MOCK_PATH="target/$TARGET_TRIPLE/release/codex-mock" \
GUEST_STATE_RESTORE_PATH="target/$TARGET_TRIPLE/release/guest-state-restore" \
GUEST_TOOL_EXEC_PATH="target/$TARGET_TRIPLE/release/guest-tool-exec" \
GUEST_TASK_EXEC_PATH="target/$TARGET_TRIPLE/release/guest-task-exec" \
GUEST_WRITE_FILE_PATH="target/$TARGET_TRIPLE/release/guest-write-file" \
GUEST_HOME_MOUNT_PATH="target/$TARGET_TRIPLE/release/guest-home-mount" \
RUNNER_RPC_CLIENT_PATH="target/$TARGET_TRIPLE/release/runner-rpc-client" \
cargo build --target "$TARGET_TRIPLE" -p runner --release
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
