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
until job cleanup because `ControlMaster auto` can start a master during a probe.
Verbose output from a multiplexed caller alone cannot explain the master's
connection failure.

When a guarded SSH, SCP, or SFTP operation fails, its wrapper prints the target,
original exit status, UTC start/end times, and a folded, redacted master/probe tail
limited to a combined 100 lines and 64 KiB. Probe failures also include the selected master's
log. Successful operations keep diagnostics out of their output. These diagnostic
reads preserve caller stdout and status and do not reconnect or replay the caller.
Keep raw logs local; apply the existing credential redaction before exposing them.
Use `DEBUG1` for routine collection to avoid packet-level logging during transfers.

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
