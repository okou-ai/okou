# Repository and CI Checks

This directory owns repository policy validators and the event/security adapters
that feed them. Regression fixtures stay in `../tests/`. Follow the shared
[GitHub scripts standard](../../../docs/github-scripts.md) when changing either.

All files here are **executable commands**, not sourced helpers. Invoke shell
commands directly or with their specified shell, and Python commands with
`python3`. Preserve each child's exit status. `run-semgrep.sh` uses POSIX `sh`;
the other shell commands use Bash. No helper changes the caller's shell state.

## Invocation Contracts

Run repository checks from the repository root unless the table says otherwise.
Git-based commands need the checked-out revision and relevant ancestors locally
available; a shallow checkout that omits a required commit is not an exemption.
Dependencies below are in addition to the named shell/Python and normal Unix
utilities.

| Command                                      | Inputs and dependencies                                                                                                                                                                                                                                | Output and exit behavior                                                                                                                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check-action-pins.py`                       | One repository-root argument; `yq`. Reads workflows and recursively finds composite actions under that root, independently of the current directory.                                                                                                   | Success summary on stdout, violations on stderr; 0 for approved references, 1 for rejection or invalid usage. Missing workflows, malformed YAML, unapproved actions/subpaths and incorrect/full-SHA violations fail. The allowlist in this command is the policy owner. |
| `resolve-pr-title.sh`                        | `EVENT_NAME`; PR events require `PR_NUMBER`, queue events require `MQ_HEAD_REF`; `REPO` and authenticated `gh` for either. No repository-root assumption.                                                                                              | Current API title on stdout; empty output and 0 for events without a PR. Missing PR identity, failed API reads and empty resolved titles fail with stderr diagnostics. Re-runs read the current title.                                                                  |
| `check-pr-title.sh`                          | Exactly one title argument; no repository-root assumption. `GITHUB_ACTIONS=true` selects annotation output.                                                                                                                                            | 0 and a stdout summary for a valid conventional title; 1 for policy rejection, 2 for usage. Errors use stderr locally and GitHub annotations on stdout in Actions.                                                                                                      |
| `check-workflow-shell-compatibility.sh`      | Optional workflow paths; defaults to `.github/workflows/*.yml`/`*.yaml` relative to the current directory. Requires `yq`, `jq`, `shellcheck`.                                                                                                          | Checks effective `sh` container steps against Bash/POSIX syntax. Silent success, 1 with stderr findings, 2 for missing tools/files; parser/tool failures propagate. Explicit paths permit invocation outside the root.                                                  |
| `check-db-boundary.sh`                       | Git repository, `jq`, current package manifests and tracked source. Resolves the repository root from the current directory.                                                                                                                           | Stdout success or GitHub error annotations/import matches; 0 when DB ownership holds, 1 on a violation.                                                                                                                                                                 |
| `check-release-please-workspace-coverage.sh` | Git repository; release config/manifest/exclusions, pnpm workspace and Cargo manifests/lockfile. Requires `cargo`, `jq`, `python3`, `realpath`, `sort`, `yq`; invokes its sibling cycle checker. Resolves the root.                                    | Coverage/cycle summaries on stdout; 1 with stderr diagnostics for invalid, unclassified, mismatched or cyclic workspace inputs. Temporary files are cleaned on exit.                                                                                                    |
| `check-rust-workspace-cycles.py`             | Cargo metadata v1 JSON on stdin, from `cargo metadata --locked --no-deps --format-version 1`. No repository-root assumption; the current directory affects diagnostic relative paths only.                                                             | 0 with a crate/edge summary; 1 with stderr details for malformed metadata or a declared local dependency cycle. Includes dev/build/optional/platform declarations.                                                                                                      |
| `check-release-please-component-releases.sh` | Three commit arguments: merge-group base, merge-group head, release-PR head. Requires Git history, `jq`, and `cargo` when Rust components participate. Resolves the root and checks out no revision itself.                                            | Stdout coverage summaries; 1 with stderr/annotations for invalid identities, inconsistent manifests/graphs or missing releases. When source changed, checked-out HEAD must equal the supplied group head.                                                               |
| `check-pr-ci-capacity.sh`                    | `EVENT_NAME`; PR events require `GITHUB_REPOSITORY`, `PR_NUMBER`, `GITHUB_RUN_ID`, `CI_MAX_OPEN_PRS`, `CI_MAX_OPEN_PRS_PER_AUTHOR`, authenticated `gh` and `jq`. Optional `CI_PR_ADMISSION_BYPASS_LIST` and `GITHUB_STEP_SUMMARY`. No root assumption. | Stdout policy/count/admission diagnostics and optional step-summary file. Non-PR events exit 0; invalid config/API state or exceeded admission limits fail. Reads are bounded; required CI remains required for bypass-listed PRs.                                      |
| `changed-base-ref.sh`                        | Git checkout; `EVENT_NAME`/`GITHUB_EVENT_NAME`, `CHECKOUT_REF`/`GITHUB_REF`. PR direct-head mode requires `PULL_REQUEST_BASE_SHA`; queue mode requires `MERGE_GROUP_BASE_SHA` matching HEAD's parent.                                                  | Base revision on stdout, diagnostics on stderr. PR merge checkouts use their first parent; direct heads use merge-base; other events print `HEAD^`. Missing/mismatched identities exit 2; Git failures propagate.                                                       |
| `detect-native-only.sh`                      | Git checkout and required `EVENT_NAME`; PR inputs follow the sibling base selector, queue events require `MERGE_GROUP_BASE_SHA`. Resolves the root.                                                                                                    | Two stdout `key=value` lines: `ios-only` and `turbo-ts-checks-needed`, ready for the caller's GitHub output file. Unsupported events or invalid/non-ancestor bases fail. Push and empty changes keep checks applicable; moves examine both paths.                       |
| `run-semgrep.sh`                             | Run with `sh` from the checked-out root; `semgrep`, Git and required `EVENT_NAME`. PR mode needs HEAD's first parent; queue mode requires `MERGE_GROUP_BASE_SHA`.                                                                                      | Announces mode on stdout, writes `semgrep-results.json` and `semgrep-results.sarif` in the current directory, then propagates Semgrep's status via `exec`. Unsupported events exit 2; missing inputs/Git failures fail.                                                 |
| `semgrep-results.py`                         | `check <diff\|full> <baseline.json> <results.json>` or `filter <diff\|full> <baseline.json> <input.sarif> <output.sarif>`. Paths are caller-supplied; no root assumption.                                                                              | Check summaries on stdout, 1 for new findings/regression, 0 when policy passes. Filter writes its output file and stdout summary. Invalid arguments or unreadable/malformed inputs fail; diff mode admits no baseline allowance.                                        |

Examples from the repository root:

```bash
python3 .github/scripts/checks/check-action-pins.py .
.github/scripts/checks/check-pr-title.sh 'refactor(ci): organize policy checks'
.github/scripts/checks/check-workflow-shell-compatibility.sh
.github/scripts/checks/check-release-please-workspace-coverage.sh
cargo metadata --locked --no-deps --format-version 1 --manifest-path crates/Cargo.toml |
  python3 .github/scripts/checks/check-rust-workspace-cycles.py
```

Workflows own permissions, applicability and required gates. These commands do
not publish a passing check to replace a failed child. Changes to paths must
update all workflow/manual callers, fixture copies, lint/shard registrations,
changed-path selectors and source-input hashes together. In particular, the
shared base selector is an input to iOS selection/archive identity and Crates
native selection, not just a command in a workflow.

Run the existing affected fixtures in `../tests/` and the consumers' own checks;
validate their shard manifest with
`../run-workflow-script-test-shard.sh --validate-only`. Add coverage only for an
independent observable guarantee.
