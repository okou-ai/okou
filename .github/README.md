# CI workflow ownership

`workflows/ci.yml` is the native PR/merge-group entry point for Turbo, Crates,
and Runner Image. It is generated from the jobs in `turbo.yml`, `crates.yml`,
and `runner-image.yml`; edit those modules rather than the generated file.
The modules retain the independent main/staging lifecycle.

After changing a module or readiness edge, regenerate and format the output:

```bash
ruby .github/scripts/compose-ci-workflow.rb
pnpm --dir turbo exec prettier --write ../.github/workflows/ci.yml
ruby .github/scripts/compose-ci-workflow.rb --check
```

The consistency check compares parsed workflow content, so formatting does not
invalidate it. CI also validates all dependency references and rejects cycles.

Keep readiness dependencies at the consuming job boundary. Independent checks,
native test compilation, deployment preparation, and optional binary publication
must not become ancestors of unrelated consumers. Immutable CLI/cache preparation
and compilation overlap owner cancellation; host-mutating image jobs await the
terminal-state handoff. Crates behavior lanes consume
only the selected architecture; complementary validation still gates the final
required result. Turbo consumes all configured image groups. Compiler matrix
completion remains its existing barrier, not a new whole-workflow dependency.

Native CI consumers download only the current run's published image artifact.
Separate main/staging consumers retain their existing cross-run handoff. Both
paths use the same source/target/namespace/profile/host/hash validation; artifact
existence alone is not readiness. Preserve exact required-check contexts and
runner lifecycle ownership when changing event entry points.
