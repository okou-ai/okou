# Artifact tools

These commands build or consume immutable CLI, App and Desktop artifacts. Run
them from the repository root; each command documents its arguments through its
usage output. Keep the phases separate from [release promotion](../release/).

| Phase  | Commands                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------ |
| Build  | `build-okou-cli-artifact.sh`, `build-okou-desktop-artifact.sh`                                         |
| Fetch  | `fetch-okou-app-artifact.sh`, `fetch-okou-desktop-artifact.sh`                                         |
| Verify | `verify-okou-app-artifact.sh`, `verify-okou-cli-artifact.sh`, `verify-okou-desktop-artifact.sh`        |
| Smoke  | `smoke-okou-cli-artifact.sh`, with `smoke-installed-okou-cli.sh` and `smoke-okou-cli-image-resize.mjs` |

CLI build and verification share `read-okou-cli-package-identity.py`, which reads
the bounded identity of the actual packaged bytes. Its `--verify-package` mode
also validates installation metadata and required files in the same archive pass.
Verification protects the producer/consumer boundary even when a producer
already checked its output.

The CLI build action checks the immutable source revision and builds and packs
the CLI on every invocation. Its dependency store is cached separately from
other workspaces. `build-okou-cli-artifact.sh` validates the freshly packed bytes
and writes the current commit's manifest, followed by the readiness record.
Smoke checks share one disposable npx installation; the destructive image
fallback probe runs after the other CLI checks.

The App/Desktop fetch commands source `r2-copy.sh`. They own their temporary
diagnostics and cleanup, and supply their distinct retry environment settings and
artifact layouts. The helper copies one object, retries transient failures within
that budget, and fails immediately when the object is permanently missing.

Run the retained affected suites in `../tests/` and the normal PR pipeline. Follow
the [GitHub scripts standard](../../../docs/github-scripts.md) when changing paths,
inputs, integrity checks or caller registration.
