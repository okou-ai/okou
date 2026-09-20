# Personal subscription run identity

This document covers the #34012 identity foundation, its #34098/#34111/#34164 repairs, #34197 effective member routing, C launch consumers, and the September 16 correction (#34430) for #34010. Subscription protocols, model catalogs, pricing, and account UI availability remain unchanged.

## Effective member routing (B)

With the existing organization-scoped `PersonalSubscriptionPriority` enabled, a new member run uses a supported personal Claude/Codex subscription before the API configured for its allowed logical model. The switch keeps `enabled: false` with the existing `STAFF_ORG_ID_HASHES` allowlist: staff workspaces default on and external workspaces default off. Explicit organization overrides under `__org__` still win; individual overrides cannot bypass its organization scope. Account UI availability (`_multipleSubscriptions`) remains independent. Organization model restrictions, active entitlement and the effective provider's BYOK permission still apply. A permitted subscription needs no organization model credits. Other tools and generation keep their independent billing.

`effective-model-route.service.ts` is the shared database-only leaf for model selection and the optional member projection. It validates logical model and policy structure, then chooses a logical personal candidate or the configured organization route. Missing nullable custom provider/surface references and mappings matter only when that organization route is selected. Unknown discriminators and contradictory policy structure remain errors. A chosen personal route never returns null because of subscription failure, so persisted-model reconciliation cannot turn reconnect, refresh, quota, KMS or provider errors into another model or paid API.

Presence reads exact organization/member metadata, connected/retained account existence and singleton mirror names. They do not list/ensure accounts, capture a concrete account, decrypt, coordinate credentials, or call OAuth/profile/usage. This matters because thread reconciliation invokes selection while holding lifecycle rows. A retained parent whose connection and mirror were cleared is absent for a new run. A real historical writer can recreate the mirror before its parent update; a new or partial mirror remains personal and must reach canonical A capture/import or explicit subscription failure. An apparent active display ID is never promoted to a captured stable identity. A fixes that identity once before any captured-account consumer; read-only thread observation may start concurrently, but final admission stays database-only.

Chat, thread defaults/updates, queued messages promoted to a new run, linked integration members and workflow launches use this route through the existing model selectors. Workflow identity is `automation.ownerUserId`. A message with no run yet resolves current settings when promoted; an admitted queued/pending/running run retains its captured source and executor. Private Pi maintenance keeps its explicit source-owned plan and does not acquire a global member preference in lower-level run creation.

Effective provider selection precedes executor, session and model credit/billing decisions. Claude API/Pi to personal Claude Code can rotate the canonical session without changing the logical model. Changing accounts within the same Codex executor/family retains session continuity. Supported Codex Pi/Fast/non-Pi behavior and the unsupported native Claude subscription Pi boundary remain in their existing owners. Existing transient Pi recovery can hand the same captured personal source to Sandbox; it cannot choose another account, organization API, model, or Built-in model charge.

The policy response optionally adds `memberEffective` with `providerType`, `runtimeProviderType`, `credentialScope`, `availability` (`available`, `reconnect_required`, `unavailable`, or `plan_restricted`) and `accountSelection` (`capture_required` or `not_applicable`). Availability is local metadata, not a live provider health or quota check. Personal candidates require capture and carry no account ID or credentials. The field is omitted while priority is off. Existing administrative provider/runtime/scope/IDs/route status/default fields retain their meaning in GET and PUT; request schemas and persisted thread fields do not change. C owns client adoption of this additive response and its optional-field handling.

Organization Subscription policies retain their required subscription route and missing-connection guidance under either switch state; they never acquire an organization API because a subscription is absent or fails. Genuine absence or catalog non-support uses only an already configured organization API. The historical mirror bridge remains tied to real independently deployed writers and admitted contexts, not to B's gated response shape. #34010 owns the actual serving-writer, historical-context and executable rollback prerequisites. The former D policy conversion and mandatory E cleanup are cancelled for all organizations; supported Subscription routes and the retained switch are not cleanup targets. This slice has no migration/backfill, rollout activation or production acceptance; R1 and subsequent release gates remain with the controller.

## Launch consumers and policy writes (C)

Member UI and CLI consumers read the optional `memberEffective` projection
through a separate member adapter. Administrative routing remains unchanged.
The projection describes a local logical candidate, never a captured account
or live quota guarantee. Missing projection fields retain the old API/OFF
interpretation, including missing credentials on an organization Subscription
policy. Expanded model menus use the short **BYOK** badge for Claude/Codex
personal routes in select, compact and flyout layouts; the tooltip retains the
provider source and own-credentials help. The closed button and Fast guidance
keep their existing presentation. Failed refreshes retain the last resolved choices and the user's draft,
selected model, effort, and Fast preference.

Authenticated user/org `modelPoliciesChanged` notices invalidate only the
cheap policy projection, with baseline and reconnect resync through the shared
realtime lifecycle. Account and billing actions invalidate that same projection;
notices contain no account metadata and do not request upstream usage.

Policy GET returns an opaque `revision` over the persisted administrative rows,
independently of the requesting member. Settings submit that revision with the
array they actually read. Priority-enabled PUT rejects missing or stale
preconditions with a refresh/upgrade conflict before lazy seed/default repair
or policy/preference changes. With a current revision, an eligible admin can
add a Subscription route, change an API route to Subscription, or edit an
existing Subscription choice. Provider choices remain independent of the
precondition requirement, with model/plan/provider validation unchanged. The API-key-create flow reads a
fresh policy snapshot before constructing its subsequent conditional write.

Replacement and seed/default repair share an organization-local transaction
advisory lock. Replacement locks organization provider parents, connection
parents, surfaces, and policy rows before comparing its revision, protecting
the snapshot against FK deletion through commit. Normal runtime selection does
not take this lock when no repair is needed. Validation inside the transaction
uses local data and does not acquire A's credential lifecycle lock or perform
upstream calls. Existing feature-off Turbo setup PUTs remain supported; C does
not enable Priority for those callers or change Actions definitions.

The canonical rollback resolver requires accepted B merge
`8a5e1299b4d26bd114ccec017b84b7a83fb4a164` in addition to all prior floors and
artifact checks. The correction retains this executable floor and the actual
credential writer/context compatibility gates. Cancellation of policy
conversion creates no new conversion-specific floor or migration. No saved
policy, model default, member preference or connection is rewritten by switch
evaluation or the change to its default audience. The controller owns separate
release and production acceptance.

## Binding and credential ownership

### Failed-run recovery provenance (C)

The nullable `agent_runs.model_provider_account_identity` column records a
SHA-256 digest of the proven upstream account identity during the existing
final admission transaction, after its normal account/bundle validation. It
is included in the existing atomic run INSERT for both pending and queued
admission, using only the account validated under the final admission locks.
Queue-payload retries revalidate before insertion; the digest is not retained
in preparation state or durable queue payloads. There is no separate identity
UPDATE while those locks are held. The annotation
contains no token, ciphertext, or per-run credential copy. Codex uses its
upstream account ID; Claude uses its upstream UUID, or the established
email/workspace identity for older connections. This annotation does not alter
runtime capture, refresh, retention, or the strict event/execution protocols.

Historical rows and failed preparations remain null. A concrete account ID
alone cannot prove that an older writer never changed its identity in place;
there is no guessed deployment date, active-account inference, or backfill.
The additive owner/org-scoped run GET reports persisted provider/model/scope
with an unknown, unavailable, or currently connected original account. A
deleted account keeps its historical source explanation without exposing
retained credentials or resurrecting its authority. Retired provider enums
remain readable as unknown, following the existing error-format read boundary.

Only the latest actionable failed run lazily loads this metadata for recovery,
independently of Debug; trace controls still require Debug. Exact account reads
and resets require the failed run ID independently of both UI switches, keeping
the existing singleton reset available while Priority remains off. The original
settings reset still requires Accounts. Recovery supplies the run ID and concrete account ID, rechecks owner/org/connected state and the
captured identity, and compares Codex's resolved upstream account ID again
before consuming a reset credit. The failure-recovery reset uses a distinct
run-ID path so an older API returns 404 instead of ignoring a new precondition;
there is no retry through the settings/type reset endpoints. Singleton display IDs remain logical parent
IDs and are never substituted for the captured account. Explicit continue
creates a normal new run using current authorized settings.

Deploy the nullable column before the new API. Old APIs ignore the additive
column and old run-response decoders strip the optional `source` field; new
clients tolerate its omission with neutral guidance and no inferred reset
target. R1 still owns closure of old writers and the real historical-context
drain. The digest provides recovery provenance, not permission to bypass those
activation gates.

Every newly admitted personal Claude/Codex subscription run captures a concrete `model_provider_accounts.id`, independently of `_multipleSubscriptions`. Capture may overlap the first read-only thread session/prompt observation. Both branches are joined before environment preparation or any other captured-account consumer, and only thread-owned body, prompt, session-resolution and browser fields are composed onto the captured command. Post-authorization work remains capture-gated. A stale thread snapshot reruns only thread observation; it does not recapture or change the fixed account/model pin. The final admission transaction takes the existing organization admission lock, locks its existing thread/session rows, and then takes the provider auth-state lock. It revalidates the captured connected account and writes the same ID to run metadata/model pin and execution-context model-provider `sourceId`. Removal winning that race produces an explicit subscription admission failure; it never selects a sibling account, organization API key, or other model.

This scheduling change adds no query statement and leaves successful-path query counts unchanged. If capture fails, the already-started thread branch may complete its existing bounded read-only session and prompt queries before the request returns the capture conflict. That speculative branch performs no write, post-authorization work, proof, admission, durable queue publication or spawn. Capture conflict, rejection and abort priority remain explicit, and every started branch is settled before the request returns.

Account rows own encrypted credentials. Refresh and verified same-upstream-identity reconnection update those shared credentials under the existing auth-state lock; rotating refresh tokens are never copied per run. Codex uses its upstream account ID. Claude uses account/organization UUIDs when provided by the existing profile endpoint, with the existing stored email/workspace identity for older OAuth connections. A legacy Claude token without recorded identity is checked using that token before a replacement; an unavailable identity is left unchanged rather than inferred from the new active account.

A different verified upstream identity selects/creates a different account row. `PersonalSubscriptionPriority` controls whether the replaced account is retained for existing runs; with it disabled the replaced account is hard-deleted and those runs receive existing subscription guidance. Duplicate reconnection reuses the matching identity; retention of another identity referenced by an admitted run remains controlled by the priority switch. Ordinary disconnect hides the account from listing, selection, activation, reset/usage and reconnect by the old ID. A fresh authenticated connection to the same upstream identity can restore that row and its shared refresh state.

Disconnected rows and their encrypted secrets survive only while an exact `(runId, orgId, userId, accountId)` reference is `queued`, `pending` or `running`. Runtime firewall and supported Pi credential reads/refreshes must prove that reference. The logical parent survives only to own retained rows; the last connected account removes the singleton mirror after detaching its cascading foreign key. Retained-only parents are hidden and never lazily reseeded.

The shared terminal transition cleans the final disconnected reference after completion, failure, cancellation, runtime timeout or queue expiry. It rechecks under the auth-state lock, including when disconnect was still committing at the first read. Cleanup is transactional and idempotent. There is no elapsed-time retention period or background retention workflow. User/org deletion and user ban keep their existing hard authority termination and cleanup paths. Membership cleanup now explicitly cancels the removed member's nonterminal runs, removes queue entries, and hard-deletes personal providers, mirrors and pending provider auth sessions in that organization. A regression test exposed that the previous membership cleanup only removed membership resources/cache and still allowed runtime subscription auth. In-flight refresh does not recreate deleted accounts.

## Admission and terminal lock ownership

The #34098 repair orders contended lifecycle rows before the provider advisory lock. The organization admission lock does not serialize completion, and two dispatchers can prepare the same queue head before the final claim. A losing preparation must wait for the terminal transaction without owning the provider lock needed by its cleanup. This applies with the priority switch off too: cleanup locks the provider before rechecking disconnected state.

| Entry / owner                                                                           | Transaction order and subsequent writes                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-run-create.service.ts` final admission                                           | Organization admission, thread `FOR UPDATE`, validated expected session `FOR UPDATE`, then provider. The unvalidated branch also locks the thread before its later binding write. Existing sessions not covered by snapshot validation acquire their run-insertion FK `KEY SHARE` before provider, including session-only launches. Queue claim and new run/session/queue writes remain in this transaction; newly allocated row IDs cannot belong to an earlier completion. |
| `agent-webhook-complete.service.ts` complete/fail                                       | Checkpoint lifecycle, thread, run, checkpoint/session and applicable Pi memory storage, then shared terminal/provider cleanup. Active-input finalization precedes cleanup; callbacks and queue draining follow commit.                                                                                                                                                                                                                                                       |
| `cron-cleanup-sandboxes.service.ts` runtime timeout                                     | Checkpoint lifecycle, thread, run, active-input finalization, then shared terminal/provider cleanup. It uses the same thread-before-provider boundary as completion.                                                                                                                                                                                                                                                                                                         |
| `run-queue.service.ts` expiry/orphan cleanup                                            | Discover candidate IDs, lock their threads in ID order (including existing event parents), lock runs in their existing deterministic order, recheck terminal eligibility, then shared provider cleanup. Queue-marker revocation reuses those already-owned threads before commit.                                                                                                                                                                                            |
| `run-queue.service.ts` promotion/admission failure                                      | Organization admission, candidate threads, run; a rejected admission then uses shared terminal/provider cleanup. Queue-marker revocation and queue deletion cannot acquire a new thread after provider.                                                                                                                                                                                                                                                                      |
| `chat-queue-marker.service.ts` marker insertion                                         | Thread before run, including post-admission marker writers, so insertion cannot invert the corrected queue-maintenance order.                                                                                                                                                                                                                                                                                                                                                |
| `run-cancel.service.ts` / `cancelLockedRun`                                             | Pi lifecycle, run, shared terminal/provider cleanup, queue deletion. Thread events and draining are post-commit side effects.                                                                                                                                                                                                                                                                                                                                                |
| `routes/runners.ts` poison-job failure                                                  | Run, runner job, shared terminal/provider cleanup, job deletion. No later thread/session lock in this transaction.                                                                                                                                                                                                                                                                                                                                                           |
| `webhooks-clerk-cleanup.service.ts` and `org-member-cleanup.service.ts` hard revocation | Nonterminal run updates, shared cleanup (provider keys sorted by org/user/type/account), then queue/credential deletion. These transactions do not subsequently lock threads/sessions; remaining user/org resource deletion follows cancellation commit.                                                                                                                                                                                                                     |
| Settings, disconnect, reconnect and runtime refresh                                     | Provider before account/secret mutations. Exact nonterminal reference checks are plain MVCC reads, not run/thread/session row locks. Rotating credentials remain shared and cleanup rechecks references under the same advisory lock.                                                                                                                                                                                                                                        |

The repair adds no schema, request, persisted-payload or credential format. Existing readers and sourceId-less compatibility remain unchanged. Complete elimination of this lock inversion requires all serving admission/queue writers to contain the repair; overlapping or restored pre-repair APIs can still use the old order. This code-only repair does not establish that deployment/drain gate or authorize changing a rollback target.

## Preparation, activation and rollback gates

`PersonalSubscriptionPriority` is organization consistent, defaults to false for everyone (including staff), and has no automatic allowlist. This PR writes new exact bindings with the flag off. Ordinary disconnect and identity retirement remain destructive until the controller explicitly enables retention. Canonical connections preserve identity with the switch off: replacement deletes A and selects a different B record instead of mutating A into B. `_multipleSubscriptions` continues to control only its existing UI surface.

The migration adds only nullable `disconnected_at`. Apply the additive migration before the new API serves traffic. The previous API can read the expanded schema; existing logical rows, mirrors, encrypted secret format and auth-state locks remain compatible. During mixed versions the old singleton writer and sourceId-less reader still exist. The current sourceId-less refresh writer synchronizes active concrete token and expiry/reconnect state under the same lock. Preparation is not the activation gate: old API writers can still perform the previous mutable/destructive operations.

Before enabling the new behavior, the controller must verify both:

1. Every pre-preparation personal subscription execution context without a concrete sourceId has drained, including queued, pending and running contexts and contexts eligible for replay/continuation. Use persisted execution contexts and nonterminal ownership, not account counts or an assumed two-hour delay. Any surviving older exact-source context must also agree with its run metadata account ID; drain unknown or mismatched bindings instead of repairing them from the active account. Do not backfill historical runs with today's active account.
2. All serving API writers are at or beyond this preparation and the rollback target understands retained accounts. No old API writer may delete a retained parent or overwrite account identity after activation.

Keep the sourceId-less compatibility reader and singleton mirror until all actual old producers, persisted contexts, queue/replay horizons and the supported rollback window have drained. The controller records that evidence in #34010 before a later child removes the branch. It is deliberately retained in this PR.

Before activation, code rollback is compatible with the additive column and the previous settings behavior. After activation, do not roll back to a writer that hard-deletes retained rows or disable retention while retained nonterminal references exist. Stop new admission/mutation as needed, drain the exact retained references, verify cleanup, and only then return to the old writer/feature-off behavior. No production override, release or production migration is executed by this implementation owner.

## Scale and validation

The controller's production inventory at **2026-09-14 08:38:07 UTC** found **64 logical subscriptions**. Only **31 concrete accounts**, belonging to **16 logical providers in 2 organizations**, existed. Singleton paths are therefore part of the primary preparation and validation surface.

The API tests exercise real chat admission and runner/firewall authorization for both subscription types with the multi-account UI off/on, feature-off preparation, pending/queued/running replacement, same-identity recovery, retained refresh serialization, final-reference terminal cleanup, and global hard revocation. They assert emitted source IDs and actual authorization headers, not only account-helper return values. Existing supported Pi, account-switch, subscription failure and settings tests remain part of targeted regression validation and the PR pipeline.

## A2: actual historical subscription writers (#34111)

This request-scoped bridge coordinates the published account store with real
singleton-only server writers. It is active independently of the account UI and
priority switches because account seeding/capture already runs with both off.
It adds no schema, migration, backfill, trigger, credential history, per-run
secret copy, or eager production repair. Retention remains gated by
`PersonalSubscriptionPriority`, default-off including staff.

### Supported producer audit

The audit compared current main `3f48ba3f8d20e03b7ccd4fafd661cfcddfda5f1f`
(including A1 `a650dc37ae2d3db8620a7136136c67f58e24f459`) with the actual API
**1.595.0** artifact at `17de21316e0db0208fea94512b932776f2a3c402`.
Its provider/account services equal pre-A
`5684b1395f620405390095cf878086f1428e495d`; the firewall difference is a later
reconnect-state reader, not a different refresh writer. This is not an old
client request handled by today's server.

| Producer                                                                                                | Transaction / committed postcondition                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Old `model-provider.service.ts` Claude singleton connection                                             | Secret `INSERT ... ON CONFLICT`, commit; then provider `INSERT ... ON CONFLICT` with its secret FK, commit. No advisory lock. The token can change independently of provider display metadata.                                                                                                                                                    |
| Old Codex multi-auth connection                                                                         | Existing provider advisory lock; all auth secrets and provider state commit in one transaction. Only singleton credentials change.                                                                                                                                                                                                                |
| Old sourceId-less Codex refresh success/failure                                                         | Existing provider advisory and refresh transaction. It consumes the current singleton rotating input and writes singleton outputs/expiry or provider-only reconnect error. It does not update concrete accounts.                                                                                                                                  |
| Old and current concrete connection, OAuth completion, account replacement/deduplication                | `upsertPersonalModelProviderAccount` / account mutation under provider advisory. Active account mutation and `mirrorAccountToLegacy` commit the identical ciphertext bundle and auth/state together. Inactive account changes do not mirror. Current identity probes precede the mutation transaction and old-token hydration is snapshot-fenced. |
| Old and current account activation                                                                      | Provider advisory; active selection and the selected account's entire bundle/state mirror commit together. Explicit inactive-account selection remains deliberate. Re-selecting the current active account first coordinates a historical write.                                                                                                  |
| Old and current exact-source Codex refresh                                                              | Provider advisory; outputs, expiry and reconnect state change together. Active account outputs use the same newly encrypted bytes in the mirror; inactive/retained refresh never mirrors.                                                                                                                                                         |
| Current sourceId-less Codex refresh                                                                     | Same provider lock/transaction. Coordinates first, then updates the active account and singleton with identical encrypted outputs and state.                                                                                                                                                                                                      |
| Lazy account seed / identity hydration                                                                  | Seed copies the exact legacy encrypted bundle under provider and real credential row locks. Codex identity hydration reads its stored ID/ID token; Claude identity proof uses the actual token outside locks. Identity/display-only changes are not credential authority.                                                                         |
| Ordinary account deletion / terminal cleanup                                                            | Provider advisory; retire/delete the account, atomically mirror the selected remaining connected account, or detach/remove the singleton when no connected account remains. Terminal cleanup removes only unreferenced disconnected credentials.                                                                                                  |
| Historical type deletion; current user/org deletion, membership removal and ban                         | Hard authority removal/cascades. Readers do not recreate missing parents or removed exact IDs. A re-created provider is a different authority.                                                                                                                                                                                                    |
| Bounded KMS rotation script `turbo/packages/db/scripts/migrations/013-kms-account-rotation/backfill.ts` | Independently replaces encrypted cells in both tables using ciphertext CAS while preserving plaintext. Ciphertext inequality alone therefore does not prove a credential change: complete plaintext equivalence is also a coherent bundle.                                                                                                        |

These producers form the no-schema invariant: a supported canonical credential
mutation cannot leave an active credential bundle different from its mirror at
commit. Inactive writers never claim mirror authority. A mismatch caused by a
singleton-only writer is imported as a whole bundle; incomplete credentials,
missing parent authority or unprovable opaque identity fail explicitly. There
is no timestamp, expiry, workspace, account-count or active-position freshness
heuristic. Dates in a snapshot serve only as equality fences. A retained-only
parent normally has no mirror; a new complete mirror from an old connection can
select a new/matching account without rewriting any retained account.

### Identity, locking and consumer boundaries

Codex identity is the actual `CHATGPT_ACCOUNT_ID`, with the existing ID-token
metadata convention; access, refresh, account ID and ID token are read/imported
together. Claude requires the actual profile of a changed token, preferring
account/organization UUIDs and retaining the justified older email/workspace
comparison. When A lacks recorded identity its own token must also yield a
profile before a changed active bundle can be classified. A successful usage
request alone proves no identity. Coherent normal capture/auth performs no
additional profile or usage requests.

Canonical connection and legacy import both preserve concrete identity independently of the priority/UI switches. The previous priority-off canonical mutation could overwrite A in place with B; the repair removes that writer and separates identity stability from retained lifetime. Same proven identity updates the shared account. A different proven identity
selects a matching/new record, never overwrites A with B. Priority-off repair
may hard-remove the replaced A according to preparation semantics; it does not
silently retain it. With retention enabled in internal tests, A's existing exact
run keeps A. Unknown historical identity is unavailable, not rebound.

Lock order is A1's existing lifecycle thread/session rows, then provider
advisory, then provider row, account rows ordered by ID, singleton secret rows
ordered by ID, and account-secret rows ordered by ID. The new snapshot locks
use `FOR NO KEY UPDATE`, which excludes the old Claude secret update but is
compatible with the later provider insert's secret FK `KEY SHARE`. No secret
trigger acquires a provider lock. After the separately awaited advisory lock,
one statement locks the provider and its ordered account inventory through
correlated locking subqueries. The account subquery locks and returns the base
rows directly; the outer left join preserves a provider with an empty inventory.
Current account membership writers hold the advisory lock. Historical Codex
post-seed identity hydration can update existing account metadata after its
transaction commits; the locking account read follows that updated tuple.
The mirror and account-secret reads remain subsequent statements, preserving
fresh visibility of historical Claude's secret-first autocommit writes.
Ordinary profile requests happen after the snapshot transaction commits. The
second transaction compares the complete
provider, active selection, account identities, secret IDs and ciphertext
bundle; a winning write, activation or deletion discards the delayed result.
Exact environment preparation reuses the existing coordinator's completed
account, selected model and encrypted account-secret rows. It retains the initial
scoped account lookup and filters the completed inventory by the fixed
ID/org/user/type and connected state, including connected inactive accounts.
The coherent fragment uses five SQL statements instead of the original nine,
excluding transaction control. Metadata-only Codex reconciliation supplies its updated
account through `UPDATE RETURNING`. After a legacy import, this data reader
refreshes the inventory inside the same transaction; it never returns the
pre-import account or secrets. Compared with the account-only post-import read,
that exceptional refresh adds three statements while replacing the three later
environment reads for a surviving identity. Capture/readiness coordination
callers retain their account-only result.
Environment builders preserve auth-method/required-secret checks and lazy
firewall materialization; these encrypted observations are not persisted,
logged, or retained for runtime auth or admission.

Final admission is database-only; stored-secret decryption belongs to
preparation. After environment/launch preparation,
`preparePersonalSubscriptionAdmission` captures
the encrypted snapshot in a short provider/credential transaction, releases its
locks, then proves complete bundle equivalence outside every admission lock.
The operation-local proof contains the fixed source ID and exact serialized
encrypted snapshot; it is never written to run metadata or queue payloads.
This also accepts independent KMS re-encryption of equivalent complete bundles.

The final transaction retains the organization and A1 lifecycle fences, takes
the provider advisory lock once, locks the same provider and bounded credential
rows, and compares the exact snapshot. It checks the captured account's fixed
ID/org/user/type and connected state from that locked inventory before inserting
the run; a connected inactive source remains valid. No second account SELECT is
needed: the validated snapshot account also supplies the existing failed-run
recovery identity digest. It cannot call general reconciliation, KMS or a profile
endpoint.
Changes to row IDs, account identity/selection, state or any ciphertext reject
the original capture with existing guidance. Even equivalent re-encryption
after the proof invalidates it; a fresh request can prove the new snapshot.
The same proof is retained across the queue-payload encryption retry outside
the final transaction. There is no sibling/account/model/payment reselection.
Dispatch timings separate `api_dispatch_subscription_prepare_snapshot` (the
short encrypted-state transaction), `api_dispatch_subscription_prepare_bundle_proof`
(outside-lock equivalence, including KMS when ciphertext differs), and
`api_dispatch_subscription_validate_admission` (the final locked check).
Each carries only the bounded `subscription_provider_type` classification in
addition to the collector's standard request metadata. These are nested spans;
their percentiles must not be added to parent phase percentiles.
`api_dispatch_pre_create_agent_capture_subscription_account` directly measures
the pre-create capture call. Its first execution may overlap read-only thread
session/prompt observation, and it still executes only once across bounded
thread-snapshot retries.
It also covers the non-personal no-op branch and records no additional identity
or credential fields. It is nested in pre-create; compare matched provider and
account paths instead of adding it to the parent phase.
Rotating refresh retains its existing single transaction/provider owner and
checks the locked current bundle before spending the refresh token.

Complete bundle materialization decrypts at most two stored fields concurrently
under the same provider/credential owner. Each batch is joined before returning
or propagating its first input-order failure; later batches do not start after
failure. This adds no plaintext cache, early lock release, retry or transport
cancellation. A slow sibling can extend error-return/lock-held time. Independent
providers multiply this per-bundle fan-out; it is not a fleet-wide limit. See the
[controlled experiment and limitations](subscription-decryption-experiment.md).

Bundle equivalence skips identical ciphertext. For each unequal ciphertext
field, canonical and mirror decrypts run as a joined pair with canonical-first
error selection. Fields remain sequential and stop after mismatch or failure.
A canonical failure can leave an extra mirror request to join and retain the
existing provider owner while that slow sibling finishes. The comparison also runs
outside locks during admission preparation; concurrent proofs multiply its
per-pair bound. See the [paired proof experiment](subscription-equivalence-experiment.md).
Lazy environment preparation and database-only final admission retain their
existing boundaries.

| Consumer                                                 | Coordination and observable boundary                                                                                                                                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings list / lazy seed                                | Coordinates before returning accounts. An unresolved active Claude identity reports existing reconnect guidance and does not fetch usage with stale credentials.                                                                                                    |
| Logical capture and internal direct account-ID capture   | Selects from the completed coordination inventory. Logical capture may initialize its exact parent; concrete capture never initializes or substitutes a sibling. Missing/retired IDs fail closed. Public model-first requests do not accept arbitrary account IDs.  |
| Environment preparation and final admission              | Exact account environment resolution coordinates; final lifecycle transaction rechecks the captured ID under the locked bundle. A late different identity fails admission, without reselection.                                                                     |
| Existing exact-source firewall auth                      | Re-reads shared account credentials, including contexts created before this repair. Complete runtime bundles are materialized after any refresh so Authorization and account-ID headers cannot come from separate snapshots.                                        |
| Runtime refresh state/input and mirror-capable mutations | Locked coordination precedes rotating input consumption. Inactive/retained exact IDs bypass active-mirror import; explicit connection/selection can commit its supplied account.                                                                                    |
| Usage, reset and reconnect-state observation             | Reads the complete current account bundle. Retired management IDs remain unavailable. Codex import invalidates singleton/account reset-credit expiry epochs before/after mutation; current connection, activation, deletion and reset invalidation remain in place. |
| Pi initial Codex credentials                             | Uses one shared bundle after refresh. Final validation carries the captured run ID and rejects every reconnect-required state before provider execution; see A3 below.                                                                                              |

### Initialization and capture query ownership (#34374)

Logical capture retains its scoped provider lookup, then uses the complete
locked account inventory to decide whether initialization is needed. It does
not issue a separate account-existence probe or read active selection again
after coordination. The locked provider must still be the previously selected
parent; deleting and recreating the same provider type cannot transfer authority.
Retained-only inventories are not empty and never seed disconnected credentials.

The actual historical singleton seed and Codex identity hydration remain. A
successful seed obtains a fresh snapshot inside the same transaction. Coherent
reconciliation returns the existing locked accounts; a metadata update returns
the actual updated row, and identity import reads completed account state before
commit. Claude profile proof remains outside locks and its second transaction
still fences the complete original snapshot. Exact connected inactive accounts
remain valid; an exact account retired by import cannot become its replacement.
Connection preparation retains seed-only behavior so new authenticated credentials
can repair an unavailable old bundle without first requiring successful import.

For an initialized coherent provider, null-ID logical capture uses five SQL
statements: provider lookup, provider advisory lock, combined locked provider
and ordered accounts, ordered singleton secrets and ordered account secrets.
BEGIN/COMMIT are additional transaction-control statements. Explicit logical IDs add the
initial exact-ID probe; exact concrete capture uses that probe plus the four
snapshot statements. Real initialization/import paths include their necessary
writes and post-write reads and must be measured separately. These counts are
not a production latency claim. Environment resolution and the fresh final
admission proof retain their independent validation boundaries.

The #35234 batching reduces each initialized snapshot from five statements to
four. Across concrete capture, exact environment preparation, fresh admission
snapshot and final validation, the measured fragments therefore use 18 instead
of 22 statements (19 instead of 23 for explicit logical-provider capture).
These totals exclude transaction control and unrelated request work; none of
the four consistency boundaries is removed. See the
[finite coordination experiment](subscription-coordination-experiment.md) for
matched stage measurements, generated-query evidence and interpretation limits.

### Management import boundaries (#34142)

Legacy import computes affected expiry bindings from the same normalized
metadata, replacement mode and complete locked identity inventory as the real
mutation, including retained same-identity reuse. Both invalidation fences
remain; an affected in-flight result cannot publish after replacement.

Exact reset can pass its connected-account check before its own bundle read
imports a legacy replacement and retires the requested account. State-only
refresh observations apply the same account-access predicate as credential
reads, so this management request returns 404 without consuming either
account's reset credits. Connected-account terminal/transient refresh errors
retain their existing 500 and retry behavior. Every shared state lookup carries
its existing optional run ID: admitted runtime callers retain their exact
account authority, while settings and Pi memory Stage 1 have no foreground run
ID. The final Pi boundary is described in A3 below.

### Verification and compatibility limits

`personal-subscription-run-identity.test.ts` uses uniquely named test users/orgs
and `historical-subscription-writer.ts`, the only infrastructure exception that
manufactures these old artifact states. It reproduces actual autocommit and
transaction shapes, including the Claude provider insert/FK. The existing
internal run fixture adapter is used only for a captured concrete-ID admission
that current public model-first input cannot express. Assertions use production
run/claim/firewall/settings/reset APIs and actual provider HTTP requests,
Authorization/account-ID headers and rotating refresh input. Deferred provider
responses and observed PostgreSQL waiters supply synchronization; there are no
arbitrary sleeps or internal-service mocks. A1 completion/timeout concurrency,
final-reference cleanup, retained refresh/cancel and global hard revocation
regressions are included.

The rollback variable resolved to `ROLLBACK_ISSUE_NUMBER=6792`. The dashboard
revision inspected at **2026-09-14 13:57:06 UTC** still lists API 1.595.0 (and
older artifacts), alongside API 1.597.0. Inventory is not proof that every listed
artifact satisfies this contract. The bridge supports the audited writer
shapes; it does not make arbitrary old rollback lossless. Old hard deletion or
in-place identity replacement may already have erased a historical binding.
Fresh selection can recover a legitimate connection; old exact IDs either keep
their proven original authority or fail. No historical run is backfilled from
today's active account.

Before activation, the controller must drain **unknown sourceId-less and
pre-stability exact-source contexts**, including queue/replay/continuation
horizons, and ensure all serving writers are compatible. The canonical rollback
resolver must enforce an executable ancestry floor containing the final
independently accepted A/B and subsequent required behavior. The existing
`.github/scripts/resolve-production-rollback-target.sh` is the enforcement
point. That final SHA depends on later merges: this repair neither invents its
future merge SHA nor treats A1/A2 alone as the whole feature's floor. A prose
gate or a feature override is insufficient. #34010 owns this later floor,
independent acceptance, release/runtime verification and eventual bridge
removal after every writer/context/rollback gate closes. This PR changes no
rollback selector, performs no production operation and is not EPIC R1.

## A3: final Pi credential validation (#34164)

After SDK initialization and before prepared execution/provider requests, Pi
revalidates the captured account with the activation's exact run ID, org, user
and source metadata. The shared predicate permits connected accounts and
requires an exact nonterminal run binding for retained accounts. Ordinary
disconnect or different-identity replacement therefore preserves admitted A
when retention is enabled; a later run selects the current connected account.
Both singleton and multiple-account settings paths use this boundary.

Every `needsReconnect` state is unavailable, including a real HTTP 400
`invalid_grant` that leaves nonblank stored credentials. The three recognized
terminal refresh codes keep their typed handling; other reconnect states and
missing sources use the existing `reconnect_required` guidance. Validation is
read-only: it does not refresh, retry, reselect, rebuild prepared credentials or
move remote work under lifecycle/admission locks. Initial Codex materialization
still uses one shared complete bundle and the existing refresh owner.

The held-SDK API regressions assert actual Authorization/account-ID requests,
A/A followed by B/B after replacement, unchanged OAuth request counts, terminal
refresh rejection, cancellation and membership revocation, session disposal and
absence of output artifacts/Built-in usage on rejection. Priority-off deletion
remains destructive. This repair changes no persisted shape, protocol, routing
policy or feature configuration. Priority was default-off including staff at
A3; #34430 changes only its default audience as described above.

## Pi API inference without Sandbox admission (#34242)

The [inference lifecycle foundation](pi-inference-lifecycle.md) reuses this document's
captured credential-source and lifecycle-before-provider lock contract. A v4
API-only or Sandbox-waiting run has public status `pending`, retains its exact
admitted personal source, and needs no Runner job or Sandbox lease. Ordinary
disconnect preserves that admitted reference under the existing enabled retention
policy (`PersonalSubscriptionPriority`); priority-off disconnect keeps its existing
hard behavior. Final terminal cleanup removes the
last disconnected reference under the existing provider lock. Hard user, org,
membership or ban authority loss remains hard and does not authorize account
reselection. The common terminal transition also fences inference/intent/lease
publication. Resource/usage erasure can remain retryable until external release and
usage evidence exists; retention never restores revoked execution authority.

The org start switch does not gate these readers. New inference producers must
capture the existing source columns at admission, coordinate live rotating auth at
the actual request boundary, and retain every necessary catalog/credit/provider
lock. The foundation adds no credential snapshot, fallback account, provider call
or production activation.
