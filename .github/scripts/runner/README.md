# Runner CI tools

These commands adapt Runner build, image and lifecycle operations to CI. Run them
from the repository root. Their callers live in the Runner image, Crates, Turbo,
cleanup and release workflows, the SSH setup action and `scripts/dev-runner.sh`.
Native behavior scenarios and their fixtures belong to the
[Runner behavior suite](../../../crates/runner/tests/behavior/) and the
[sandbox native suite](../../../crates/sandbox-firecracker/tests/native/).

| Responsibility                                                   | Commands or module                                                                                                                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Committed build inputs, digest, materialization and compilation  | `runner-binary-build/`                                                                                                                                                  |
| Binary reuse, GitHub lookup, bounded downloads and R2 transport  | `runner-binary-cache-plan.sh`, `runner-binary-cache.sh`, `runner-binary-github.sh`, `runner-binary-r2.sh`, `runner-binary-download.sh`, `runner-binary-transport.sh`    |
| Guest inventory and architecture selection                       | `runner-guest-binaries.sh`, `runner-image-target.sh`, `runner-host-architecture-groups.sh`                                                                              |
| Image planning, preparation, manifests and readiness             | `runner-image-context.sh`, `runner-image-architecture.sh`, `prepare-runner-image.sh`, `runner-image-manifest.sh`, `wait-runner-image.sh`, `wait-runner-image-groups.sh` |
| Image execution identity, result recovery and retirement         | `runner-image-operation.py`                                                                                                                                             |
| Group reconciliation and startup                                 | `reconcile-runner-binary-groups.sh`, `reconcile-and-start-runner-groups.sh`                                                                                             |
| Lifecycle ownership and cleanup                                  | `with-runner-lifecycle-lock.sh`, `cleanup-metal-runners.py`, `cleanup-metal-resources.py`, `start-stripe-listener.sh`, `deploy-stripe-listener.py`, `prune-runner-idle.sh` |
| Native test binary build and artifact transport                  | `runner-native-test-artifact.sh`                                                                                                                                        |
| Cloudflare SSH setup, probes, guarded operations and diagnostics | `cloudflare-ssh-proxy.sh`, `cloudflare-ssh-preconnect.sh`, `cloudflare-ssh-command.sh`, `cloudflare-ssh-diagnostics.sh`                                                 |

The target, guest inventory, binary R2/download/GitHub and SSH diagnostic files expose
sourced helpers. Commands document arguments and required environment in their
usage or validation; workflows supply captured revisions, architecture, host and
artifact identity. Git, Bash, jq and the selected command's Cargo, AWS CLI, zstd,
SSH or Ansible dependencies must be available. Preserve structured stdout and
GitHub output-file contracts, stderr diagnostics and original failure statuses.

Binary publication shares one 180s deadline across compression, conditional binary
PUT, retained HEAD/GET verification and run-reference PUT/GET verification. Each
AWS request has a 60s ceiling, shortened to the remaining budget with 5s reserved
for termination. Socket connect/read timeouts remain 5s/30s. The helper disables
SDK retries and makes at most three attempts per operation with 1s/2s backoff.
Connection establishment failures retry directly. Other transient PUT failures
inspect the exact key first; existing objects are validated, not overwritten.
Only a missing key permits another PUT. A reference recovered after a lost write
response must match the exact manifest. Permanent errors and invalid retained
bytes fail the job without retrying validation or publishing a substitute.

Publication stderr identifies compression, PUT, recovery HEAD and retained GET
stages with request attempts, elapsed seconds and safe categories, including
`connect-timeout` and `read-timeout`. A request `timeout` means the whole attempt
deadline expired; it does not prove connection failure or upload progress. Local
compressed bytes are not a network byte count. Raw AWS errors remain private and
temporary. Cancellation retires owned compression, requests/backoff and publisher
children. Compression and other publisher intermediates stay inside the
transport-owned output tree, so cleanup also contains a forcibly retired publisher.

Build inventory includes the complete `runner-binary-build/` module and production
crate inputs by committed Git mode, path and blob identity. Materialized commands
must use those same paths. The SSH action exports this owner directory for recovery
helpers; guarded SSH/SCP/SFTP operations remain single-shot. Lifecycle commands
retain shared lock identities and cancellation/cleanup ownership.

Run the retained affected suites in `../tests/` through their shell entry points.
The shard manifest registers those suites; native/image execution remains in the
PR pipeline. Follow the [GitHub scripts standard](../../../docs/github-scripts.md)
when changing callers, copied tools, hashed inputs, selectors or command contracts.

`stage-native-test-binary.sh <local-executable> <user@host> </tmp/path>` owns
native acceptance executable staging for rootfs-process, host CPU fairness and
Guest RPC. It streams into a unique remote temporary sibling, verifies SHA-256,
then publishes executable bytes by atomic rename. Only transport exits
124/141/255 permit another staging attempt, with at most three 120-second calls
inside a 400-second total deadline (plus a ten-second cancellation grace).
Each attempt allows ten seconds for termination so the guarded SSH caller's
five-second cancellation cleanup can finish before forced KILL. The transfer
deadline stays 120 seconds; the overall deadline also contains this cleanup.
Integrity/remote command failures propagate.
A lost acknowledgement can publish the same verified bytes again; a late partial
writer cannot become the executable. Remote EXIT cleans its own temporary file;
an interrupted transport can delay that cleanup. Actual native execution remains
outside this retry boundary. NBD-COW retains its own isolated-candidate protocol.

Inputs above 128 MiB use a private upload directory and independently verified
64 MiB chunks. A transport interruption retries the current chunk while keeping
the previously accepted chunks. Finalization verifies the assembled executable
against the original SHA-256 before the atomic rename. All requests share the
400-second staging deadline. Cleanup removes the upload directory when the
host is reachable and reports an unconfirmed cleanup otherwise.

## Runner host architecture probe

Runner host grouping and image preparation share the `uname -m` probe.
An SSH exit 255 permits one retry on the same host. The caller validates the
architecture from a successful probe before using it.

## Stripe listener deployment

`start-stripe-listener.sh` reads the current GitHub workflow run's creation
time and calls `deploy-stripe-listener.py`. CI sends the Python worker and
verified Stripe installer through stdin to the selected Runner host. A bounded
transient systemd service holds the same PR lifecycle flock as Runner and
closed-PR cleanup. It checks the current operation and PR closure cutoff,
retires the old listener, and waits for the new listener's readiness.

Each deployment records launch intent before submission. The guarded SSH
caller reads the result with short requests to the same host. A lost reply
permits observation of that operation, and a ready reply must match the
installed listener's deployment marker. The host keeps the current receipt in
`/run/vm0-ci-stripe-deployments/pr-N`. Workers remove their private staging
after execution, successors retire superseded staging, and closed-PR cleanup
removes the namespace. A host restart clears operation state.

Stripe unit publication and fleet cleanup mark their unit-file changes under
the shared host reload lock. An acknowledged reload clears the pending marker
and covers every change already published under that lock. A failed reload or
interrupted publisher leaves work pending. Before startup, the Stripe worker
checks that the manager loaded the expected fragment and reports it current.

## Image operation recovery

`python3 runner-image-operation.py claim|cancel HOST`,
`run HOST warm|build RESULT_PATH`, and `guard HOST COMMAND ...` are internal
adapters used by `prepare-runner-image.sh`. They require `JOB_REF`, `HEAD_SHA`,
`TARGET_TRIPLE`, `PROFILE`, `METAL_USER`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`,
`EXPECTED_BINARY_INPUT_DIGEST`, and `RUNNER_IMAGE_RUNNER_SHA256`. PR claims also
require `RUNNER_IMAGE_RUN_CREATED_AT` from the GitHub run record. Warm/build
consume the workflow's four `R2_*` values. Dependencies are Python 3, SSH and
remote sudo/systemd with the existing Runner permissions.
The `validate HOST` preflight checks the complete identity without SSH.

Claim fences a workflow generation and retires superseded image control groups
before preparation reuses paths. Preparation cleanup, binary publication, GC
and setup run in bounded transient services holding that same private gate and
recheck ownership. Their command digest and per-call nonce survive reconnection;
the same command is never submitted twice. GC's former retry-on-255 loop is
replaced by original-result retrieval, so a known remote failure remains failed.
Isolated binary upload candidates do not publish outside the guarded
validation/rename boundary.

PR builds publish the binary at `bin/pr-N-image-RUN_ID/runner` under the
Runner data root. A rerun of an architecture within that workflow run can
reuse the same bytes, so the architecture manifests still share a directory.
Publication rejects a differing binary for an existing generation. The
manifest carries the exact binary path, and validation binds it to the
GitHub artifact's producer run. Recovery can repair that path while
the directory exists. Closed-PR cleanup owns directory retirement and removes
all generations after its active-owner and service checks. Superseded
generations occupy disk until the PR is cleaned up. Preview service replacement
and its mutable runtime directories are owned by deployment.

Image writers also hold the existing host-local lifecycle lock used by Runner
deployment and closed-PR cleanup. Its root-owned file keeps the same inode and
is readable by workers so Linux can lock a read-only descriptor without running
the worker as root. The private image gate is acquired first; cleanup never
acquires that gate, and cancellation retires image units before waiting for it.
An image claim waits for the lifecycle flock outside the private gate. The
waiter observes cancellation and retires older workers that take the gate
during the wait. When the lock becomes available, it releases the observation
lock and retries admission in the original lock order. PR claim uses a
180-second end-to-end budget covering both lock waits and admission, including
the default 150-second deployment lease. The owner and closure cutoff are
checked again under both locks.
During claim retirement, a timed-out unit status read can retry once within
the same claim deadline. Admission still requires verified retirement.
The healthy path uses one SSH request. Run and guard retain their 600-second
budgets.
A claim places an exact-owner admission marker in the managed binary directory;
preparation preserves only its current marker. After taking the lifecycle lock,
every worker checks that marker again. Removing the namespace therefore fences
queued or delayed services, even when launch is not yet visible to cleanup.
A same-owner claim cannot recreate a retired marker; a new workflow
generation is required. The namespace owner records the host-resolved lifecycle
lock and resource directory paths. No application/database schema changes.
Closed-PR cleanup records GitHub's latest closure time in the existing lock
file before removing resources. Each claim and each new worker compares that
cutoff with the workflow run's GitHub creation time while holding the lock.
Reopening a PR can admit a fresh run created after closure. Rerunning an older
run keeps its original creation time. Same-owner claims and new worker launches
require the creation time recorded when that owner was admitted. The cutoff
lasts for the life of the host lock file.
Owner state transitions from `claiming` to `ready` only after the marker and
admission record are committed under the lifecycle lock; cancellation sets
`cancelled`. A retry after SSH loss while waiting for the lifecycle lock can
resume the same claim because admission starts with both locks held. If the
owner is already `claiming` and the original process exits before committing,
the attempt remains incomplete and cannot replay namespace initialization.
Losing a committed claim reply still reattaches idempotently.
Cancellation received before a first claim records a generation cutoff in the
same ledger. An earlier admitted owner can continue, while a delayed first claim
at or below the cutoff is rejected.

Warm/build run once in transient services. Identity covers the exact source,
binary inputs/bytes, target, profile, host, adapter source and workflow run/attempt.
Launch intent precedes submission; intent without a result or live unit fails
unknown only after the launch gate is free and that absence is rechecked.
If execution service submission times out, the caller observes the original
operation within its existing deadline. A
reconnection waits for an in-flight submission without blocking on the worker's
mutation gate or submitting the command again, including when intent appears
after the reconnection has started waiting for that gate. Only 124/141/255 can
reconnect, at most three requests inside the same 600-second call budget.
The execution deadline bounds waiting for unfinished work. A published result
remains retrievable until its retirement timer fires.
Reattachment and final result delivery both verify the current owner and the
managed admission marker. Cancellation or namespace cleanup invalidates result
delivery, and a successor claim removes older operation records.
Service work is limited to 570 seconds with a ten-second control
group stop grace, leaving room for reconciliation inside the unchanged job budget.

The launch SSH call streams bounded, redacted progress and the original result;
the healthy path needs no additional network polling. Success requires numeric
exit status zero and both 64-digit image hashes. Hashes emitted before a failed
build cannot establish success. The adapter atomically writes the validated
result JSON at `RESULT_PATH`, and returns the original build status. The existing
manifest remains schema 1 and keeps its source/architecture gates.

Credentials travel only in stdin, are privately staged, and are unlinked before
Runner execution. Unit arguments, unit environment properties and result identity
contain no values. Retained logs are redacted and capped at 1 MiB while the worker
continues draining output and collecting hashes. Private operation state lives
on remote `/dev/shm`; an unavailable state root fails without falling back to
disk. One-shot systemd timers schedule expiration services under the operation's
SSH user and group. At submission, the CI host's monotonic clock defines a fixed
one-hour deadline that survives systemd reloads. At expiry the service verifies
retirement before removing files. Unconfirmed retirement retains evidence, and
reboot removes tmpfs state. The small namespace ownership ledger and stable gate
remain until reboot or explicit namespace retirement. At most 32 operation
tombstones per owner prevent an older workflow reclaiming ownership or an expired
result permitting execution again.

Cancellation stops and verifies owned services; failed or unreachable retirement
is reported as unconfirmed and retains files. Remote hard deadlines remain in
force. Cancellation also fences admission, so a delayed systemd acceptance cannot
start work after stopped-state verification. Only a new workflow generation can
claim a cancelled namespace. Successful results retain their expiration timer without another SSH call.
This protocol recovers image outcomes, not the initiating transport reset or
preview/production deployment ownership.

## Closed PR resource reconciliation

`python3 .github/scripts/runner/cleanup-metal-runners.py` is shared by scheduled
and PR-close cleanup. It requires `GH_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`,
`METAL_HOSTS` and `METAL_USER`, plus the established SSH tunnel configuration.
`RUNNER_PR_NUMBERS=42,43` selects those PRs even if inventory is empty, so a
close event can fence the first image claim. `DRY_RUN=true` observes and selects
without acquiring lifecycle locks or mutating resources. Each host's inventory
allows one retry on SSH exit 255 within its original 180-second deadline.
An incomplete host inventory fails even in dry-run mode.

The controller starts one ephemeral worker per host for small sorted batches.
An SSH exit 255 before a complete readiness frame permits one reacquisition on
that host within the original 70-second deadline. Each worker holds the namespace
flock itself. All configured hosts must report readiness before fresh GitHub
authorization. Before dispatching cleanup, the controller checks each session's
process and output pipe so a closed channel cannot appear active during diagnostics.
If a previously ready session exits 255 before dispatch, the controller can retire
the batch's sessions and restart preparation once within that host's remaining
readiness budget. The controller requests release from the other sessions before
retiring their channels. It reacquires the full lock set in the original host
order and refreshes GitHub authorization before sending cleanup.
PR state and stabilized owner discovery are fresh under those locks.
Exact owner association protects older CI generations; unresolved
association fails closed instead of guessing from a reused branch. Proven live
owners are reported as deferred, and reopened PRs are retained. Other batches
continue after errors; failed/unknown cleanup and lock outcomes fail the job.
Owner discovery fails closed when a status search reports or returns GitHub's
1,000-run limit. Below that cap, `total_count` is not a coverage predicate: counts
can drift even within one page. Paginated results are deduplicated by run ID, and
selected PR owner ID sets must agree across consecutive sweeps (at most four).
Previously observed selected owners missing from a later sweep are refreshed by
exact ID regardless of count equality. Still-active runs remain owners across
status changes and repeated omissions; only confirmed completed runs leave the
set. These observations are not an atomic GitHub snapshot. Lookup, identity,
association or stabilization failures remain unverified and retain resources.
An unverified or failed result exits 1 because cleanup was not established;
proven live-owner deferrals and reopened PR skips exit 0.

Under the existing namespace locks, the host executor records the closure
cutoff and revokes image admission before inventory and bulk teardown. Older
image workers check that admission marker after taking the same lock, so a
later teardown failure can leave the runner directory without admitting work.
An unverified revocation fails that namespace. The executor then reobserves
runner and Stripe resources, verifies stopped execution before bulk removal,
and verifies final state. If this inventory fails, the executor reports the
remaining selected namespaces as unverified and leaves their services untouched.
It submits all selected stops before polling with one shared 330s stop budget
(Runner units allow 300s). Inactive/failed state, no main PID, no queued/running
job and an unpopulated cgroup are all required before bulk removal. A stop
deadline retains the remaining namespace files and reports failure. Stopped
siblings can still be cleaned. The host operation has a 480s hard limit, inside
the controller's 510s response and 720s batch limits. Heartbeats continue during
the wait, and cancellation interrupts the worker before releasing its namespace
locks.
Absent resources are counted separately from actual cleanup. Persistent and
transient files, directory-only and Stripe-only leftovers participate in discovery;
inactive manager records with no execution, queued job or files do not repeatedly
enter it.
Unresolved results retain nonzero systemctl action diagnostics. If reload or
final inventory fails, `operation_result` retains completed steps; the overall
outcome remains `unverified` rather than claiming verified cleanup.
SSH response loss is not permission to replay a destructive command. Response
deadlines cover a complete JSON frame, including replies stalled mid-line. EOF or
heartbeat lease expiry stops the remote mutation before its own lock descriptors
close. The worker source is paired with the controller and requires no persistent
host installation.

Image worker names use `vm0-ci-image-JOB_REF-DIGEST.service`. Closed-PR cleanup
matches the PR in that name and verifies queued jobs and control groups before
removing files. The separate prefix keeps image workers outside the production
Runner promotion and rollback selectors. Cancellation and expiry also check the
exact unit names used by earlier PR revisions until their retained operations
retire.
Cleanup controllers already running from an earlier revision still share the
lifecycle lock and remove the admission marker. Per-unit retirement of a
worker with the new name requires the updated controller.
A running legacy unit without PR attribution leaves cleanup inventory unverified
and prevents bulk removal. Expiry timers keep their separate
`vm0-ci-image-DIGEST-expire` names and remain image-owned.

Turbo selects the Runner and Stripe host in a shared placement job before
deployment. Stripe opens SSH, takes the lifecycle lock, and runs both Ansible
playbooks on that host. The playbooks verify that the old listener's manager
job, main PID, and cgroup have drained before deleting or replacing its files.
Runner readiness still publishes the deployment receipt
for idle-sandbox cleanup. The closed-PR sweep discovers and retires Stripe
resources across configured hosts, including resources from earlier placements.

Preview startup runs the selected Runner's health checks as part of
`runner service wait-running --check-health`. The command emits numeric
capacity on stdout after the same Runner instance passes health verification.
Health diagnostics go to stderr. Failed verification uses the same partial
start cleanup as other startup failures.

The shared Stripe and preview Runner lock wrapper sends an explicit release
request after the protected command succeeds. Each host closes its flock before
acknowledging that request and saves the operation ID in a root-owned file
under `/run/vm0-runner-lifecycle-receipts`. A transport exit 255 while
releasing permits one bounded, read-only lookup on the affected host. Recovery
requires a receipt for that exact operation and confirmed release on every host.
The healthy path uses the original connection. The most recent receipt for each
namespace survives SSH loss until replacement or reboot. EOF and lease expiry
release the lock without writing a receipt. If acknowledgement is lost, a
missing request or unavailable receipt leaves CI failed. A failed protected
command always retains its exit status.
