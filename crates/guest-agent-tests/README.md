# Guest-agent test owner

This private workspace package owns isolated guest-agent integration executables
that do not require guest-agent's binary, version or source-manifest bindings.
Its Cargo library root explicitly points to the canonical
[`guest-agent/tests/common/mod.rs`](../guest-agent/tests/common/mod.rs), which the
retained original-package tests also use. There is one fixture implementation;
guest-agent has no dependency on this test-only package.

Run both packages for complete guest-agent coverage. The
[integration testing guide](../guest-agent/tests/README.md) documents the commands,
domain layout, ordinary Cargo isolation and guarded-child requirements. The
default workspace coverage command includes both packages.
