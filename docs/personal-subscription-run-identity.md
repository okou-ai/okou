# Personal subscription run identity

This document covers the #34012 identity foundation, its #34098/#34111/#34164 repairs, #34197 effective member routing, C launch consumers, and the September 16 correction (#34430) for #34010. Subscription protocols, model catalogs, pricing, and account UI availability remain unchanged.

## Effective member routing (B)

A new member run uses a supported personal Claude/Codex subscription before the API configured for its allowed logical model. This was gated by the organization-scoped `PersonalSubscriptionPriority` switch; that switch has been removed and the behavior is now unconditional for every workspace, with no per-organization opt-out and no rollout allowlist. Account UI availability (`multipleSubscriptions`) remains independent. Organization model restrictions, active entitlement and the effective provider's BYOK permission still apply. A permitted subscription needs no organization model credits. Other tools and generation keep their independent billing.

`effective-model-route.service.ts` is the shared database-only leaf for model selection and the optional member projection. It validates logical model and policy structure, then chooses a logical personal candidate or the configured organization route. Missing nullable custom provider/surface references and mappings matter only when that organization route is selected. Unknown discriminators and contradictory policy structure remain errors. A chosen personal route never returns null because of subscription failure, so persisted-model reconciliation cannot turn reconnect, refresh, quota, KMS or provider errors into another model or paid API.

Presence reads exact organization/member metadata and connected account existence. It does not list accounts, capture a concrete account, decrypt, or call OAuth/profile/usage. This matters because thread reconciliation invokes selection while holding lifecycle rows. A type without a connected account is absent for a new run. An apparent active display ID is never promoted to a captured stable identity. A fixes that identity once before any captured-account consumer; read-only thread observation may start concurrently, but final admission stays database-only.

Chat, thread defaults/updates, queued messages promoted to a new run, linked integration members and workflow launches use this route through the existing model selectors. Workflow identity is `automation.ownerUserId`. A message with no run yet resolves current settings when promoted; an admitted queued/pending/running run retains its captured source and executor. Private Pi maintenance keeps its explicit source-owned plan and does not acquire a global member preference in lower-level run creation.

Effective provider selection precedes executor, session and model credit/billing decisions. Claude API/Pi to personal Claude Code can rotate the canonical session without changing the logical model. Changing accounts within the same Codex executor/family retains session continuity. Supported Codex Pi/Fast/non-Pi behavior and the unsupported native Claude subscription Pi boundary remain in their existing owners. Existing transient Pi recovery can hand the same captured personal source to Sandbox; it cannot choose another account, organization API, model, or Built-in model charge.

The policy response optionally adds `memberEffective` with `providerType`, `runtimeProviderType`, `credentialScope`, `availability` (`available`, `reconnect_required`, `unavailable`, or `plan_restricted`) and `accountSelection` (`capture_required` or `not_applicable`). Availability is local metadata, not a live provider health or quota check. Personal candidates require capture and carry no account ID or credentials. The field is now always present for a real member; it was omitted while the priority switch was off, and `isMemberModelPolicyConfigurable` still keeps its `routeStatus` fallback for an older API that omits it. Because the projection is always present, member-facing decisions that consult it — including the Codex priority service tier — are now judged on the effective route's availability rather than on a merely valid organization route. Existing administrative provider/runtime/scope/IDs/route status/default fields retain their meaning in GET and PUT; request schemas and persisted thread fields do not change. C owns client adoption of this additive response and its optional-field handling.

Organization Subscription policies retain their required subscription route and missing-connection guidance; they never acquire an organization API because a subscription is absent or fails. Genuine absence or catalog non-support uses only an already configured organization API. The former D policy conversion and mandatory E cleanup are cancelled for all organizations; supported Subscription routes are not cleanup targets. This slice has no migration/backfill, rollout activation or production acceptance; R1 and subsequent release gates remain with the controller.

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
array they actually read. PUT rejects a missing or stale precondition with a
refresh/upgrade conflict before lazy seed/default repair or policy/preference
changes; this is unconditional now that the priority switch is gone, so every
writer sends the revision it read. With a current revision, an eligible admin can
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
upstream calls. The Turbo runner bootstrap steps that previously wrote
policies without a precondition now read the current revision first, because
the feature-off path they relied on no longer exists.

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

Every newly admitted personal Claude/Codex subscription run captures a concrete `model_provider_accounts.id`, independently of `multipleSubscriptions`. Capture may overlap the first read-only thread session/prompt observation. Both branches are joined before environment preparation or any other captured-account consumer, and only thread-owned body, prompt, session-resolution and browser fields are composed onto the captured command. Post-authorization work remains capture-gated. A stale thread snapshot reruns only thread observation; it does not recapture or change the fixed account/model pin. The final admission transaction takes the existing organization admission lock, locks its existing thread/session rows, and then takes the provider auth-state lock. It revalidates the captured connected account and writes the same ID to run metadata/model pin and execution-context model-provider `sourceId`. Removal winning that race produces an explicit subscription admission failure; it never selects a sibling account, organization API key, or other model.

This scheduling change adds no query statement and leaves successful-path query counts unchanged. If capture fails, the already-started thread branch may complete its existing bounded read-only session and prompt queries before the request returns the capture conflict. That speculative branch performs no write, post-authorization work, proof, admission, durable queue publication or spawn. Capture conflict, rejection and abort priority remain explicit, and every started branch is settled before the request returns.

Account rows own encrypted credentials. Refresh and verified same-upstream-identity reconnection update those shared credentials under the existing auth-state lock; rotating refresh tokens are never copied per run. Codex uses its upstream account ID. Claude uses account/organization UUIDs when provided by the existing profile endpoint, with the existing stored email/workspace identity for older OAuth connections. A legacy Claude token without recorded identity is checked using that token before a replacement; an unavailable identity is left unchanged rather than inferred from the new active account.

A different verified upstream identity selects/creates a different account row. The replaced account is always retained while an admitted run still references it; the hard-delete path that applied while the priority switch was off no longer exists. Duplicate reconnection reuses the matching identity. Ordinary disconnect hides the account from listing, selection, activation, reset/usage and reconnect by the old ID. A fresh authenticated connection to the same upstream identity can restore that row and its shared refresh state.

Disconnected rows and their encrypted secrets survive only while an exact `(runId, orgId, userId, accountId)` reference is `queued`, `pending` or `running`. Runtime firewall and supported Pi credential reads/refreshes must prove that reference. The logical parent survives only to own retained rows and is deleted with its last account row. Retained-only parents are hidden.

The shared terminal transition cleans the final disconnected reference after completion, failure, cancellation, runtime timeout or queue expiry. It uses one conditional `DELETE` that requires `disconnected_at` and no remaining live reference, so a same-identity reconnect that revived the row makes it a no-op. Cleanup is transactional and idempotent. There is no elapsed-time retention period or background retention workflow. User/org deletion and user ban keep their existing hard authority termination and cleanup paths. Membership cleanup now explicitly cancels the removed member's nonterminal runs, removes queue entries, and hard-deletes personal providers and pending provider auth sessions in that organization. A regression test exposed that the previous membership cleanup only removed membership resources/cache and still allowed runtime subscription auth. In-flight refresh does not recreate deleted accounts.

## Credential storage and locking

`model_provider_accounts` and `model_provider_account_secrets` are the only
store for personal Claude and Codex subscriptions. Their `secrets` mirror, the
singleton provider fields for personal rows, lazy seeding and the historical
writer bridge were removed; see the
[deployment compatibility entry](deployment-compatibility.md#personal-subscription-credentials-become-account-only-2026-09-26).
Organization (`__org__`) subscriptions keep `model_providers` + `secrets`.

- Reads (firewall auth, Pi first-turn and memory credentials, run capture,
  environment preparation, listing) are plain reads of the exact account and
  its secrets, decrypted after the statement returns. A firewall request reads
  a bundle at most once and again only after a refresh in the same request.
- Run admission reads that the captured account exists and is connected. A
  disconnect that commits later fails the run through the explicit
  subscription-unavailable path.
- Connect, reconnect, activation, disconnect and terminal cleanup take no
  advisory or row locks. They rely on `idx_model_provider_accounts_one_active`,
  `idx_model_provider_accounts_provider_identity`, the account-secret
  `(account, name)` index and the provider `(org, user, type)` index with
  conditional writes; a losing concurrent writer receives `409`.
- Token refresh keeps the `model_provider_state` advisory lock so rotating
  refresh tokens are spent once.

## Scale and validation

The controller's production inventory at **2026-09-14 08:38:07 UTC** found **64 logical subscriptions**. Only **31 concrete accounts**, belonging to **16 logical providers in 2 organizations**, existed. Singleton paths are therefore part of the primary preparation and validation surface.

The API tests exercise real chat admission and runner/firewall authorization for both subscription types with the multi-account UI off/on, feature-off preparation, pending/queued/running replacement, same-identity recovery, retained refresh serialization, final-reference terminal cleanup, and global hard revocation. They assert emitted source IDs and actual authorization headers, not only account-helper return values. Existing supported Pi, account-switch, subscription failure and settings tests remain part of targeted regression validation and the PR pipeline.

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
