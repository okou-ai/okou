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
| Group reconciliation and startup                                 | `reconcile-runner-binary-groups.sh`, `reconcile-and-start-runner-groups.sh`                                                                                             |
| Lifecycle ownership and cleanup                                  | `with-runner-lifecycle-lock.sh`, `cleanup-pr-runner-namespace.sh`, `discover-runner-pr-namespaces.sh`, `prune-runner-idle.sh`                                           |
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
