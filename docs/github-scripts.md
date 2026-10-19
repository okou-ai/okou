# GitHub Scripts

Keep CI scripts small and give each one a clear responsibility. Follow
[Testing](testing.md), [code quality](bad-smell.md), and
[deployment compatibility](deployment-compatibility.md) for their existing rules.

## Ownership

| Code                                                       | Location                                      |
| ---------------------------------------------------------- | --------------------------------------------- |
| Events, job dependencies, permissions, and required gates  | `.github/workflows/`                          |
| Reusable GitHub-specific setup                             | `.github/actions/`                            |
| Repository checks and CI build/release/deployment adapters | `.github/scripts/`, grouped by responsibility |
| Product code and behavior tests                            | The owning product package                    |
| Native scenarios and fixtures                              | The owning crate or native test suite         |
| Deployed product journeys                                  | `e2e/`                                        |
| Task-specific audit, migration, or measurement tools       | The operational owner, such as `ops/`         |

A workflow invoking a command does not make that command CI-owned. Keep policy
checkers separate from their regression fixtures. Group related tools by purpose;
preserve useful existing modules. Local invocation instructions belong next to
the owner, and task progress belongs in the issue or PR.

[Artifact tools](../.github/scripts/artifacts/) own build/fetch/verify/smoke phases;
[release tools](../.github/scripts/release/) own promotion and publication adapters.
[Runner tools](../.github/scripts/runner/) own CI build, image, deployment,
lifecycle and supporting SSH adapters.

## Writing Scripts

- Use Bash for simple process orchestration and existing Python/JavaScript modules
  for structured work. Extract shared behavior only when actual callers need it;
  a few duplicated lines do not require a framework or `common.sh`.
- Document required arguments/environment, defaults, dependencies, root-directory
  assumptions, outputs, and exit status. Validate identities and paths before
  external work. Quote arguments or use arrays; preserve the intended input
  revision instead of substituting a mutable branch or driver revision.
- Bash commands use `set -euo pipefail`. Set `shell: bash` in container steps using
  Bash. Sourced helpers expose narrowly named functions and return failures;
  avoid hidden command execution or changes to the caller's directory or traps.
- Keep machine-readable stdout separate from stderr diagnostics. Write GitHub
  outputs through the existing output-file contract and preserve failures through
  wrappers, pipelines, and background work. Follow [Fallbacks](fallback.md) for
  legitimate recovery.
- Own temporary files, child processes, and locks through success, failure, and
  cancellation. Register cleanup before fallible work, await or retire owned
  children, and preserve the original status and other callers' outputs. Keep
  shared lock-file identity stable.
- Bound retries and deadlines. Retry only safe transient operations; a lost
  response may follow a completed operation, so recover its identity before
  replaying it. Keep credentials out of arguments, process metadata, and raw
  diagnostics; use existing authorization and redaction boundaries.
- Stage and verify artifacts before atomic publication. Preserve source/byte
  identity, publish-last readiness, architecture, signing, and rollback contracts.
  Keep distinct artifact phases and their actual trust boundaries explicit.

## Cloudflare SSH Diagnostics

The SSH tunnel setup records `-v` (`DEBUG1`) output from the shared SSH master and its
proxy stderr in files restricted to the job user. Initial master logs remain at
`$RUNNER_TEMP/cloudflare-ssh-master-<target-key>.stderr`; recovered masters use
`<control-path>.stderr`. Retain these files while the detached masters are alive.
Command-channel probes also run with `-v`; keep their restricted stderr files
at the same append-only master log path because `ControlMaster auto` can start a
master during a probe. This preserves its diagnostics across later callers that
reuse that master. Classify probe failures using only that probe's appended bytes,
then discard the temporary snapshot.
Verbose output from a multiplexed caller alone cannot explain the master's
connection failure.

Preconnection, probes and actual guarded callers pass the selected master's
`<master-log>.proxies` namespace to any proxy they create. Each proxy owns a
unique `proxy.*` directory containing `events.log`, `stderr.log`, `tcp.log` and native
`application/cloudflared*.log` files. Directories are private (0700); an inherited
077 umask restricts files, including native rotations. The setup action installs
the proxy's diagnostic helper and Python renderer together. Raw managed evidence
remains local for the job lifetime, including after a proxy exits 0. Standalone
proxies remove their own temporary directory on exit. Outside an ephemeral CI
job, the preconnection owner must remove its namespace after retiring all masters.

The access client runs with native `--log-level debug --log-directory` logging.
In stdin/stdout proxy mode its application logger does not write to stderr, and
an established stream failure can still return 0. Neither empty stderr nor that
status proves a successful SSH operation. Native application logs retain copy
direction and WebSocket close/error details without enabling payload logging.
The native logger rotates at 1 MB with five backups. Lifecycle records identify
the proxy instance, proxy/parent/child PIDs, observed/forwarded signals, child
status and proxy status. UTC/epoch times are recorded at the event; Linux uptime
provides a local monotonic reference when available. GitHub's later dump time is
not the original event time of timestamp-free SSH lines.

The wrapper keeps an in-memory history of probe, recovery, selection and caller
milestones. Failure output joins these source UTC/epoch/uptime observations by
call and selected-master identity, with elapsed centiseconds from Linux uptime.
Recovery observations identify the replacement master. The rootfs process-test
upload explicitly requests native SCP `-v` diagnostics; generic wrapper arguments
and verbosity remain owned by their callers.

Each proxy owns a Python standard-library TCP observer for its cloudflared child.
Once per second it joins that PID's procfs socket inodes and process start time
to Linux inet-diag/TCP_INFO observations, rechecking ownership before publication.
It samples endpoints, numeric TCP state, queues, RTT, retransmission timeout,
retransmissions, time since last sent/received data, and
kernel-length-available byte/window counters. These are kernel TCP observations,
not SFTP progress or application-level stream byte counts. Reads inspect at most
1,024 descriptors/four socket inodes and 1 MiB of kernel responses per round,
with a half-second query deadline. The private snapshot atomically retains at
most 16 records; the proxy terminates and reaps its observer on exit or handled
cancellation. Observer stdin/stdout/stderr cannot keep the SSH stream open.

Sample timestamps identify collection start, bounded by that query window.
Permission/unsupported/partial observations include an unavailable record;
already observed sockets survive a later dump failure. Missing counters are not
zero counters, and no observed socket does not establish why one disappeared.
Short-lived sockets or final state can be missed between samples. TCP resets,
retransmissions and queues alone cannot identify the responsible network hop.
The observer performs no payload reads, external connections or remote probes.

When a guarded SSH, SCP, or SFTP operation fails, its wrapper prints the target,
original exit status, run/attempt/call/master context, source-timed phases and
folded, sanitized proxy/master evidence. The renderer is limited to 384 lines and
64 KiB. Reads are capped at 64 KiB per file; the collector considers four recent
proxy instances and two native log files per
instance, with explicit truncation/unavailable markers. Each instance reserves
2 KiB for lifecycle, 4 KiB for native application, 4 KiB for TCP, and 1 KiB for
proxy stderr; SSH master stderr reserves another 12 KiB. Per-source line limits
and these byte quotas keep one noisy source from erasing another category.
Different instances are shown separately, not automatically declared the cause of
an operation. A missing
final lifecycle event means no final status was observed in that snapshot; it
does not prove whether the process remains alive or was killed. Preconnection
failure/retry reports and probe failures also include the selected master's
evidence. Successful wrappers keep the added phase/observer report out of their
output; explicitly requested native caller verbosity remains effective.
Reads preserve caller stdout/status and never
reconnect, replay a caller, or close a live master to flush logs.
The operation deadline's native `timeout --verbose` message records when it
actually forwards a termination signal. The wrapper records handled HUP/INT/TERM
with source time before cancellation cleanup, then takes a local evidence
snapshot; status 124/137 alone is not used to invent a deadline or OOM diagnosis.

The renderer requires Python 3's standard library and fails closed if optional
diagnostics cannot be rendered. It removes native request/header dumps, omits
malformed structured records, allowlists native event fields and numeric/IP TCP
metadata, and redacts authentication headers, cookies, token query parameters
and legacy secret forms.
Native SSH `Sending command` payloads are omitted, and R2 credential assignments
are redacted even when GitHub has not registered those values for masking.
Native `originURL` contributes only a validated hostname, without userinfo,
path or query. The pinned access client does not log successful service-token
handshake response metadata or normal stream EOF/byte outcomes through another
verbosity flag. These client diagnostics use the existing job console and add
no artifact upload or durable store.
Do not print/upload raw native DEBUG logs: they contain authentication headers.
Keep SSH at `DEBUG1`; do not enable packet-level or `--debug-stream` payload logs.

### Correlating Origin Events

Client close codes identify a termination boundary, not its underlying network
hop. For a failed operation, preserve its run/attempt, target, original UTC window,
proxy instance/PIDs and native error. Expand the query window for measured clock
uncertainty. A later successful operation does not explain the earlier failure.

Through an independent authorized log path, or a separate explicit investigation
after access returns, verify the origin's deployed tunnel version, actual SSH and
tunnel service names, journal retention and clock synchronization first. Do not
add another SSH connection to the failed-caller wrapper. For confirmed units,
read retained events for the original window, for example:

```bash
journalctl --utc --since "$incident_start" --until "$incident_end" --output=json \
  -u "$origin_tunnel_unit" -u "$origin_ssh_unit"
journalctl --utc --since "$incident_start" --until "$incident_end" --output=json -k
```

Preserve source timestamps, host/boot ID and process/session identity. Look for
tunnel stream/connection errors, service restarts, SSH session termination, and
matching kernel/cgroup OOM or kill events. Exit 137 alone does not prove OOM.
Apply the same credential publication boundary before sharing origin DEBUG logs.
For public-hostname WebSocket SSH, origin request logs may expose `cfRay`,
`connIndex` and `originService`; verify the deployed path instead of assuming
private-network `flowID` or session-log fields apply. The stock access client does
not expose its handshake response CF-Ray, so host/time matching may remain
ambiguous when jobs share a host. A missing journal or a close-1006/EOF event alone
must remain an explicit evidence gap. Live `cloudflared tail`, current tunnel
health, metrics and later diagnostic snapshots cannot reconstruct missing history
or establish a particular failed stream's cause.

## Tests

Add or retain a test only when it catches a concrete independent regression that
existing coverage or static checks would miss. Simple wrappers and static
configuration often need only existing syntax, lint, policy, and consumer checks.
A test script does not automatically need another test.

Useful infrastructure coverage proves outcomes such as a child failure reaching
CI, selected tests running without omission or duplication, lost responses not
replaying work, resources being released, or invalid artifacts being rejected.
Exercise the actual command/native boundary with real internal code and isolated
resources; control external dependencies using the owning suite's fixtures.

Remove repeated happy paths, copied configuration/version/hash tables, incidental
step-name or command-spelling assertions, private helper-call assertions, and
shell/framework behavior tests. Do not extract code by comments, copy private
functions, rewrite source to arrange a case, or add a product API solely to save a
test. In mixed suites, keep independently valuable cases and remove unused support.

A policy checker may inspect workflow data to enforce a real rule, such as
rejecting an unapproved action. Its rejection fixtures can be meaningful;
copying the whole current workflow into an expected snapshot does not prove that
rule. Apply [Coverage](testing.md#coverage) at the actual caller's boundary.

## Verification and Changes

Run the relevant formatter, lint, and focused behavior checks. Discover owned
shell files recursively, including retained tests and nested helpers, and run
`bash -n` once per file. Documentation needs formatting, links/anchors, and its
actual readers; avoid unrelated suites. Follow
[project verification](../CLAUDE.md#development-and-verification).

Update callers, documentation, bundled copies, source/build-input hashes,
changed-path selectors, test registrations, and required gates when changing a
shared script or path. Selected failures, cancellations, unexpected skips, and
selector failures must still block; an unselected job needs an explicit
applicability decision.

Before retiring a command, check direct, transitive, dynamic, documented, and
supported manual callers. Delete confirmed-unused code and support together;
keep adapters only for active compatibility callers. Record lost/retained
coverage and evidence in the issue or PR, following the
[documentation boundary](docs.md#documentation-boundary). Source size or test
counts alone do not establish runtime or resource savings.
