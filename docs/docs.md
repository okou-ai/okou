# Engineering Documentation Guide and Index

`docs/` contains reusable engineering standards, framework guidance, and shared
infrastructure contracts. Read the guidance relevant to the changed surface;
this index does not replace its detailed rules.

## Documentation Boundary

Keep reusable engineering principles, current framework architecture, shared
infrastructure contracts, and development practices here. Code quality,
React/ccstate, styling, testing, database policy, and deployment compatibility
belong in this directory when they guide future changes beyond one feature or
implementation task.

### Content That Belongs Elsewhere

| Do not store in `docs/`                                      | Examples                                                                                                                                                               | Authoritative home                                                                                                        |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Business-feature implementation descriptions                 | Product-option mappings, feature-specific state machines, field/endpoint inventories, UI feature catalogs, and prose that repeats code branches                        | Self-explanatory source, types, contracts, schemas, and behavior tests; task-specific decisions in the owning issue or PR |
| Implementation plans and progress records                    | Issue plans, migration steps for a particular change, batch manifests, worker handoffs, completed/remaining work, and future lint implementation plans                 | The owning GitHub issue or PR; executable migrations and scripts in their owning locations                                |
| Rollout, acceptance, and incident records                    | Per-feature release/version matrices, enablement progress, environment-specific CI or production receipts, task-specific acceptance checklists, and incident timelines | The owning issue or PR, with links to the supporting evidence                                                             |
| One-off investigations and measurement snapshots             | A single profiling trace, benchmark result, audit inventory, or diagnostic snapshot, including its CSV, JSON, image, or other attachments                              | Evidence attached or linked to the owning issue or PR                                                                     |
| Completed implementation retrospectives and retired behavior | How an old stylesheet was replaced, a finished migration narrative, retired producer details, and historical feature inventories                                       | Git history; use a clearly labeled link to a fixed revision when a remaining reference needs historical evidence          |
| Component-local setup and operations manuals                 | Installation, local configuration, and component-specific operating instructions                                                                                       | A README or operations guide next to the owning component                                                                 |

This boundary applies to every file and subdirectory under `docs/`. Moving a
task record into `docs/implementation/`, `docs/archive/`, or an attachments
directory does not make it an engineering standard. An existing task record is
not precedent for adding another one.

### Preserve Reusable Guidance

- Keep current architectural boundaries, protocol invariants, security and
  permission constraints, lifecycle ownership, and compatibility obligations.
  A shared contract can be concrete without becoming a business-feature record.
- Keep explanatory code examples, reusable verification procedures, and
  repeatable profiling or troubleshooting methods. Separate those methods from
  the measurements and acceptance results of a particular run.
- When a document mixes a reusable rule with implementation history, retain the
  rule in its owning guide and remove the task narrative. Update the existing
  topic instead of creating a document for each issue, batch, or increment.
- Historical documents remain recoverable in Git history. Removing their prose
  does not authorize removing runtime compatibility, executable rollback floors,
  security or permission checks, data, tests, or published migration history.
  Historical receipts are not proof of current deployment or acceptance state.
- When consolidating or moving guidance, preserve the rules and reusable examples
  that still apply, and update the index and actual consumers. Check relative
  links and anchors, skill/review routes, source comments, generated
  lint-documentation URLs, and test expectations that contain the old paths.

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
  ownership, cache and resource lifetimes, subscription design, and performance
  measurement.

## CLI

- [CLI testing](cli/cli-testing.md): command parsing, external mocks, and real files.
- [CLI and product E2E](cli/cli-e2e-testing.md): deployed product journeys and Runner
  E2E boundaries.

## App

- [Platform ccstate](app/platform-ccstate.md): transport, lifecycle, module state,
  and import boundaries. Read the matching shared
  [ccstate references](../.claude/skills/ccstate/SKILL.md) as needed.
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
