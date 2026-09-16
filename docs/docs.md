# Engineering Documentation Index

Use this index to locate the repository's authoritative engineering guidance
before implementation or review. Read the documents relevant to the changed
surface; the index does not replace their detailed rules.

## Code Review

- [Bad code smells](./bad-smell.md): production-code quality rules.
- [Fallbacks to avoid](./fallback.md): fallback slop, negative tests against
  removed code, feature-switched features that need no compatibility, and the
  narrow cases where a time-boxed fallback is required.
- [Event sourcing and optimistic events](./event-sourcing.md): authoritative
  persistent events, optimistic projections, reconciliation, and failure
  semantics.
- [React effects and ccstate commands](./effect.md): choosing between computed
  values, semantic commands, route setup, DOM lifecycles, and React effects.
- [React and ccstate cache and lifecycle practices](./cache.md): render purity,
  state ownership, cache retention, refs, and resource teardown.
- [Testing](./testing.md): testing strategy, patterns, and anti-patterns.
- [Deployment compatibility](./deployment-compatibility.md): compatibility
  requirements for independently deployed components and persisted state.
- [Personal subscription run identity](./personal-subscription-run-identity.md):
  concrete account ownership, bounded disconnect retention and activation gates.
- [Subscription decryption experiment](./subscription-decryption-experiment.md):
  bounded KMS concurrency, provider-lock measurements and failure trade-offs.
- [Connector-account workflow automations](./connector-account-workflow-automation.md):
  workflow-thread account authority, exact provider ingress, lifecycle
  convergence, and persisted compatibility for account-backed triggers.
- [Externally managed references](./externally-managed-references.md): how to
  resolve identifiers whose entities are owned by another authority without
  conflating missing entities, invalid input, dependency failures, and local
  invariant violations.

## Specialized Guidance

- [Social download discovery](./social-download-discovery.md): bounded task
  listing, scoped recovery hints, pagination, and CLI/API compatibility.
- [Social errors and download recovery](./social-errors.md): stable error
  reasons, retry advice, same-task recovery, and compatible persisted errors.
- [Social discovery and service status](./social-discovery.md): offline
  capabilities, live health normalization, freshness and rollout boundaries.
- [Billing attribution foundation](./database/billing-attribution.md): immutable
  billing identity, writer inventory, bounded backfill and activation boundaries.
- [X resource observation preparation](./x-resource-observations.md): dormant
  resource protocol, shared claim storage, transient remainder and consumer gates.
- [Database trigger retirement](./database-trigger-retirement.md): explicit API
  entitlement writers, repair paths, and the serving/rollback removal gate.
- [Account telemetry and recovery erasure](./account-erasure-evidence.md):
  dated sink/copy inventory, provider capability gaps, and the parent-worker
  design in [ADR 0004](./adr/0004-account-telemetry-recovery-erasure.md).
- [Connector catalog rejections](./connector-catalog-rejections.md): safe
  validation reasons, cached rejection records, retained snapshots and recovered
  publication-order evidence.
- [Dependency override audit](./dependency-overrides.md): retained dependency
  constraints, their origins, and evidence for removing obsolete overrides.
- [Morning Brief migration state](./morning-brief-migration-state.md): the
  canonical reader for a member's existing brief, its ownership and thread
  invariants, and the boundary the `simple-morning-brief` cutover must respect.
- [Marketing privacy rollback](./marketing-privacy-choices.md): withdrawn runtime
  behavior, storage retirement, and rollout boundaries.
- [Google Cloud LLM voice routing](./google-llm-voice.md): shared Vercel workload
  identities, API configuration, Oregon-first model routing, and rollout gates.
- [Google Ads browser routing](./google-ads-browser-routing.md): verified account
  ownership, conversion actions, rollout compatibility, and historical recovery.
- [Connector inspection JSON](./connector-inspection-json.md): command output
  contracts, current versus run evidence, account identity, and next actions.
- [Social collection output](./social-collection-output.md): aggregate and
  streaming terminal records, partial failures, accounting, and continuation hints.
- [Platform lint boundaries](./platform-lint.md): current transport and lifecycle
  exceptions, polling policy, and retired configuration history.
- [Clerk customization](./clerk-customize.md): hosted Clerk styling ownership,
  public appearance boundaries, lint enforcement, and upgrade verification.
- [React commit analysis](./react-commit.md): measuring and attributing React
  work without confusing executions, scheduler events, or DOM mutations with
  commits.
- [Chat cards](./chat-cards.md): recognizing links in chat messages, creating
  thread-scoped card signals, and rendering rich interactive cards.
- [Durable Pi Sandbox consumer](./pi-deferred-sandbox-consumer.md): captured objects, demand admission, continuation readers and release proof.
- [Pi native provider preparation](./pi-native-provider-preparation.md): additive
  native readers, transport/auth ownership, accounting and activation gates.
- [Pi candidate reference accounting](./database/pi-memory-candidate-accounting.md):
  explicit API ownership, guarded trigger retirement, parent cleanup, audit
  receipts and the B rollback floor.
- [Historical session blob audit](./database/historical-session-blob-audit.md):
  complete owner census, read-only aggregate receipt, PostgreSQL validation and
  representative synthetic costs.
- [Conversation history deletion](./conversation-history-deletion.md): actual-row
  reference releases, lifecycle locks, cascade inventory and bounded SQL costs.
- [Pi runtime architecture](./pi-runtime-architecture.md): launch, SDK/session,
  memory, accounting, retained compatibility, and patch ownership boundaries.
- [Runner host configuration](./runner-host-configuration.md): configure and
  verify host-local concurrency and I/O capacity overrides.
- [Guest memory policy](./runner-memory-policy.md): shared workload capacity,
  control/runtime reclaim protection, and tool OOM trade-offs.
- [Workspace history restore telemetry](./workspace-history-restore-telemetry.md):
  local source and restored payload sizes, representation and timing semantics.
- [Guest file compression](./guest-file-compression.md): caller-owned history
  selection, bounded streaming, failure semantics and bundled compatibility.
- [Runner multi-architecture rollout](./runner-multi-architecture.md): build,
  deploy, and validate runner artifacts for supported host architectures.
- [Testing catalog](./testing/anti-patterns.md): detailed testing anti-patterns.
- [Addon runtime contracts](./mitm-addon-contracts.md): private control, logging ownership,
  WebSocket framing and handshake limits, and path normalization boundaries.
- [Chat Event Snapshot timeout diagnostics](./chat-event-snapshot-timeout-logging.md):
  expected per-head deadlines, stage diagnostics, convergence and retention
  safety, and archive-lag alerting.
