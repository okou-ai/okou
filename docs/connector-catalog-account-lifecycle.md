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

At the N5 repair handoff, independent review was pending; that historical status
is not rewritten as runtime acceptance. L subsequently delivered source Scoped
LGTM for the original nine-file/resolution scope and the two awaited N5 rejection
assertions. N5 still has no new execution PASS: exact-f31 API8 was cancelled.
Pi remains excluded for the transaction/identity reasons above; Preview remains
pending separate coordinator authorization.

## API1 public-selection contract repair and parent alignment

Exact `f31dc4c13ca43339744adebdfc00cacbb8be77f2` natural Turbo
`37357974440`, API1 job `111925267781`, failed at
`chat-events-connectors.test.ts:927`: the selected-account list contained the
owned OpenAI account as well as Runtime, while the old assertion expected only
Runtime. The job recorded one failed / 1,027 passed tests and one failed / 52
passed files. Other cancelled shards, including API8, are not passes. The
original632 N5 typed-client business failure remains separately recorded above.

The first source-contract divergence is the old test's inference from
`replaceApiTestConnectorCatalogStoredBytes`: it updates only the owned legacy
compatibility evaluation and active snapshot. It does not change immutable
current/header/manifest/entries. The migrated account-by-ID projection therefore
still returns both owned accounts, and the public selection list retains both
persisted selections. Run execution and new-selection validation still consume
the live legacy runtime snapshot. Their exclusion/rejection does not authorize
removing a valid account from the immutable public projection. No production
selection policy or fallback is changed.

| Existing case                                                 | Retired assertion                                                                                                | Replacement public coverage                                                                                                                                                                                                                                                                               | Preserved boundary                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CHAT-02 selected built-in omitted from the legacy Run catalog | Public selection GET omits an immutable-valid account solely because an owned legacy snapshot no longer lists it | Rename the same case to identify the legacy/immutable split; assert both exact account selections before and after the real Run claim; explicitly assert both connected public account projections only after claim. After public clear, assert only Runtime remains before and after legacy restoration. | Real Run send/claim succeeds; OpenAI secret metadata, runtime registration and account-bound firewall remain absent; Runtime secret metadata retains its exact selected account ID. Both existing selection-update and thread-create400 checks remain, as do clear204, restoration and cancellation. All custom/builtin ownership/permission cases are unchanged. |

No case is deleted, moved or skipped. No mock, database fixture, catalog
publisher, internal reader adapter or new install is added; the pre-existing
owned legacy mutation/install remains limited to its original case. Actual
immutable absent-entry/current fail-fast and no-fallback behavior remains native
N5, not this legacy-only mutation. Its two exact awaited HTTP500 rejection
assertions, subsequent checks/read7 and five-engine cleanup remain unchanged;
N2/N4 public accounts and N3 concurrency are also unchanged.

One normal parent merge is now integrated at
`7c41e0afc06b6ed4f0b71b754ac1cdab6ddebebc`, with ordered parents
`f31dc4c13ca43339744adebdfc00cacbb8be77f2` and
`f5e5829c9cd6e30e7604d4b9fc00baf5d78674f1`. It merged automatically with no
conflict or handwritten resolution. The exact ten-file parent cleanup, all ten
generation files/group barriers and full migration tree are retained. The child
native/account source blobs remain unchanged by that merge. This author's prior
independent parent review does not approve the new child integration/repair;
non-author delta review and natural new-head CI are required.

No local Vitest/native/full-suite or PG/environment repair is performed. Scoped
ESLint, Oxlint with deny-warnings, test type-aware Oxlint, Prettier, diff-check
and the complete API aggregate types/boundary/acceptance pipeline passed. The
Node boundary regressions are part of that authorized type pipeline, not an
API business/native Vitest replay. These static results remain separate from
natural new-head CI, non-author delta review and pending Preview. The PR remains
Draft with autoMerge off.

## API4 Official delegation-chain lifecycle repair

At exact account HEAD `c5e24bb89a5563aef3901cdbb5ec97d9dacc7026`, natural
Turbo `37361272447`, API4 job
[111936431813](https://github.com/okou-ai/okou/actions/runs/37361272447/job/111936431813)
failed in `official-workflows.test.ts:8755`, "launches an idle Official agent-run
input with the annotated source budget": timeout5000ms, case5051ms; one failed /
980 passed tests and one failed / 51 passed files. The 31 case-tagged exitCode1
warnings are intentional public parent completions, not 31 product failures.
The log does not identify the timed-out await or establish a flake, an account
regression, or a unique root cause. This historical result remains FAIL.

Two source-backed redundancies are removed in the existing case/helper:

- Every one of 31 loop hops explicitly drained waitUntil, then immediately
  invoked `launchedAutomationRunId`, whose first operation drains the same
  tracker. There is no intervening request. Retain the helper's drain before
  reading the child; remove only the redundant outer call. The tracker drains
  its pending and newly registered work to quiescence and acknowledges detached
  ownership; its errors are not suppressed. An already-empty drain is cheap:
  removing it does not prove any particular timing improvement.
- All 31 child observations and the final idle launch previously reread from
  seq0 and paged every historical event before choosing the newest input.
  Workflow admission reuses the owned workflow/user automation thread. Supply
  a case-local per-thread paired ID/seq cursor obtained only from actual public
  event-row responses. The existing authenticated event-rows API validates that
  paired cursor and returns ascending rows strictly after it. Pagination still
  consumes every new page; an empty tail does not fall back to an old Run.
  All other callers omit this optional cursor map and retain cold-start behavior.
  The final rejection audit still reads the entire thread and asserts exactly
  one `autonomy_budget_exhausted` rejection. No budget/counter/DB state is seeded.

The retained helper drain owns workflow admission's background pick/notification
and parent completion's released-slot pick and completion side effects. It is
awaited after the public parent completion and before the child event lookup and
real Runner claim. The standalone drain after the 31-hop chain remains before
idle admission, as do the final completion/rejection drain and teardown's
cancel-all/drain/delete-agent/catalog-cleanup sequence. No work is detached by
the repair and no critical synchronization is removed.

All 31 dependent real admission/completion/claim hops, final idle launch,
source Run/thread annotations, slash prompt, statuses/bodies, distinct child,
identity/permissions and exact budget-exhausted outcome remain. No case deletion,
hop reduction/concurrency, larger timeout, sleep, retry, skip, product policy,
production Official/claim/Pi/runtime/account code, global resource change,
legacy fallback or environment repair. The improvement is avoiding repeated
public history scans, not measured time saved or reproduction of the old timeout.

L's exact-c5 non-author [source receipt](https://app.okou.ai/artifacts/wyb1xid8qc.md)
closes the earlier 632/f31/c5 source chain, not CI/Preview or this new delta.
Before-Run account GET asserts exactly two selections; only after claim does it
explicitly assert both connected projections. No stronger pre-Run assertion is
claimed. This new two-file test/ledger delta needs another non-author review and
natural new-HEAD CI. Original632 typed N5 failure, f31 API1 FAIL/API8 cancellation
and c5 API4 timeout remain separate historical failures; no old run is rerun.

Repair static checks: scoped ESLint max-warnings0, Oxlint deny-warnings, CI-config
test type-aware Oxlint, complete API aggregate types/boundary/acceptance,
Prettier and diff-check passed. The initial type check correctly rejected a
cursor type imported from the row module (TS2724); it was corrected to the
existing public schema-version module and the complete pipeline passed. The
initial failure is retained, not rewritten as PASS. Syntax-only comparison
confirms the eight explicit assertions, failure guards and teardown unchanged;
other directly named registration blocks are unchanged. This is preservation
evidence, not business execution or author approval.

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

## Historical31-hop diagnostic checkpoints (removed, not a repair)

The following describes the temporary diagnostic commit
`9d56ffb6b2aa3f4b16fca0f1715b6fd8bae44ffc`, not the current test source. Its
single natural cohort passed the four named gates and all8 API shards. API4
reported981 PASS/52 files PASS, target case3920ms. All290 checkpoints completed
31 hops, final full-history exhaustion and cleanup; no pending entry or LIMIT.
These are facts of that one instrumented execution, not final-source CI proof.

Starting from main-integrated `6af828c4ed288a2ac55055baddc95d4a81072e77`, only
the existing Official31-hop case gains local synchronous entry/exit checkpoints.
The fixed tag, numeric hop, fixed phase/event and monotonic elapsed value contain
no identities or business data. Output is capped at512 records, with the last
record marked LIMIT. Hop0 denotes setup/source launch,1–31 the unchanged serial
chain,32 the final idle launch,33 exhaustion, and-1 existing cleanup. Public
launch helpers remain combined drain/read phases; their internals are not timed.
A missing exit may mean timeout, abort or throw, not a uniquely attributed hang.
No catch, wrapper Promise, timer, production hook or shared state is introduced.
Logging cost is included; elapsed is not historical timing or improvement proof.

The c5 timeout,2543's eventual successful execution and6af API4 timeout remain
separate historical receipts. Current6af recorded30 intentional terminal commit
warnings over4595.157ms and case5063ms; those markers precede callback/HTTP
completion and do not certify30 completed hops. Neither cumulative budget
consumption nor the last await is uniquely proven. No root-cause closure or flake
classification follows from a diagnostic PASS. Requests,31 real hops, assertions,
paired cursors/full-history exhaustion, drain/cleanup, signals and5000ms timeout
remain unchanged. Only one new natural CI cohort is authorized; first substantive
failure stops general observation, with only its already-existing API4 diagnostic
log collectible afterwards. No old recovery allowance is revived. The new delta
needs non-author review; actual repair and diagnostic removal need a separate
decision. This diagnostic must not be left in place for merge.

## Diagnostic removal — final-source validation is separate

The authorized cleanup removes only the temporary recorder and every checkpoint
from that case. The entire `official-workflows.test.ts` blob is byte-identical to
reviewed `6af828c4ed288a2ac55055baddc95d4a81072e77`; requests,31 serial hops,
public admission/completion/drain/pagination/claim/exhaustion/cleanup, original
assertions, signals and5000ms timeout are unchanged. No production fix or new
helper, hook, retry, sleep, budget/configuration change or reduced work was added.

The original c5/6af timeout root cause remains UNKNOWN, not uniquely confirmed.
The9d56 diagnostic execution completed once; it did not reproduce the failure
and is not evidence of flakiness or a timeout fix. No new evidence supports a
further business repair. Those failed cohorts,2543's separate successful cohort,
and9d56's instrumented PASS remain separate historical receipts.

One new natural CI cohort validates the necessary diagnostic-removal source,
not another diagnostic sample or an old-run rerun. Final-source CI, independent
cleanup-delta review and applicable Preview remain distinct requirements. The
6af source approval inherits only unchanged code, not this ledger delta or new
CI/Preview. First substantive failure stops acceptance; no old Crates recovery,
local replay, automatic further repair or merge authorization.

## Minimal SCA dependency repair after8dc stop

The cleanup source delta has coordinator independent Scoped LGTM; that accepts
neither8dc CI/Preview nor this new dependency delta. Original c5/6af timeout cause
remains UNKNOWN;2543 PASS,9d56 diagnostic PASS and8dc critical SCA FAIL are
separate cohorts. No account/Official business repair follows from these results.

The actual8dc Security job112068753803 found GHSA-jqcg-44mw-7w3h in
`apps/desktop > @modelcontextprotocol/sdk > express > proxy-addr`. The lock graph
has one vulnerable2.0.7 package/snapshot; Express5.2.1 requests `^2.0.7`, which
permits the patched2.0.8. The same shared leaf reaches Desktop, API and
pi-agent-runtime production graphs, plus the CLI development graph. SDK1.30.0,
Express5.2.1, all importer declarations and every other package stay unchanged.

Recursive leaf updating also refreshed two unrelated leaves; those exploratory
lockfiles were discarded. The existing targeted override mechanism now adds only
`express>proxy-addr: ^2.0.8`, with removal when upstream requires the patched
floor. This is within Express's compatible range and prevents a vulnerable older
selection; no global major override or SDK/Express upgrade. Normal pnpm10.33.4
lockfile-only resolution produces only that leaf's2.0.7→2.0.8 entries, Express
edge and matching override. Registry integrity matches the generated lock entry;
forwarded0.2.0/ipaddr.js1.9.1 and Node>=0.10 stay unchanged.2.0.8 was published
2026-09-15, beyond the unchanged seven-day release-age policy. No handwritten
integrity/snapshots, new age exception, audit ignore/threshold or workflow change.

Frozen installation without lifecycle scripts and module-load/interface checks
pass. Desktop/pi-agent-runtime/CLI/API type checks pass; this is not HTTP/trust,
Desktop packaging or live compatibility acceptance. Production audit exits0,
critical0, with metadata still reporting one high under existing audit policy;
not a vulnerability-free claim. No local Vitest/native/PG/devserver or environment
repair. New dependency delta still requires independent review and its own one
natural CI cohort; first substantive failure stops acceptance, with no second
repair/rerun/recovery allowance. Account test source remains the exact6af blob.
