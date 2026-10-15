# Runner operations

Use this guide for host-local configuration and effective-value checks. The
[host configuration guide](../../docs/runner/runner-host-configuration.md) owns
the shared parsing, resource-budget, failure and rollback contracts. Read it
before changing host tuning or promotion behavior.

For control-plane URL and authentication options, use `runner config --help`
and `runner start --help`.

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
