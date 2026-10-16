# Artifact tools

These commands build or consume immutable CLI, App and Desktop artifacts. Run
them from the repository root; each command documents its arguments through its
usage output. Keep the phases separate from [release promotion](../release/).

| Phase  | Commands                                                                                        |
| ------ | ----------------------------------------------------------------------------------------------- |
| Build  | `build-okou-cli-artifact.sh`, `build-okou-desktop-artifact.sh`                                  |
| Fetch  | `fetch-okou-app-artifact.sh`, `fetch-okou-desktop-artifact.sh`                                  |
| Verify | `verify-okou-app-artifact.sh`, `verify-okou-cli-artifact.sh`, `verify-okou-desktop-artifact.sh` |
| Smoke  | `smoke-okou-cli-artifact.sh`, with `smoke-okou-cli-image-resize.mjs`                            |

CLI build and verification share `read-okou-cli-package-identity.py`, which reads
the bounded identity of the actual packaged bytes. Verification protects the
producer/consumer boundary even when a producer already checked its output.

`coverage-archive.py` seals and verifies the source/tool/current-run identity and
bytes of an instrumented nextest archive. Its comparison checks every discovered
test (including ignored/filter metadata and empty suites) and the fresh LCOV
source set. The separate `coverage-archive.yml` producer and consumer execute the
complete workload in separate jobs, without changing required Crates coverage
or deploying a cross-run cache. Native nextest extraction restores the original
target pathname so compiled `CARGO_BIN_EXE` and build-output paths keep working;
the consumer starts without producer targets and cleans only profile counters.
Job steps expose control, export, transfer, extraction, execution and reporting
costs; matching inventories alone do not prove a speedup.

The App/Desktop fetch commands source `r2-copy.sh`. They own their temporary
diagnostics and cleanup, and supply their distinct retry environment settings and
artifact layouts. The helper copies one object, retries transient failures within
that budget, and fails immediately when the object is permanently missing.

Run the retained affected suites in `../tests/` and the normal PR pipeline. Follow
the [GitHub scripts standard](../../../docs/github-scripts.md) when changing paths,
inputs, integrity checks or caller registration.
