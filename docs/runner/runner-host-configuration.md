# Runner Host Configuration

## Diagnostic Host Attribution

`runner.yaml` may contain an optional `hostname` used to identify the physical
runner in claims, sandbox telemetry, and Runner Axiom warning/error events.
Production automation writes the exact Ansible `inventory_hostname`; it does
not derive the value from DNS or the operating system at runtime. For the
internal-only direct WSS target resolver
(`turbo/apps/api/src/signals/services/runner-wss-target.service.ts`),
an eligible official Run's claimed hostname also supplies the browser-facing
DNS authority after syntax validation. It is not a credential or proof that
DNS, TLS, Caddy, or the listener is reachable.

The value must be non-empty and no longer than 255 JavaScript string units
(UTF-16 code units). `runner config --hostname <value>` validates and preserves
the raw value. Existing configuration files without `hostname` continue to
load and omit the canonical hostname fields.

Hostname does not select a Runner process, local service, directory, release,
or rollback target. The WSS resolver's browser-facing origin is a distinct,
internal-only use of the claimed hostname until ticket issuance is authorized
after the fleet rollout and ingress checks.

Systemd service suffixes are opaque local instance names. Production currently
passes its explicit `runner_release` value as the service name and Runner
directory name, but version logic uses `runner_release` directly and does not
interpret a runner name as a version. Live processes are selected by their
exact config path and process identity, and rolling log files use the release
compiled into the Runner binary. Current Runner binaries send optional
canonical `runnerHostname` from configuration and canonical `runnerVersion`
compiled into the binary. They no longer send legacy `runnerName` in
heartbeats or sandbox telemetry. Current API revisions no longer declare,
persist, or map that field. During deployment overlap, an extra `runnerName`
from an older Runner payload is tolerated but discarded before request
handling.

Current `runner.yaml` has no legacy `name` field. Repository automation writes
`hostname` through `runner config`, while `--runner-dirname` and systemd service
`--name` remain opaque local lifecycle inputs. Live-runner records contain exact
config/process metadata and no legacy runner name. Readiness and doctor select
live processes by the unit's exact config path.

Operational queries and alerts should use `runner_hostname` and
`runner_version`. A bounded historical fallback may use `runner_name` only for
records that lack the canonical dimensions from before the cutover. Never
interpret `runner_name` as a hostname.

Runner Axiom warning/error events similarly include optional
`runner_hostname` and required `runner_version`. The rollout order is compatible
API and nullable heartbeat storage, Runner producer cutover, then logical API
receiver removal, followed by physical state-column removal after pre-cutover
serving API instances drained. The current schema no longer contains
`runner_state.runner_name`. Canary each transition and verify claim snapshots,
telemetry/Axiom dimensions, and distinct hostnames on two hosts running one
version. Remove any historical query fallback only after its bounded
observation window expires.

## Active and Parked Sandbox Memory

Active Guests keep a traditional balloon target of zero. Stable free-page
reporting returns pages the Guest has already freed; it does not evict live
file cache. OOM deflation remains enabled. There is no periodic active
inflation policy or available-memory threshold that a workload must cross
before regaining its configured capacity.

This can increase active Firecracker RSS, particularly for file-cache-heavy
workloads. Admission still accounts for profile memory and applies
`concurrency_factor`; it does not measure RSS or reserve host memory overhead.
Overcommit therefore has no worst-case resident-memory safety guarantee.
Size concurrency against the full active profile working set plus host/Runner
overhead, and measure host headroom and parked residency as well as latency.
Free-page reporting and parked reclamation are not substitutes for that budget.

Tenant-free sandboxes prepared for the blank pool retain their full profile
resource budget. Firecracker pauses vCPUs without requesting aggressive idle
balloon inflation. Guest quiesce and operation fencing still complete before pause. This avoids a
large idle-only inflate/deflate cycle when a prepared sandbox is claimed.

Reusable exact/session park inflates the balloon under the existing bounded
reclamation policy, then requests target zero and completes deflation before
pausing vCPUs. Inflation first settles for five seconds. A severe residual can
receive fixed five-second extensions, up to a 30-second absolute settle limit,
only while Firecracker reports the current target and progress between the two
latest samples. Cached `MemFree` and `MemAvailable` can authorize an extension
when they cover the residual and the additional 192 MiB reserve. When only
cached `MemFree` is insufficient, every extension boundary instead requires a
new quiesced Guest `/proc/meminfo` snapshot whose `MemAvailable` covers the same
residual and reserve. A missing, failed, timed-out, or insufficient snapshot
does not grant grace. Snapshot latency consumes the fixed schedule and absolute
limit, and an exact-successor handoff can interrupt the request.

Deflation returns capacity to the Guest allocator without eagerly repopulating
backing discarded by Firecracker; subsequent Guest accesses can fault that
backing in again. Reclamation diagnostics and severe-retention rejection are
decided against the original positive target before deflation. Background park
allows up to 30 seconds for deflation convergence, including in-flight
statistics requests, to tolerate slow deflation without discarding a reusable
sandbox at the foreground deadline. This wait remains interruptible by an
exact-successor handoff. The deadline starts after the target-zero PATCH
completes; it does not bound the whole park operation. A stalled sandbox retains
its full resource budget until recovery destroys it. A longer park can delay
hard-cancellation cleanup and local-provider completion, which wait for
finalization.

Unpark of a completed reusable park resumes vCPUs and Guest operations without
another balloon request or statistics query. Park already completed deflation,
and no other owner changes the target while idle; blank preparation never
inflated. Running handoffs and non-reusable cleanup still request target zero
and wait for exact target/actual page counts to reach zero before reopening Guest
operations. Their convergence wait, including in-flight statistics requests, is
bounded at five seconds; failures keep operations fenced and use the existing
destroy/fresh-create recovery. An accepted handoff starts this foreground wait
instead of inheriting the remaining background deadline. No background balloon
controller or Agent-readiness reclamation gate remains. The full profile budget stays reserved
throughout. Minimum profiles never inflate and skip this balloon recovery.

Zero page counts describe the currently reported state, not a target-generation
acknowledgement: an interrupted Guest inflation batch may update its actual count
after an earlier zero sample. Reporting itself also temporarily isolates free
pages. This policy prevents sustained active inflation; it does not promise
literally invariant `MemFree`/`MemAvailable` at every instant.

An exact successor can take over the still-running sandbox before inflation,
during reclamation or deflation, or before pause commits. The park owner reverses
the target to zero, retires the predecessor assignment and transfers the fenced
resource without pausing it. The successor completes deflation and Guest lifecycle
resume before opening operations; it does not issue a vCPU resume for this running
handoff. A request after pause has started receives the completed parked resource.
Running handoffs remain bound to the exact successor and cannot enter ordinary
idle inventory. Cancelled or rejected transfers retain their full resource lease
through destruction. This policy also applies after a claimed blank completes its
first run; the initial tenant-free blank preparation still skips reclamation.
The handoff acceptance grace remains 1.5 seconds, starting from the later of
predecessor finalization and successor wait initiation so late demand gets an
acceptance window. An already accepted handoff does not expire at that boundary.

Pool sizing, full-profile admission, exact-first reuse and blank-first pressure
eviction are unchanged. Preserving blank memory can increase physical idle
memory usage; the profile budget is not a measurement of resident memory.

## Home layout, identity and retention

The paired Guest/Runner layout mounts writable `/dev/vdb` at fixed `/home/user`;
rootfs remains `/dev/vda`. Profiles use `home_disk_mb: 24576` (24 GiB) and
`rootfs_disk_mb: 12288` (12 GiB). Execution cwd remains
`/home/user/workspace`. Home initialization creates only the bounded intended
non-private skeleton where missing/pristine, without copying a previously used
rootfs home over hit-owned files. Fresh, snapshot, blank, exact-reuse and handoff
paths retain mount/device/no-symlink and user UID/GID validation.

`HomeImageCache` uses `home-image-cache`, `home-drive-v1` and canonical metadata.
Eligibility binds the group, profile, **full configured rootfs hash**, reuse key,
layout and exact home image bytes. A normalized/display hash or shared prefix
cannot establish eligibility. The fixed home scope is independent of cwd.
There is no old workspace-image/config/key/layout decoder, alias or migration;
old images remain a separate retired domain. New build/snapshot identities require
a supported Guest/Runner pair.

Home captures ordinary tools/framework files, `/home/user/.npm` and user files
outside cwd. Current captured instructions, skills, memory, storage, account,
model, auth, permissions and proxy state remain authoritative over stale managed
state. Canonical known/tainted fingerprints retain unknown versus known-empty
and the union of current/previous taint; storage and artifact ownership remain
separate. Home persistence does not widen user artifact export: collection stays
within the declared/cwd artifact boundary, not a full-home export. Explicit npm
cache settings remain honored, without an out-of-home persistence promise.

Default retention keeps the total allocated-byte maximum at 50% of host capacity,
the GC target at 75% of that maximum and the free reserve at max(10%, 50 GiB).
Individual eligibility uses the exact configured profile shape, not an unrelated
percentage-of-host single-image cap. Fresh accounting includes image generations,
metadata, candidate/orphan staging and cross-device sparse-copy peak headroom.
Locked or unavailable observations are not zero. Entry/capacity/reference/age
locks and routine single-flight GC remain authoritative. Unlink in the Guest is
not proof that host allocation was reclaimed. Retention controls must not resize
configured disks or widen thread isolation. These defaults are safety policy,
not measured fleet sizing.

## Idle Home Reclamation Concurrency

### One-shot CI idle reclamation

`runner service prune-idle --name <service-suffix> --expected-runner-id <uuid>
--expected-heartbeat-generation <generation> --timeout-secs 120` reclaims only
the exact idle inventory owned by that Runner when the request is accepted.
Blank sandboxes, active/reserved sandboxes, admission and later parking remain
unchanged. This is not service drain, a no-idle mode, or host-wide GC.

CI captures the Runner UUID and heartbeat generation at deployment readiness.
`cli-e2e-03-runner-cleanup` waits for BATS and shared Playwright consumers, then
uses that receipt even when failed-test accounts are retained. The command
resolves the service's exact config/live process and uses a private,
generation-scoped local socket. Missing services, old binaries without the
command, generation changes and control failures fail visibly without signals
or a fallback to another process.

Selected/completed/uncertain counts are returned only after selected reclamation
attempts finish; uncertain destruction fails the command. A client disconnect
or timeout does not cancel admitted destruction. Normal shutdown joins these
tasks. Home promotion and ordinary history/download/storage caches are preserved.
Later Runs can lose hot VM reuse but retain blank/home-cache paths. Released
profile budget is not an RSS savings measurement.

### Reclamation admission and publication

Home reclamation uses one runner-process-local admission gate sized as
`(host_cpus / 2).clamp(1, 4)`, shared by cache clones. Acquire it **before unpark**
and retain it through terminal unpark, bounded proof capture, namespace/auth
cleanup, home freeze and immediate termination. Waiting jobs remain parked.
Terminal unpark keeps the normal physical-deflation readiness boundary. Direct
and parked terminal callers use the same cleanup/promotion helper after required
history, identity and log readers finish. Idle/handoff preparation remains its
separate non-destructive reader-preservation contract.

The fixed `guest-agent prepare-for-cache` receives typed current/retained runtime
anchors and publication generation. It validates containment and canonical
`/home/user/.vm0/guest-agent/runs` ownership using no-follow, mount and file-identity
checks. Eligible finalized history is verified against actual supported source
and live bytes, then captured as small identity/source/hash/size-only evidence in
`/home/user/.vm0/home-cache/session-history-proof.json`; it has no body. Missing
or invalid evidence clears stale proof and never manufactures a verified history.
The helper removes completed managed runtime children and managed
`.codex/auth.json`, not ordinary user files, histories, catalogs or package caches.
It does not widen deletion to a custom runtime parent or invoke an internal Codex
auth RPC. Cleanup establishes namespace absence, not forensic block erasure.

A missing helper, unsafe anchor, remaining writer, failed cleanup, malformed or
truncated report, uncertain freeze or unsuccessful stop rejects optional
publication without failing an already completed Run. A prepared/frozen sandbox
must never be thawed or returned to idle/handoff. After successful termination,
publication and factory destruction release idle admission; a stop failure or
panic abandons publication and retains admission through destruction.

Publication stages an immutable generation-owned stopped image. Synchronize the
image, metadata staging and affected directories before the one atomic metadata
commit exposes its image/fingerprint/taint/proof tuple. The cache checks proof
digest/generation and retains entry/capacity lock ordering. Failed/uncertain
commits can leave owned orphan allocation, not authority for mixed-generation
bytes. Normal startup/reuse and active completion do not take idle reclamation
admission. This bounds concurrent resumed guests, not team Run concurrency;
capacity-pressure reclamation can therefore take longer. Four is an initial
policy, not a measured optimum or a latency promise.

### Managed terminal private-state inventory

These paths are relative to `/home/user/.vm0/guest-agent/runs/<run-id>` except
Codex auth and the surviving proof. This is the first-party managed inventory,
not an arbitrary-user-file privacy audit. [Runtime paths](../../crates/guest-contracts/src/runtime_paths.rs)
and [private-input contracts](../../crates/guest-contracts/src/env.rs) own the names.

| Managed state / destination                                     | Writer and required reader lifetime                                                                                                                                                             |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user-env/env.json`                                             | Runner current captured values; Guest configuration consumes/removes at startup; terminal cleanup removes any remainder after the workload                                                      |
| `run-payload/payload.json`                                      | Runner typed payload, including mask inputs; Guest config and CLI/finalization readers finish before cleanup                                                                                    |
| `connector-account-context/context.json`                        | Runner account projection; CLI readers finish before deletion                                                                                                                                   |
| `claude-append-system-prompt`, `pi-launch-payload/payload.json` | Guest CLI launch; CLI and Pi finalization finish before cleanup                                                                                                                                 |
| `session-id`, `final-session-history-identity.json`             | Guest session metadata/final history identity; executor diagnostic/identity readers and terminal proof capture finish before deletion; idle/handoff retains the referenced generation           |
| `finalization-error`, `failure-diagnostic.json`                 | Guest failure handling; executor diagnostics finish before finalization                                                                                                                         |
| `logs/`, `telemetry/`                                           | Guest producers/final uploader, executor stdout drain and post-job copying finish before cleanup; host logs have independent lifetimes                                                          |
| `/home/user/.codex/auth.json`                                   | Current Guest auth reconciliation and CLI readers; terminal cleanup scrubs after containment excludes other workloads                                                                           |
| `/home/user/.vm0/home-cache/session-history-proof.json`         | Bounded terminal source/live-byte verification; survives runtime cleanup, bound to the same committed image generation; the next Run must reverify after current preparation and at consumption |

Direct [supervisor finalization](../../crates/runner-supervisor/src/sandbox_finalization.rs)
and parked [idle destruction](../../crates/runner-lifecycle/src/idle_pool/entry.rs)
share the terminal helper. They do not return a terminally prepared sandbox to
idle or handoff. A missing or unsafe current/retained anchor rejects publication;
it does not broaden deletion authority to a captured custom runtime parent.
General remote checkpoint/restore, CPU/download work, cancellation/drain and
supported exact-resource verification remain intact. See
[home history telemetry](home-history-restore-telemetry.md) for source/fallback
and measurement semantics.

## Host-Local Overrides

For control-plane URL and authentication options, use `runner config --help`
and `runner start --help`.

The runner reads host-local overrides from `/etc/vm0-runner/host.env` once
during startup. A missing file is equivalent to an empty file: the runner uses
`runner.yaml` for its concurrency factor and leaves I/O limiters disabled.

Apply file changes through the normal runner drain and restart workflow. A
running process does not reload this file.

## File Format

`host.env` is a runner-specific `KEY=VALUE` file. It is not sourced by a shell.
Blank lines and full-line comments are allowed, and whitespace around keys and
values is ignored:

```text
# Optional host-local concurrency override
OKOU_RUNNER_CONCURRENCY_FACTOR = 1.5
```

Do not use `export`, shell interpolation, quoted numeric values, or inline
comments. The parser accepts only the keys listed below. An unreadable file, a
line without `=`, an unsupported key, or a duplicate key is a configuration
error that prevents the runner from starting.

## Canonical Host-Tuning Contract

The runner accepts only these five host-tuning keys:

| Key                                      | Unit                   | Valid values                               | Behavior                                                                                             |
| ---------------------------------------- | ---------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `OKOU_RUNNER_CONCURRENCY_FACTOR`         | Dimensionless multiple | Positive finite number                     | Optional; overrides `sandbox.concurrency_factor` from `runner.yaml`. An invalid value fails startup. |
| `OKOU_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC` | MiB/s                  | Positive finite decimal in the `u64` range | Required with the other three I/O keys.                                                              |
| `OKOU_RUNNER_DISK_IOPS`                  | Operations/s           | Integer in `1..=u64::MAX`                  | Required with the other three I/O keys.                                                              |
| `OKOU_RUNNER_NET_RX_MIB_PER_SEC`         | MiB/s                  | Positive finite decimal in the `u64` range | Required with the other three I/O keys.                                                              |
| `OKOU_RUNNER_NET_TX_MIB_PER_SEC`         | MiB/s                  | Positive finite decimal in the `u64` range | Required with the other three I/O keys.                                                              |

Each key may appear at most once. Retired host-tuning names and every other
unlisted key are unsupported and cannot select or override a value. The four
I/O keys form one all-or-none group.

Bandwidth values may be fractional. After conversion from MiB/s, the byte/s
value must be at least `1`, must fit in a `u64`, and is rounded down to an
integer. Disk IOPS must parse directly as a nonzero `u64`.

The concurrency override is independent of the I/O group, but it changes the
resource budget used to calculate the I/O limits.

## Rollback Floor and Promotion

Runner `0.178.4` is the rollback floor for hosts using this contract. Do not add an
earlier rollback target unless its compatibility with the canonical host file
has been established separately.

Normal Runner promotion does not mutate `host.env`. It installs, starts, and
health-checks the target before draining old services. If target installation,
readiness, or health fails, promotion stops the failed target and leaves the
already-running old services available.

## Configure Host I/O Capacity

The four I/O keys are one atomic configuration. Either omit all four or provide
all four:

```text
# Example sustainable aggregate host capacity; measure values for this host.
OKOU_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC=2000
OKOU_RUNNER_DISK_IOPS=200000
OKOU_RUNNER_NET_RX_MIB_PER_SEC=1250
OKOU_RUNNER_NET_TX_MIB_PER_SEC=1000
```

These values describe sustainable total host capacity, not desired per-sandbox
rates and not short benchmark peaks. Every valid capacity is reduced by the
host reserve and divided among the maximum number of sandboxes the runner can
admit. Supplying per-sandbox targets here would reduce them again and could
throttle every sandbox below the intended rate.

A complete valid I/O configuration applies to every job on the runner. There
is no per-job feature switch.

## How The Runner Derives Limits

At startup, the runner:

1. Multiplies physical CPU and memory by the resolved concurrency factor to
   produce the effective resource budget.
2. Finds the maximum sandbox count that budget can admit across any mixture of
   configured profile CPU and memory shapes. A nonzero `max_concurrent` is an
   additional cap; `0` means there is no explicit job-count cap.
3. Uses that count as the denominator. For an unusually large calculation, it
   may use a conservative safe upper bound instead. The denominator is always
   at least one.
4. Reserves 20% of each configured host I/O capacity, then divides the remaining
   80% by the denominator using integer division.

For each capacity:

```text
usable host capacity = floor(host capacity * 80 / 100)
sandbox limit = floor(usable host capacity / denominator)
```

Bandwidth values are converted from MiB/s to bytes/s before this calculation.
The disk result is an aggregate sandbox-level block budget. Firecracker uses
per-drive limiters, so it divides that block budget evenly across the writable
drives attached to the sandbox. Network receive and transmit limits apply to
the sandbox network interface without another drive split.

If the calculated block budget cannot provide at least one byte/s and one
operation/s to each of two writable drives, or either network direction cannot
provide at least one byte/s, the entire I/O configuration is insufficient and
all I/O limiters are disabled.

### Worked Example

With the example values above and a resolved denominator of `4`, startup logs
show these sandbox-level limits:

| Capacity       | Host input     | Sandbox limit after reserve and division | Structured log field           |
| -------------- | -------------- | ---------------------------------------- | ------------------------------ |
| Disk bandwidth | `2000 MiB/s`   | `400 MiB/s` = `419430400 bytes/s`        | `disk_bandwidth_bytes_per_sec` |
| Disk IOPS      | `200000 ops/s` | `40000 ops/s`                            | `disk_ops_per_sec`             |
| Network RX     | `1250 MiB/s`   | `250 MiB/s` = `262144000 bytes/s`        | `net_rx_bytes_per_sec`         |
| Network TX     | `1000 MiB/s`   | `200 MiB/s` = `209715200 bytes/s`        | `net_tx_bytes_per_sec`         |

If a sandbox has two writable drives, Firecracker further splits the logged
disk budget into `209715200 bytes/s` and `20000 ops/s` for each drive.

## Failure Behavior

Host-file parsing and I/O resolution have different failure boundaries:

| Configuration state                                                       | Runner behavior                                                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| File missing, or none of the four I/O keys present                        | Starts with I/O limiters disabled and logs `I/O limiters disabled`.                                                                              |
| All four I/O fields present and usable                                    | Starts with all jobs limited and logs `I/O limiter capacity configured; applying limiters to all jobs`.                                          |
| I/O fields partial, numerically invalid, or insufficient after division   | Starts, logs `I/O limiter host env config invalid; disabling I/O limiter capacity` with a `reason`, and disables every disk and network limiter. |
| File unreadable, line malformed, key unsupported, or exact key duplicated | Fails startup with a runner configuration error.                                                                                                 |
| `OKOU_RUNNER_CONCURRENCY_FACTOR` present but invalid                      | Fails startup with a runner configuration error naming the key and `host.env`.                                                                   |

The non-fatal I/O warning is all-or-nothing. A valid disk pair does not stay
enabled when the network pair is missing or invalid, and vice versa.

## Verify The Effective Configuration

After applying the file through the normal restart workflow, inspect the runner
startup logs. For a named systemd service, use:

```bash
runner service logs --name <service-suffix> --lines 100
```

First find `resource budget initialized` and verify:

- `concurrency_factor` and `concurrency_factor_source`
- `max_concurrent`
- `effective_vcpu` and `effective_memory_mb`
- `profiles`

Then verify exactly one I/O resolution message:

- `I/O limiters disabled` when no capacity is configured;
- `I/O limiter host env config invalid; disabling I/O limiter capacity` and
  its `reason` when the I/O group is unusable; or
- `I/O limiter capacity configured; applying limiters to all jobs` when the
  group is active.

The configured message includes:

- `denominator`
- `disk_bandwidth_bytes_per_sec`
- `disk_ops_per_sec`
- `net_rx_bytes_per_sec`
- `net_tx_bytes_per_sec`

These are effective sandbox-level limits. The disk fields are logged before
the per-drive split.

## Implementation Sources

- [`crates/runner-host/src/host_env.rs`](../../crates/runner-host/src/host_env.rs) defines
  the file path, allowed keys, and file parser.
- [`crates/runner/src/runtime_overrides.rs`](../../crates/runner/src/runtime_overrides.rs)
  resolves the concurrency-factor override.
- [`crates/runner-lifecycle/src/resource_budget.rs`](../../crates/runner-lifecycle/src/resource_budget.rs)
  defines the effective CPU and memory budget.
- [`crates/runner/src/io_limits.rs`](../../crates/runner/src/io_limits.rs) validates
  host capacity and derives sandbox-level limits.
- [`crates/runner/src/cmd/start/mod.rs`](../../crates/runner/src/cmd/start/mod.rs)
  emits the startup state and effective-limit logs.
- [`crates/sandbox-firecracker/src/config.rs`](../../crates/sandbox-firecracker/src/config.rs) splits
  the sandbox block budget across Firecracker drives.
