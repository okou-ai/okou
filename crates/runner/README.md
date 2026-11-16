# Runner operations

Use this guide for host-local configuration and effective-value checks. The
[host configuration guide](../../docs/runner/runner-host-configuration.md) owns
the shared parsing, resource-budget, failure and rollback contracts. Read it
before changing host tuning or promotion behavior.

For control-plane URL and authentication options, use `runner config --help`
and `runner start --help`.

## Execution transports

Official remote Runners receive complete execution publications through direct
HTTP dispatch. Ably carries cancellation, active input, connector sync and
SSH/VNC control messages.

Remote execution requires an official Runner configuration. Independent
`runner start --local` submissions use the local filesystem queue, acceptance
and executor.

## Direct Run Intake

Official Runner ingress uses Caddy on HTTPS 443 and the process-owned
`/var/lib/vm0-runner/ingress/<runnerId>.sock`. Both health and dispatch require
the existing official service Bearer credential and canonical host. Control
and reserved sandbox routes share the socket, with disjoint namespaces.

Send complete execution inputs to
`POST /runners/<runnerId>/control/runs/<runId>/dispatch` as `application/json`.
The envelope contains `runnerId`, `heartbeatGeneration`, `profile`, `notAfter`
(Unix milliseconds), and `executionContext`. The latter is the existing complete
API execution publication, including `runId` and `contentBundles`; it is
normalized by the same input validator used by the current API provider.
Initial receipt must be before `notAfter` and at most 60 seconds ahead of the
receiver's clock. The body limit is 4 MiB, with five seconds to read it.
This is an explicit intake limit, not a bound inferred from the existing
publication schema. The sender must check the final encoded size and fail an
oversized API-admitted Run through its ordinary terminal lifecycle.

Responses contain the exact `runnerId`, `heartbeatGeneration`, `runId`, and
`disposition`. HTTP 200 carries `accepted`, `rejected`, `pending`, `unknown`, or
`conflict`. Acceptance transfers custody to the retained execution lifecycle;
later activation/execution failure uses ordinary Run completion. Rejection
releases local reservations and cannot later become acceptance for that input.
Pending/unknown/conflict never prove an earlier attempt was rejected.

Four preparation transactions are shared by direct intake and local filesystem work. These slots
release at executor handoff rather than Run completion. When full, intake returns
HTTP 429 and `busy` immediately, before reading the body. The sender owns waiting
and bounded same-process retries for a preferred Runner. No fixed `Retry-After`
hint is sent; an initial jittered 100–200 ms backoff, increasing under sustained
pressure within the sender's invocation budget, is the initial policy to validate
against actual busy/retry outcomes. This attempt acquired no custody; the response
says nothing about earlier attempts. A possibly accepted earlier attempt must
remain pinned to that owner even if a retry gets 429.

Retry an existing request with identical bytes, including its original deadline.
Within that window, identical delivery shares its recorded verdict and changed
input returns conflict. At or after the original deadline, retries return unknown,
including formerly accepted or rejected input. Expired records are reclaimed
periodically; cumulative traffic does not impose a process-lifetime intake limit.
Existing Run registration guards execution independently of this short history.
The sender must never renew a Run's deadline or reopen completed work. Once the
window closes, stop resending and reconcile ordinary Run status, completion or
timeout against the pinned owner. A new process or generation cannot settle the
previous process's custody: generation mismatch, expired history, connection loss
or a missing route never authorizes blind reassignment.
Caller disconnect and Caddy restart do not cancel accepted execution.

## Configure Host I/O Capacity

Host-local overrides live in `/etc/vm0-runner/host.env`. The file is parsed by
Runner, not sourced by a shell. Follow the canonical
[file format](../../docs/runner/runner-host-configuration.md#file-format) and
[accepted keys](../../docs/runner/runner-host-configuration.md#canonical-host-tuning-contract).

The concurrency override is optional. The four I/O keys are one atomic
configuration: either omit all four or provide all four. Measure sustainable
aggregate capacity for the actual host; these example values are illustrative:

```text
# Optional host-local concurrency override
OKOU_RUNNER_CONCURRENCY_FACTOR = 1.5

# Example sustainable aggregate host capacity; measure values for this host.
OKOU_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC=2000
OKOU_RUNNER_DISK_IOPS=200000
OKOU_RUNNER_NET_RX_MIB_PER_SEC=1250
OKOU_RUNNER_NET_TX_MIB_PER_SEC=1000
```

Use host totals rather than desired per-sandbox rates. Runner applies the
[host reserve and admission denominator](../../docs/runner/runner-host-configuration.md#how-the-runner-derives-limits)
before assigning each sandbox's limits.

Apply file changes through the normal Runner drain and restart workflow. A
running process does not reload this file. Respect the existing
[rollback floor and promotion contract](../../docs/runner/runner-host-configuration.md#rollback-floor-and-promotion);
normal promotion does not mutate `host.env`.

## Verify The Effective Configuration

After applying the file through the normal restart workflow, inspect the Runner
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
the per-drive split. For parsing errors, partial configurations and insufficient
capacity, use the canonical
[failure behavior](../../docs/runner/runner-host-configuration.md#failure-behavior)
to interpret the result.
