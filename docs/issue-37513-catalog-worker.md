# Issue 37513: catalog worker integration inventory

Base: `5b333105e96a80790948ed169ae915a10c89ffbe`.
Branch: `refactor/37513-worker-catalog-20261001`.

## Owned terminal surface

`model-catalog.service.ts` has no database-handle or node-valued parameters.
Its database reads are owned by closed computeds/read commands:

- `createModelCatalog(): Computed<Promise<ModelCatalog>>`: fresh graph-owned catalog read. Claim and run graphs create their own instance, not a process-wide catalog cache.
- `modelCatalog$`: one catalog snapshot in a request store.
- `loadModelCatalog$`: fresh read for long-lived stores, accepting only an optional final positional `AbortSignal`. Workers capture its plain result and pass that snapshot through preparation/admission/run creation.
- `systemDefaultRunModel$`: derives the default from the request catalog.

Other runtime exports remain pure: `catalogBuiltInRoute`, `isCatalogRouteExecutable`, `resolveCatalogModel`, `resolveCatalogRunModel`, `isCatalogModelRunnable`, `catalogBuiltInCandidates`, `catalogProviderUpstreamModel`, `isCatalogModelAddable`, `catalogRoutesFor`, `catalogHasProviderRoute`, `memberModelPolicyCatalog`, `catalogBuiltInPriceTier`, `catalogDisplayName`, `catalogActiveModels`, `catalogModelRank`, and `ModelCatalogInvariantError`.
Type exports remain `CatalogRoute`, `ModelCatalog`, and `CatalogModelResolution`.

`model-selection.service.ts` has no database-handle or node-valued parameters,
no hidden database provenance Symbol, and no deferred database-reading closure.
Its private read command captures scoped policy, entitlement, mode, preference,
member account, organization provider, and custom-surface facts. Route decisions
use the existing pure snapshot resolver. Subscription effort/tier validation
remains at the branches that consume subscription models, not unrelated routes.

Public runtime exports:

- `resolveDefaultModelFirstPin$`: plain `{ orgId, userId, defaultSource?, orgPlanCapabilities?, catalog? }`, then optional final positional `AbortSignal`.
- `resolveModelSelectionPin$`: plain `{ orgId, userId, modelSelection, orgPlanCapabilities?, catalog? }`, then required final positional `AbortSignal`.
- Unchanged pure exports: `MODEL_FIRST_SELECTION_PROVIDER_ID`, `modelProviderWriteTypeForLaunch`, `resolveRunSelectionModel`, `isReplacedModelSelection`, `validateCodexServiceTier`, and `resolveQueuedModelSelectionPinFromSnapshot`.
- Type exports: `ModelFirstPin`, `DefaultModelFirstPin`, `ProviderModelSupport`.

The old `loadModelCatalog(db)`, `loadSystemDefaultRunModel(db)`,
`resolveDefaultModelFirstPin(db, ...)`, and `resolveModelSelectionPin({ db, ... })`
exports and call sites are removed. No legacy handle-taking adapter replaces them.

## Necessary callers

`chat-input-model.service.ts` now exposes the handle-free read commands
`resolveChatInputModelSelection$` and `resolveEnqueuedChatInputModel$`.
The latter reads the thread itself. A workflow queue writer receives a plain
prepared model selection instead of reading it inside an escaping transaction
callback. Thread creation shares one plain catalog snapshot between default
selection, explicit selection, service-tier validation, and effort validation.

Existing helpers in other domains receive a required first plain
`catalogSnapshot: ModelCatalog` argument where they previously loaded the
catalog using their database argument. Those helpers' unrelated database
parameters are not new adapters for either owned service; their broader
ownership migration remains with the parent/domain workers. This includes
Pi credential/admission, bootstrap, runtime-route, and MCP
caller plumbing. Parent integration must preserve the new snapshot arguments
when merging overlapping changes; the separate MCP worker owns protocol removal.

`loadSystemDefaultBuiltInVendor` is now a pure catalog transformation with no
database argument. Test fixtures read catalog nodes through their own stores.

## Transactions and verification boundary

There are **zero transactions** in either owned service, and none were added.
No locks, retries, coordination fields, migrations, provider writes, production
hooks, or stronger MCP capabilities were added. Existing transactions in caller
domains were not reclassified or represented as terminal by this slice. Catalog
reads formerly inside onboarding transactions are prepared outside
those callbacks; transaction removal and remaining helper/transaction ownership
in those domains belong to their implementation owners.

Added public HTTP regression coverage in
`chat-threads-model-selection.test.ts`: removing a workspace model route rejects
the selection without changing thread metadata; restoring the route permits a
new selection. Setup and assertions use production APIs, not database rows or
service mocks.

Verification performed: affected Prettier, ESLint, Oxlint, type-aware Oxlint,
style policy, `git diff --check`, and complete API `check-types` with
`TSC_CHECKERS=1`. No Vitest or dev server was run. Behavioral regressions remain
for parent PR CI. Repository Knip did not complete: OXC parser failed with
`RangeError: Array buffer allocation failed`; this is not a passing unused-code
check. No PR, review, merge, queue, release, workflow, or parent-thread message
was created by this worker.
