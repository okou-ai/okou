# Reused Runner storage preparation

## Boundary

Only an already-running, claimed sandbox overlaps Runner-to-Guest storage staging
with proxy registration. Both owners are joined before handoff, including on
failure or cancellation. Once a Guest write is admitted, its bounded RPC finishes
before the sandbox can be returned. Registration failures retain precedence over
staging failures.

Guest archive application, Guest network downloads, model-catalog prefetch and
Agent process startup remain behind successful proxy registration. Fresh sandbox
ordering is unchanged: register proxy, start VM, then stage/apply storage.

The populated result belongs to one prepared plan and sandbox and is consumed
once by Guest apply. It is not a cross-Run cache or a new permission to reuse
files. Retirement/replacement drains and discards the old prepared plan.

## Existing reuse, not a second cache

Existing storage-name/version fingerprints already skip ordinary storage.
Artifacts remain mutable: exact-source reuse must preserve legitimate workspace
modifications and repair missing roots. Instructions keep their existing
normalization behavior. This change does not weaken fingerprint, archive-size,
hash, mode, manifest or decoded-delivery bounds, introduce additional skip
heuristics, or overwrite mutable artifacts to manufacture a cache hit.

Moving population earlier must not cause its later consumer to write the same
bytes again. The prepared population result prevents that duplicate; this is not
claimed as a new before/after saving over the original serial implementation,
which also populated only once. Further immutable-content reuse is deliberately
not added without evidence of a safe, material remaining cost.

## Comparable telemetry

- `runner_reused_sandbox_prepare` retains its existing planning-to-registration
  interval and registration outcome. Its completion timestamp is captured when
  registration actually finishes, not after its sibling is joined.
- `runner_reused_sandbox_proxy_register` measures registration alone.
- `runner_reused_storage_staging` measures the early runtime-state/staging branch.
- `runner_reused_sandbox_storage_proxy_prepare` measures the concurrent wall-time
  parent. Do not sum its children to estimate claim-to-spawn savings.
- `runner_storage_manifest_cache_populate` still measures population once.
- `runner_storage_manifest_apply` retains serial-equivalent storage work time by
  adding early population elapsed time to subsequent application work. After
  overlap it is **not** one contiguous wall-clock interval; do not reconstruct
  its start from its end and duration. Use the new overlap parent and actual
  claim/spawn milestones for critical-path comparison.

Before/after samples must pin source and deployed Runner group, distinguish
exact reuse/blank reuse from actual fresh creation, use a fixed finite telemetry
window, and retain failures/missing milestones as such. New threads alone do not
prove fresh VM creation. Small or unproven savings are reported, not rounded up
to the earlier engineering estimate.

## Release compatibility

The base is `0b73927f3157dd385a24a1af2c4a61e1f0680cbc`. This is Runner-only
scheduling/state ownership: no Guest RPC, manifest, write-files, fingerprint or
CLI contract changes. Existing Guest/CLI versions remain compatible.

`release-please-config.json` uses `cargo-workspace` to update Rust dependencies
and their dependent Runner versions. Its explicit CLI-to-Runner release rule is
one-way; this change does not require an unrelated CLI or Guest version bump.
Do not manually edit release manifests or version pins.

Production release still uses the canonical CLI artifact's release versions and
verified bytes. `publish-okou-cli-versioned-artifact.sh` rejects different bytes
at an existing CLI version; `build-runner-release-assets` consumes the validated
canonical input. This PR neither bypasses those checks nor publishes a release.
Preview deployment/compatibility validation is distinct from a completed
production release.

## Verification

Production `execute_job_reuse` / `execute_job` entrypoint regressions cover
staging while registration is blocked, no premature Guest apply/process, single
staging with unchanged content/version/mount, staging failure cleanup, joint
failure precedence and ownership, cancellation, and fresh start ordering.
External Sandbox RPCs are mocked in these deterministic tests; they are not
native VM latency evidence.

Local base: 138 sandbox-entrypoint tests pass (512 other tests filtered).
Changed executor: 655 library tests pass. Targeted Runner storage/executor Clippy
passes with the CI feature set (`--all-targets --all-features`); formatting and
`git diff --check` pass. An extra non-CI `-D warnings` check without all features
reported existing warnings in test-fixture modules and is not counted as passing.

Native preview before/after measurements and CI are pending. No claim-to-spawn
improvement, small-cost threshold result, or production-release success is
claimed from the local deterministic tests.
