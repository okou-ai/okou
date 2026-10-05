# Scoped account-lifecycle immutable catalog migration

## Scope and dependency

This batch implements the account-lifecycle selection consumer only. It is stacked
on `okou-ai/okou#37699`, originally at
`348837a965b2004569d066765602648260b090f8`, because that commit supplies
`immutableConnectorRuntimeSelection` and `ConnectorRuntimeLookup`; current main
has the merged P2/P3 writer but not that scoped reader. Do not reimplement a DB
adapter or synthesize the legacy catalog identity to avoid this dependency.

Authoritative design: [W2](https://app.okou.ai/artifacts/apwqx5vqkv.md), superseded
where applicable by [Ethan v5](https://app.okou.ai/artifacts/4cka9byjec.md) and the
coordinator's explicit small-batch boundaries.

Before delivery, the branch normally merges the observed parent HEAD
`5536ce04069b638594451973254a403e47d9606d`, retaining its actual main merge,
catalog-generation grouping repair, 1322 migration and all metadata. The one
real conflict is in `connectors-list.test.ts`: keep the parent's relocation of
`skips stored connectors whose runtime method is unavailable` into its unchanged
`connectors-list.catalog-generation.test.ts`, and retain this child's renamed
compatibility case and new account assertions in the ordinary file. No test case
is lost, duplicated or restored to the wrong group.

The parent's scheduling causality/repair acceptance and Preview remain separately
owned. This child does not repair or independently approve that patch, and does
not require the parent to wait for this child. Necessary later parent alignment
uses normal integration and a fresh independent resolution review.

## Actual reader mapping

`connector-account-lifecycle.service.ts` previously used the one
`loadConnectorAccountRuntimeSelection(db, rows)` helper around legacy
`loadConnectorRuntimeSelection`. Four projections consume that selection:

| Projection          | Necessary callers                                                    | Retained contract                                                                                               |
| ------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Account summaries   | account summaries route and connector overview                       | Owned org/user grouped counts, attention/default account, credential freshness                                  |
| Accounts for target | connections route                                                    | Exact builtin/custom target, cursor precision, search, pagination, scope mismatch, custom visibility            |
| Exact account       | get, rename/default/delete preflight, deletion impact, OAuth receipt | Owned org/user/account/target, exact stored method/storage version, existing write and receipt error boundaries |
| Accounts by IDs     | inspect and thread-selection projection/preparation                  | Owned account IDs, exact target match, unknown/missing behavior, selected account preservation                  |

These projections now take plain arguments and return read-only computed nodes.
Their owning nodes obtain `db$` and read the existing immutable selection. They
pass only plain rows/targets and immutable lookup results; no DB handle,
get/set accessor, node, signal or reader callback is injected into the catalog
reader. Existing internal account SQL helpers and writes are retained; this is
not a whole account-service transaction/handle migration.

One selection SQL captures current/hash/header/manifest and the requested runtime
union. Account projections need no metadata-only slugs. Summaries capture the
union of groups and default rows because their existing parallel account queries
can observe different sets during concurrent creation. All projections within
that read use the same captured immutable lookup; no current reread occurs during
method, storage compatibility, freshness or response projection.

Manifest-outside targets retain absent/404/omitted-account behavior. A required
manifest entry or current that is missing propagates an integrity error instead
of the retired legacy-unavailable-to-null catch. Custom-only/no-account paths
still do not require builtin catalog data. Runtime/metadata capability separation
is provided by the existing reader; this batch neither fabricates empty metadata
nor grants execution to metadata entries.

OAuth completion remains a module-scope command with final positional owner
AbortSignal. It checks cancellation after the receipt SQL and after the account
read, retaining exact receipt org/user/attempt/expiry/account-target checks.
Receipt registration, OAuth/DCR, secret access, mutation transactions, default
conflicts, FK arbitration, account promotion, workflow reprojection and realtime
wakeup policies are unchanged. Routes and request/response/persisted shapes are
unchanged; no baseline or new feature policy is introduced. The delete preflight
now explicitly checks its existing owner signal after the finite account read
before starting the write.

## Pi recapture: stopped, not implemented

The assigned second point is a real dependency, not another occurrence to count
as migrated:

1. `pi-stable-context.service.ts:registerDemand` opens one transaction, locks
   owner authority and matching ready generations, calls
   `recapturePiStableContextInput(tx, capturedInput, checkedAt)`, then persists
   the resulting input/digest/head in the same transaction. Recapture's source
   reads are explicitly serial on that transaction-bound client.
2. `pi-stable-context-recapture.service.ts:loadStableContextSourceSnapshot`
   consumes legacy selection. Its result is used for builtin skill pins and
   permission firewalls. The final `source.catalogIdentity` hashes the full
   legacy identity, and `source.catalogSourceId` comes from `.sourceId`.
3. `thread-claim-run.service.ts` constructs the corresponding stable-context
   source using the same legacy identity digest/sourceId. In
   `pi-stable-context.service.ts:readReadyProjection`, the complete projected
   source/mount identity must equal `buildInputIdentity(args, generations)`.
   Recapture-only hash/capability identity would no longer match claim inputs.
4. `pi-stable-context-generation.service.ts` still has the source-scoped
   invalidation predicate on persisted `input.source.catalogSourceId`.
   Replacing that with an invented legacy ID or arbitrary null would not retain
   that contract. Production global invalidation is not evidence that every
   still-live source-scoped contract has disappeared.
5. The existing immutable computed obtains `db$`; using it from a new Store
   inside recapture would not preserve the locked transaction's client/snapshot.
   Passing tx, DB nodes, accessor closures or a reader callback is expressly
   forbidden and is not a solution.

Minimum separate work: coordinate real claim-source/ready-input identity and
invalidation transitions with the planned hash/capability/full-snapshot work,
then place transaction-local catalog capture in the actual owning stable-context
operation without leaking a transaction handle. Preserve owner/generation locks,
permission expiry, skill pins, capability split and cancellation. This batch does
not decide that redesign, migrate P5 permission baselines, change claim policy,
null out provenance, delete baseline logic or patch AgentRunContext.

Pi source, claim-time code, baseline schemas and stable-context persisted shapes
remain byte-unchanged. The exact blocker was returned to the coordinator; only
account lifecycle proceeds.

## Test deletion/replacement ledger

No case is deleted or moved; no new ordinary catalog install, PGlite suite, DB
adapter, native replay, sleep, retry, timeout or production hook is added.

| Existing case/group                                                                           | Retired mechanism/assertion                                                                                              | Replacement and overlap evidence                                                                                                                                                                                                                                                                                                 | Retained boundary                                                                                                                                                                                                                                                    | Validation                                                            |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `connectors-list.test.ts`: immutable stored-list versus legacy compatibility-unavailable case | Account connections/get/deletion-impact404 and inspect unavailable solely because of the old lifecycle selection catch   | Same real owned GitLab account now remains API200 with exact account/list/inspect facts, alongside the already-covered immutable stored-list body equality. The legacy compatibility state cannot govern this new reader. Native N5 supplies actual missing-entry/current errors; this ordinary case is not a substitute for N5. | Original production connect, account/binding identity, missing receipt404, both still-live legacy scope-diff404/NOT_FOUND, unauthenticated/missing-org cases remain. Existing legacy source fixture is not broadened; its later cleanup belongs to the parent owner. | Local static/API types passed; natural CI required.                   |
| Existing native N2                                                                            | No deletion; add account consumer observations during accepted current, partial preparation failure and successful retry | Public account connections remain the exact admitted account while old current serves and after retry; shares actual cron, engine and actor with existing MCP checks instead of adding a second lifecycle fixture.                                                                                                               | Existing preparation idempotency, no half activation, exact skill version/no HEAD, payload/manifest conflict errors, all MCP assertions.                                                                                                                             | Not locally executed in this batch; natural current-head CI required. |
| Existing native N4                                                                            | No deletion; add account consumer at old/new/back-to-old hash phases                                                     | Account API remains available across the same actual cron switches. Its unchanged account fields do not claim catalog label visibility or prove a separate captured-hash recapture path; existing MCP/capture checks retain that proof.                                                                                          | All original MCP labels/account IDs, captured old-hash single read, metadata-only separation and capability filtering assertions.                                                                                                                                    | Not locally executed; natural CI required.                            |
| Existing native N5                                                                            | No deletion; add account known/unknown/missing-row/missing-current HTTP outcomes                                         | Known account200, manifest-outside target404, required missing entry500, missing current500 even for unknown target; no R2/legacy read. Exact catalog read count goes4→7 because three account requests occur inside the measured fault phase, not because a consumer reads twice.                                               | Original MCP unknown[], known missing500, empty-selection/current error, R2-not-called and old-table exclusions remain; each consumer still uses one current+entries statement.                                                                                      | Not locally executed; natural CI required.                            |
| Native actor token helper                                                                     | Move existing matching Clerk membership response and signed token into shared `actorToken` used by MCP and account API   | Same typed ClerkPaginated/ClerkOrganizationMembership response, exact actor user/org, org:member, totalCount1/0; same genuine signer/capability/account source binding. No duplicate auth/DB mock.                                                                                                                               | Other users valid empty list; no admin/auth bypass/cache injection; identical cleanup reset path.                                                                                                                                                                    | Static/API types passed; natural CI required.                         |

Native suite remains four business cases, one expected setup-negative case and
N1 TODO. Existing owner abort → shared detached drain → waitUntil drain → unbind
→ close and five-engine guard are unchanged. Previous parent native execution is
historical, not execution proof for this child.

Existing account API product cases continue covering method/storage freshness,
scopes, secret ownership, default races/promotion, pagination, foreign actors,
rename/delete and selected-account behavior. They are not claimed rerun locally.
Parent scheduling and ordinary per-case publication cleanup are neither fixed nor
accepted by this child; no broader fixture cleanup is hidden in this ledger.

## N5 typed-client assertion repair

At original PR HEAD `63296e1f20a01a74bb27f53f5bc58eaa1c0b1a0f`, natural
CI run `37354215755`, API8 job `111912535192`, failed in N5 after deleting a
manifest-listed entry. The real account route returned HTTP500, but the typed
client threw `Unknown response status 500 for GET /api/connector-accounts/connections`
because the endpoint contract does not declare 500. Therefore the old
response-status assertion was never reached. This is a business-body failure,
not teardown or an external flake. Historical lint failure, cancelled shards
and the derived failed gate remain separate evidence, not passes.

| Changed assertions                                      | Retired test mechanism                                                                 | Replacement / preserved boundary                                                                                                                                                                                                                                                                                                                                      | Verification                                                                                                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| N5 account missing-entry and missing-current assertions | Reading `.status` from a typed response that cannot be returned for undeclared HTTP500 | Await the specific verified HTTP500/method/path rejection, using the unchanged real route, member token and account helper. Preserve subsequent unknown404, MCP responses, empty-selection/current error, seven SQL reads, no R2/legacy fallback, and all five-engine lifecycle assertions. No cases deleted/moved; no product response-contract/error-policy change. | Scoped ESLint/Oxlint, format and diff-check passed; test types recorded at handoff. Runtime validation is the new HEAD's natural CI, not local Vitest. |

Independent review of the original owned diff remains pending; this author repair
is not approval. The new minimal delta needs non-author review. Pi remains excluded
for the transaction/identity reasons above; Preview remains pending separate
coordinator authorization. No parent-generation lint cleanup is included.

## Verification and remaining gates

Scoped ESLint/Oxlint (including type-aware production and test lint), format and
full API aggregate type checks passed on the original account commit. The parent
integration is checked again before delivery; natural CI remains separate. Initial
static checks found the removed legacy logger unused and a widened literal union
in the new computed callback; both were corrected with an explicit result type
and removal of the now-unused logger. Logs preserve those failures. The first
root Oxlint invocation found no executable; package-scoped Oxlint was then used,
not a test rerun or environment/PG repair.

No local API business/native Vitest execution, full local Vitest, dev server,
Browser/Preview/Axiom/provider sample, environment repair, model/workflow/budget
change or production action. Normal hooks, protected review and natural CI remain
required. Keep the PR Draft with autoMerge off. Applicable Preview must be
coordinator-authorized and completed before any later pr-auto. Source/static
success is not live activation or performance acceptance.

Remaining selections and full-snapshot/chat-captured cohorts, P5/P6/P7, final
pointer cutover and S1–S3 acceptance remain separate. No rollback window or GC is
introduced under Ethan v5.
