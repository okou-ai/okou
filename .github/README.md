# CI workflow ownership

`ci.yml` owns the shared readiness DAG and required gates. It directly handles
PR/merge-group events. The existing Turbo, Crates and Runner Image entrypoints are
thin callers with an explicit main surface; Staging retains its environment lock
and explicit secret map. There is no composer, generated workflow, regeneration
command or second execution implementation.

`ci-turbo-*.yml`, `ci-crates-*.yml` and `ci-runner-image-*.yml` own execution through
`workflow_call`. Edit the actual owner of a job. Caller `needs`/conditions own
external scheduling, while local callee dependencies and steps own execution.
Inputs carry data-only direct dependency snapshots; they never contain job bodies
or instructions. Grouped terminal checks expose the reusable `jobs` result
context directly, without an extra relay runner.

Keep boundaries at actual readiness. API, app, CLI, account preparation,
bootstrap, image readiness, native compilation and cleanup are separate callers.
The two architecture image callers use the same build owner. Selected Crates
runtime callers use the same preparation/behavior/test owners but depend only on
their own architecture, not a join with an unselected caller that might still
wait for the complementary image. Ordinary checks do not wait for host discovery
or images. Assets/prewarm are never ancestors of consumers or required gates.
The existing aggregate compiler barrier remains unchanged (#38603).

PR/MQ uses the explicit `current` image handoff and exact caller run ID. Retained
separate-main callers use explicit `main`, allowed only for push/main; it is not
a fallback for invalid/missing current-run identity. Both paths retain existing
manifest identity, architecture, profile, host and byte-hash validation.

Nested caller permissions are ceilings, not an active worker grant. Main callers
allow the shared DAG's PR/MQ cancellation declaration, but the only Actions-write
worker is event-guarded owner cancellation. Every other worker explicitly uses
Actions read; no staging worker gains Actions write. Secret forwarding is named
at every boundary; do not replace it with broad inheritance.

Validation: native workflow-script shards, `actionlint`,
`check-workflow-shell-compatibility.sh`, applicable ShellCheck/Bash syntax,
workflow formatting and `git diff --check`. `ci-readiness-workflow-test.sh`
checks the actual caller graph, ownership, bounded interfaces, scheduling and
required gate behavior. No generation step is necessary.
