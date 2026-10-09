# Engineering Documentation Index

`docs/` contains reusable engineering standards, framework guidance, and shared
infrastructure contracts. Read the guidance relevant to the changed surface;
this index does not replace its detailed rules.

## Documentation Boundary

- Keep code quality, React/ccstate, styles, testing, database, deployment, and
  shared runtime rules here.
- Do not add business-feature descriptions, issue implementation plans, batch
  manifests, rollout diaries, acceptance receipts, or measurement snapshots.
  Record task-specific decisions and evidence in the owning GitHub issue or PR.
- Executable behavior belongs in code, contracts, schemas, and tests. Keep
  component setup and operational instructions next to their owning component.
- Update an existing standard when a reusable rule changes; do not create a new
  document for each implementation increment.
- Historical documents remain recoverable in Git history. Their removal from
  this index does not authorize removing runtime compatibility, rollback floors,
  security checks, data, tests, or migration history.

## Code Quality and Architecture

- [Bad code smells](bad-smell.md): production-code quality boundaries.
- [Fallbacks](fallback.md): legitimate exceptions, declarations, and removal gates.
- [Event sourcing](event-sourcing.md): persistent and optimistic event ownership.
- [Externally managed references](externally-managed-references.md): reference
  authority, dependency failures, and fail-closed resolution.
- [Deployment compatibility](deployment-compatibility.md): independent releases,
  persisted state, schema transitions, drain, and rollback requirements.
- [API ccstate](api-ccstate.md): derived reads, explicit writes, graph construction,
  database ownership, cancellation, and entry-owned orchestration.
- [Database development](../.claude/skills/database-development/SKILL.md): migration
  workflows, transaction boundaries, decoding, and SQL construction.
- [Advisory-lock retirement](advisory-locks.md) and
  [transaction and recovery constraints](advisory-lock-terminal-state.md).
- [Signal-owner file limits](eslint/max-signal-owner-lines.md) and
  [database trigger policy](eslint/no-database-trigger.md).
- [Database transaction lint](eslint/no-db-transaction.md): default prohibition,
  deletion-only legacy call-site inventory, and necessary billing waivers.

## React and Platform

- [ccstate](../.claude/skills/ccstate/SKILL.md): reactive, command, lifecycle, and
  HTTP guidance.
- [Effects](effect.md): derived values, semantic commands, DOM lifecycles, and
  render purity.
- [Cache and lifecycle](cache.md): ownership, retention, refs, and teardown.
- [Styles](styles.md): shared tokens, semantic HTML, and component composition.
- [ResizeObserver](resize-observer.md): CSS layout and measurement ownership.
- [Chat-card UI contracts](chat-cards.md): stable frames, portable action links,
  signal registration, and lifecycle ownership, not a feature catalog.
- [React measurements](react-commit.md): reproducible commit attribution and
  behavior verification, not historical benchmark results.
- [Platform lint](platform-lint.md): transport, lifecycle, and import boundaries.
- [Clerk customization](clerk-customize.md): public styling ownership and enforcement.

## Testing

Start with [Testing](testing.md), then select the affected surface:

- [Patterns](testing/patterns.md) and [anti-patterns](testing/anti-patterns.md).
- [External behavior](testing/testing-external-behavior.md).
- [API](testing/api-testing.md) and [Platform](testing/app-testing.md).
- [CLI](testing/cli-testing.md) and [CLI/Runner E2E](testing/cli-e2e-testing.md).
- [Desktop](testing/desktop-testing.md).
- [Rust](testing/rust-testing.md).
- [MITM addon](testing/mitm-addon-testing.md).

## Shared Runtime Infrastructure

- [Guest process lifecycle](runner-guest-process-lifecycle.md): containment,
  process ownership, reuse, and operation lifetime.
- [Runner host configuration](runner-host-configuration.md): validated host-local
  capacity and configuration ownership.
- [Guest memory policy](runner-memory-policy.md): workload sharing and reclaim protection.
- [Runner architectures](runner-multi-architecture.md): artifact pairing, build,
  deployment, and architecture selection.
- [Runner reactor progress](runner-reactor-progress.md): independently scheduled
  work, shared-resource progress, cancellation, and shutdown.
- [Guest/Runner transport](runner-rpc-transport.md): control versus RPC placement,
  bounded framing, exact-assignment authority, and resource lifetime.
- [MITM addon contracts](mitm-addon-contracts.md): credential boundaries, framing,
  logging, and bounded protocol inspection.
