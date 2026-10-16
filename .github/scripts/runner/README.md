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
| Binary reuse, GitHub lookup, bounded downloads and R2 transport  | `runner-binary-cache-plan.sh`, `runner-binary-cache.sh`, `runner-binary-github.sh`, `runner-binary-download.sh`, `runner-binary-transport.sh`                           |
| Guest inventory and architecture selection                       | `runner-guest-binaries.sh`, `runner-image-target.sh`, `runner-host-architecture-groups.sh`                                                                              |
| Image planning, preparation, manifests and readiness             | `runner-image-context.sh`, `runner-image-architecture.sh`, `prepare-runner-image.sh`, `runner-image-manifest.sh`, `wait-runner-image.sh`, `wait-runner-image-groups.sh` |
| Group reconciliation and startup                                 | `reconcile-runner-binary-groups.sh`, `reconcile-and-start-runner-groups.sh`                                                                                             |
| Lifecycle ownership and cleanup                                  | `with-runner-lifecycle-lock.sh`, `cleanup-pr-runner-namespace.sh`, `discover-runner-pr-namespaces.sh`, `prune-runner-idle.sh`                                           |
| Native test binary build and artifact transport                  | `runner-native-test-artifact.sh`                                                                                                                                        |
| Private CLI input discovery for host E2E                         | `resolve-runner-cli-artifact.sh`                                                                                                                                        |
| Cloudflare SSH setup, probes, guarded operations and diagnostics | `cloudflare-ssh-proxy.sh`, `cloudflare-ssh-preconnect.sh`, `cloudflare-ssh-command.sh`, `cloudflare-ssh-diagnostics.sh`                                                 |

The target, guest inventory, binary download/GitHub and SSH diagnostic files expose
sourced helpers. Commands document arguments and required environment in their
usage or validation; workflows supply captured revisions, architecture, host and
artifact identity. Git, Bash, jq and the selected command's Cargo, AWS CLI, zstd,
SSH or Ansible dependencies must be available. Preserve structured stdout and
GitHub output-file contracts, stderr diagnostics and original failure statuses.

Build inventory includes the complete `runner-binary-build/` module and production
crate inputs by committed Git mode, path and blob identity. Materialized commands
must use those same paths. The SSH action exports this owner directory for recovery
helpers; guarded SSH/SCP/SFTP operations remain single-shot. Lifecycle commands
retain shared lock identities and cancellation/cleanup ownership.

Run the retained affected suites in `../tests/` through their shell entry points.
The shard manifest registers those suites; native/image execution remains in the
PR pipeline. Follow the [GitHub scripts standard](../../../docs/github-scripts.md)
when changing callers, copied tools, hashed inputs, selectors or command contracts.
