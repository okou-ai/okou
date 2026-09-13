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
- [Connector-account workflow automations](./connector-account-workflow-automation.md):
  workflow-thread account authority, exact provider ingress, lifecycle
  convergence, and persisted compatibility for account-backed triggers.
- [Externally managed references](./externally-managed-references.md): how to
  resolve identifiers whose entities are owned by another authority without
  conflating missing entities, invalid input, dependency failures, and local
  invariant violations.

## Specialized Guidance

- [Dependency override audit](./dependency-overrides.md): retained dependency
  constraints, their origins, and evidence for removing obsolete overrides.
- [Marketing privacy rollback](./marketing-privacy-choices.md): withdrawn runtime
  behavior, retained database state, and rollout boundaries.
- [Google Cloud LLM voice routing](./google-llm-voice.md): shared Vercel workload
  identities, API configuration, Oregon-first model routing, and rollout gates.
- [Google Ads browser routing](./google-ads-browser-routing.md): verified account
  ownership, conversion actions, rollout compatibility, and historical recovery.
- [Connector inspection JSON](./connector-inspection-json.md): command output
  contracts, current versus run evidence, account identity, and next actions.
- [Platform lint boundaries](./platform-lint.md): current transport and lifecycle
  exceptions, polling policy, and retired configuration history.
- [Clerk customization](./clerk-customize.md): hosted Clerk styling ownership,
  public appearance boundaries, lint enforcement, and upgrade verification.
- [React commit analysis](./react-commit.md): measuring and attributing React
  work without confusing executions, scheduler events, or DOM mutations with
  commits.
- [Chat cards](./chat-cards.md): recognizing links in chat messages, creating
  thread-scoped card signals, and rendering rich interactive cards.
- [Pi native provider preparation](./pi-native-provider-preparation.md): additive
  native readers, transport/auth ownership, accounting and activation gates.
- [Pi runtime architecture](./pi-runtime-architecture.md): launch, SDK/session,
  memory, accounting, retained compatibility, and patch ownership boundaries.
- [Runner host configuration](./runner-host-configuration.md): configure and
  verify host-local concurrency and I/O capacity overrides.
- [Runner multi-architecture rollout](./runner-multi-architecture.md): build,
  deploy, and validate runner artifacts for supported host architectures.
- [Testing catalog](./testing/anti-patterns.md): detailed testing anti-patterns.
- [Addon runtime contracts](./mitm-addon-contracts.md): logging ownership,
  WebSocket framing and handshake limits, and path normalization boundaries.
- [Chat Event Snapshot timeout diagnostics](./chat-event-snapshot-timeout-logging.md):
  expected per-head deadlines, stage diagnostics, convergence and retention
  safety, and archive-lag alerting.
