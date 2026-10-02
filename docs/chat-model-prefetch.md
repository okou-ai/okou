# Chat run context signals

`createAgentRunContextSignals(userId, orgId, agentId)` owns one identity-scoped
set of read-only async computeds. The interface contains exactly three plain IDs
and computeds; no commands, state or writes. The cross-graph exception is recorded
in [API ccstate design](api-ccstate.md#1-factories-take-plain-values).

## Independently consumable groups

- `agent$`: Agent configuration and its organization-default identity.
- `plan$`: organization plan capabilities; capacity consumes only this group.
- `modelFacts$`: the catalog, routes, organization policies, model mode and credits.
  It shares `plan$` rather than rereading the entitlement.
- `memberModels$`: connected member model accounts, configured models and encrypted
  account secrets. Routing and source selection share these rows.
- `memberMetadata$`, `permissionGrants$`, `workflows$`, `featureSwitches$`,
  `disabledPaidTools$`, `environment$`, `connectorSelection$`,
  `customConnectorDefinitions$` and `catalog$`: the existing Agent-bootstrap
  read definitions, individually consumable instead of one aggregate promise.

S1 creates the interface once. Authorization reads `agent$`; model validation
reads `modelFacts$` and `memberModels$`. It does not await unrelated groups.
After enqueue commits, `preloadAgentRunContext$` triggers all groups without
awaiting them and owns their settled promises with `waitUntil`. Rejections stay
cached in the original computeds; consumers fail fast without a second loader.
No preloading competes with the enqueue transaction. There is no `bootstrap$`
aggregate and no transported `PrefetchedAgentBootstrap`/`PrefetchedModelBootstrap`.

## Claim identity and graph boundaries

The lease UPDATE joins `chat_threads` and returns `userId` and `agentId` with its
existing claim fields in one statement. At the start of pick, matching IDs reuse
the supplied interface. Missing or mismatched IDs construct the same factory.
An organization match reuses `plan$` and `modelFacts$`; an organization-and-user
match also reuses `memberModels$`, independent of Agent identity. Only the whole
read-only interface crosses into Thread; pick's individual graph nodes do not.
The request Store memoizes the computeds. Later-request queue drains build their
own interface, and no process cache or age policy is introduced.

Integration reconciliation may change the default Agent after the lease; that
execution gets a new Agent-scoped interface and retains matching org/member data.
The ordinary web path does not wait for the queue head to begin identity reads.

## Credit and plan semantics

Ethan approved using the captured credits balance on October 2, 2026. Both
preparation admission checks use that snapshot. Expired-credit and usage-pack
calculations retain their existing reads. Another run's spending or a payment
between capture and admission does not replace the balance snapshot.
The captured plan also determines the free-plan admission bit. Thread does not
restore plan `FOR UPDATE`; the Pi maintenance entrypoint is unchanged and is
separate work. Account transaction validation, official workflow admission,
thread/session, lease and queue fences remain intact.

## Scope and acceptance boundary

This change only restructures existing Agent/model prefetch sources. It does not
add Connector account/credential prefetch (#37563), official-workflow/storage or
allowance groups. Existing Connector current-catalog cutover revalidation remains
owned by #37563; its reading boundary still waits only for `catalog$`, not the
entire context. Additional Connector snapshot deduplication must land in that PR.

Regression coverage uses real send/Run/Runner APIs for a matching context, queued
input drained in a later request without a context, model policy changes while
an external attachment response is pending, and fail-fast matching preload
failure. Existing catalog-cutover behavior is preserved. Deployed parent/PR
trace comparison reports statement/table counts separately from runner output,
and does not claim production latency improvements from a small sample.
