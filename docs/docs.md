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

## Directory Ownership

- `docs/`: cross-surface standards, Chat design, React development, and shared testing.
- `docs/app/`: browser application behavior, React/ccstate, styling,
  and application testing.
- `docs/desktop/`: native Desktop application behavior, testing, and release contracts.
- `docs/api/`: server-side ccstate, database policy and lint, and API testing.
- `docs/runner/`: host/guest infrastructure, MITM addon contracts, and native
  Rust/addon testing.
- `docs/cli/`: CLI command testing and deployed CLI/product E2E guidance.

Classify by the guidance's actual owner, not its implementation language or
current filename. The CLI E2E guide also covers journeys spanning App, API, and
Runner; its CLI location does not make those tests Runner-only. Shared testing
rules live in `docs/testing.md`; surface-specific test guides live with their
owning surface.

## Shared Standards and Testing

- [Bad code smells](bad-smell.md): production-code quality boundaries, including
  [external reference authority](bad-smell.md#externally-managed-references).
- [Fallbacks](fallback.md): legitimate exceptions, declarations, and removal gates.
- [Deployment compatibility](deployment-compatibility.md): independent releases,
  persisted state, schema transitions, drain, and rollback requirements.
- [Testing](testing.md): strategy, [external behavior](testing.md#external-behavior),
  [shared patterns](testing.md#shared-patterns), [anti-patterns](testing.md#anti-patterns),
  and routes to each affected surface.
- [Chat design](chat.md): event history, optimistic streaming, action links,
  card registration, lifecycle ownership, and stable transcript layout.
- [React development](react.md): render purity, effects and commands, signal
  ownership, subscription design, and performance measurement.

## CLI

- [CLI testing](cli/cli-testing.md): command parsing, external mocks, and real files.
- [CLI and product E2E](cli/cli-e2e-testing.md): deployed product journeys and Runner
  E2E boundaries.

## App

- [Platform ccstate](app/platform-ccstate.md): transport, lifecycle, module state,
  and import boundaries. Read the matching shared
  [ccstate references](../.claude/skills/ccstate/SKILL.md) as needed.
- [Cache and lifecycle](app/cache.md): ownership, retention, refs, and teardown.
- [Styles](app/styles.md): shared tokens, semantic HTML, component composition,
  and [Clerk customization](app/styles.md#clerk-customization).
- [ResizeObserver](app/resize-observer.md): CSS layout and measurement ownership.
- [Platform testing](app/app-testing.md): real page setup and user-visible assertions.

## Desktop

- [Desktop testing](desktop/desktop-testing.md): native application entry points,
  packaged acceptance, and release contracts.

## API

- [API ccstate](api/api-ccstate.md): derived reads, explicit writes, graph
  construction, database ownership, cancellation, and entry-owned orchestration.
- [Database guide](api/database.md): concurrency, atomic SQL, transaction
  ownership, external effects, recovery, transaction lint, and
  [trigger policy](api/database.md#database-triggers), with routes to migration
  workflows, decoding, and SQL construction.
- [API testing](api/api-testing.md): real route clients, auth, external mocks,
  persistent state, and observable HTTP contracts.

## Runner

- [Guest process lifecycle](runner/runner-guest-process-lifecycle.md): containment,
  process ownership, reuse, and operation lifetime.
- [Runner host configuration](runner/runner-host-configuration.md): validated
  host-local capacity and configuration ownership.
- [Guest memory policy](runner/runner-memory-policy.md): workload sharing and
  reclaim protection.
- [Runner architectures](runner/runner-multi-architecture.md): artifact pairing,
  build, deployment, and architecture selection.
- [Runner reactor progress](runner/runner-reactor-progress.md): independently
  scheduled work, shared-resource progress, cancellation, and shutdown.
- [Guest/Runner transport](runner/runner-rpc-transport.md): control versus RPC
  placement, bounded framing, exact-assignment authority, and resource lifetime.
- [MITM addon contracts](runner/mitm-addon-contracts.md): credential boundaries,
  framing, logging, and bounded protocol inspection.
- [Rust testing](runner/rust-testing.md): crate integration tests, Runner owner
  targets, coverage, and native verification.
- [MITM addon testing](runner/mitm-addon-testing.md): the locked Python environment,
  test boundaries, and executable addon coverage.
