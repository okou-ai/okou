# Issue 37513 — feature context and Pi SQL ownership increment

Base: `9900095aaafb9386daeedfea5d51dcfcac9734b5` on the parent branch.
Worker: `refactor/37513-worker-block11-terminal-20261002`.

## Implemented interfaces

- Deleted `loadUserFeatureSwitchContext(db, orgId, userId)` and every call.
  Existing executors perform the same typed selection, with the pure
  `userFeatureSwitchRowCondition` and `featureSwitchContextFromRows` builders.
  Identity, tenant filtering, registered-key filtering, organization sentinel
  precedence and the existing SQL snapshot are unchanged. The read command and
  computed factories remain the public context interface for node consumers.
- `pi-stable-context-generation.service.ts` no longer accepts connections,
  transactions, getters, setters or computed/command nodes. Its existing feature
  invalidation command owns `writeDb$`; the other exports construct SQL,
  predicates, validated receipts and plain Storage-demand values, without I/O.
- Callers execute these statements on their own existing executor. The old
  generation/Head lock helpers, implicit transaction forwarding and in-module
  recapture/locking chain are deleted. No new lock, column, retry, timeout,
  signal parameter slot or fallback protocol is added.
- A reservation is a gated CTE: advance the scope to pending, upsert the exact
  publication key/token/generation from that result, and invalidate the scope's
  disposable heads in one statement. Bigint receipts are decoded at the SQL
  owner with `parseRawRows` and the reviewed safe-integer schema; pure receipt
  builders receive decoded values, never an executor.
- Exact-key publication admission, deletion and readiness remain in the same
  source transaction as the HEAD write. A real pending-scope write precedes the
  current token read/delete, in the same generation-before-publication order as
  reservation. A fresh exact-token predicate decides supersession. Independent
  keys are accounted for by a fresh readiness query after deletion. The source
  writer must not execute these stages as separately committing operations.
- Storage-demand SQL now reads one compact snapshot with at most 16 eligible
  immutable inputs, builds rebound values purely, and conditionally writes each
  captured Head at its exact generation. Larger scopes are cleared without
  loading every large JSON input. Storage retirement uses its dependency
  predicate directly. A CAS miss preserves the concurrent winner; canonical
  next-use preparation validates/rebuilds from current authoritative sources.

## Changed source chains

Context callers: Pi memory Stage 1 schedule/candidate/credential/worker, Phase 2
credential, GitHub OAuth, connector runtime sync, webhook firewall auth, internal
Slack callback, Stripe workflow feature gating and Feishu configuration.

Pi callers: Workflow create/update/delete/visibility, Agent updates/instructions,
Official workflow installation/catalog publication, custom/Feishu connectors,
connector selections and grants, connector catalog synchronization/reconciliation,
Storage commit and skill synchronization. Small changes in those owners replace
handle calls with SQL/typed selections; their unrelated business logic is not
rewritten. Existing source tests/fixtures have their removed interface calls
adapted to execute SQL locally rather than pass a transaction into the service.

Three obsolete exports used only by eager projection transformation were removed:
`piStableContextWorkflowInvalidationOptions`, `loadedMemberModelRouteContext` and
`loadOrgModelPolicyFacts`. No currently referenced model catalog API is removed.

## Transactions and recovery

- No transaction lives in the generation service. Reservation is one statement,
  not a transaction moved into another helper.
- Existing final publication transactions remain source-owned: exact-token
  admission/consumption, Storage HEAD/version/index publication and readiness
  must commit together. This is the core invariant, not mere multi-table
  convenience. The statement order prevents a newer same-key reservation from
  committing between admission and the old HEAD write. There is no external
  fetch/KMS/S3 in the added SQL stages.
- Generic source invalidation no longer eagerly recaptures 16 variants. It
  advances authoritative generations and leaves projections missing; canonical
  next-use demand recaptures current sources. This intentionally removes
  transaction-bound catalog/permission recapture. It does not delete source
  data, immutable artifacts or active Run context. Existing canonical repair and
  bounded artifact/resource cleanup remain responsible for projection recovery.
- Storage changes retain bounded exact-input rebinding and worker demand. Only
  disposable projection CAS losers may need canonical repair. Source HEAD data
  and same-token publication failure remain authoritative.

## Important residual boundary — not full PR terminal acceptance

Both scoped service interfaces have zero DB/transaction/node parameters, and the
old helper calls are gone. This is not evidence that all surrounding legacy
writers have reached the target. In particular, existing caller families still
have ordinary functions with DB/Tx parameters for their unrelated SQL:

- instruction Storage registration/commit helpers (`commitPreparedVolumeServerSide`
  and `commitPreparedAgentInstructionsStorageInTransaction`);
- Storage HEAD/version commit helpers under `storage-write.service.ts`;
- Workflow metadata/deletion helpers, connector grant/replacement writers,
  permission-grant writers and catalog activation helpers.

Their new Pi statements stay on the original source executor and preserve its
atomic publication boundary. Moving those entire owner chains into commands is
still a follow-up; do not call the whole issue terminal-complete merely because
the two scoped interfaces no longer forward handles.

The generic eager-warming optimization changed. Existing internal generation
cases that assert immediate recaptured/pending Head rows have not been behaviorally
validated against the new lazy recovery contract; parent CI and public-boundary
recovery verification are required. Those private row assertions were not added
or expanded as new coverage. Retained public instruction/Workflow/Storage and
feature-switch API coverage must remain green, especially same-token conflict,
authorization, independent publication keys and source freshness after repair.

## Verification

Affected Prettier, ESLint, API-cwd Oxlint/type-aware lint, Knip and API
core/test type checks were run. Full type checks use `TSC_CHECKERS=1` for this
increment. No local Vitest, dev server, PR creation/review/merge, workflow,
release or production operation is authorized or performed. Behavioral CI and
end-user acceptance remain unverified; the final handoff records actual checks.
