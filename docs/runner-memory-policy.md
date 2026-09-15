# Guest memory sharing and reclaim protection

The [canonical policy](../crates/guest-contracts/src/process_containment.rs)
separates a workload hard limit from protection of memory already charged to
control services and the native agent runtime.

| Domain                             | `memory.min` | Purpose                                             |
| ---------------------------------- | -----------: | --------------------------------------------------- |
| Exec base and Agent operation      |      512 MiB | Carry combined descendant protection                |
| Agent operation `control`          |      128 MiB | Guest Agent control work                            |
| Agent operation `workload`         |      384 MiB | Carry runtime protection                            |
| `workload/runtime`                 |      384 MiB | Native agent runtime and its charged file pages     |
| `workload/tools` and each `tool-N` |            0 | Share remaining capacity without reclaim protection |
| Ordinary exec operation and leaves |            0 | Do not receive trusted Agent protection             |

Ancestor values describe the same descendant memory, not additional allocations.
The workload hard limit remains Guest-visible physical memory minus a separate
128 MiB reserve for new control allocations. The reserve and control protection
have different purposes even though their configured values match. Workload
`memory.high` remains `max`; there is no separate tools memory hard limit.

## Borrowing and pressure

Under [cgroup v2 memory protection](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory),
unused protection does not preallocate memory. If control uses 100 MiB and runtime
uses 200 MiB, their unused protection remains available to other work. Tools still
share the workload limit with runtime and compete with the rest of the Guest for
physical memory. More runtime/control use leaves less usable tool capacity.

Runtime protection targets the pre-OOM reclaim stage: file-page eviction and
repeated page-in can delay native model/control processing even while Guest Agent
heartbeats remain healthy. The floor protects charged usage, not selected
executable pages. Native non-shell tools may also charge runtime, and a larger
working set can exceed the floor. This is not a runtime usage cap or OOM immunity.

When unprotected reclaimable memory is exhausted, hard protection can bring OOM
forward. Managed shell tools retain `oom_score_adj=1000`; individual tool leaves
retain `memory.oom.group=1`, while aggregate tools and workload use `0`. Preferential
tool killing does not guarantee that every runtime survives. Preserve real tool
failure and subsequent session continuation rather than reporting a killed build
as successful compilation.

## Ownership and verification

Guest initialization configures and verifies the base floor. Agent operation
creation installs the control/workload/runtime protection before native execution.
Failed required setup does not run the command unprotected. Reuse preparation
rejects stale base protection along with its existing quiescence checks.

Runner and Guest binaries ship together; existing draining artifacts retain their
old policy and do not adopt another artifact's sandbox. See
[deployment compatibility](deployment-compatibility.md#runner-process-drain).

Resource-policy validation must include real native progress and compiler outcomes,
control delivery/high output, checkpoint/finalization, cancellation, cleanup and
reuse under pressure, including the minimum supported profile. Static hierarchy
checks alone do not demonstrate adequate working-set protection. This policy does
not establish the cause of independent upstream TLS failures.
