# Chat run context signals

`createAgentRunContextSignals(userId, orgId, agentId)` owns one identity-scoped
set of read-only async computeds. The interface contains exactly three plain IDs
and computeds; no commands, state or writes. The cross-graph exception is recorded
in [API ccstate design](api-ccstate.md#1-factories-take-plain-values).

## Independently consumable groups

- `agent$`: Agent configuration and its organization-default identity.
- `plan$`: organization plan capabilities; capacity consumes only this group.
- `allowance$`: org-keyed entitlement/window snapshot plus GET-only Stripe
  subscription preparation. Routing admission, final admission and refresh
  preparation share this read. Entitlement CAS and allowance window activation
  remain in the launch transaction; they are not speculative reads.
- `credits$`: one org/member balance snapshot. Expired organization credits and
  unexpired member usage-pack grants are each aggregated once with the same
  captured cutoff; routing-credit and final admission consume this computed.
- `memberMetadata$`: one org/user owner for profile, timezone, image-model,
  selected-model and service-tier preferences. S1 model selection and S3 runtime
  metadata consume the same union result; missing preferences remain authoritative.
- `modelFacts$`: the catalog, routes, organization policies, model mode and credits.
  It shares `plan$` rather than rereading the entitlement.
- `memberModels$`: member providers, connected accounts, configured models and
  encrypted provider/account secrets, joined once for `(orgId, userId)`. Routing,
  exact source selection and subscription candidate capture share these rows.
- `orgModelSources$`: organization provider configuration and encrypted credentials,
  read once for `(orgId, __org__)`; S1 policy resolution and S3 source assembly share it.
- `gatewayModelSources$`: organization gateway surfaces, connection configuration
  and encrypted credentials, read together for `orgId`.
- `managedModelKeys$`: global managed-key IDs, vendors and secret values in one
  projection. Route selection and the exact selected key consume this same snapshot.
- `modelPricing$`: global `(kind, provider, category)` existence projection, indexed
  once. Request-specific pricing aliases and service tiers consume it without SQL.
- `orgMetadata$`: one organization row shared by Agent default identity and model facts.
- `connectors$`: #37563's joined account/variable/credential statement, source
  snapshots and safely settled credential decryption. `environment$` shares the
  same statement; there is no second variable or selected-secret query.
- `officialCatalog$`: global accepted catalog, shared across identity changes.
  It starts only when selected Official Workflows consume it, avoiding extra
  reads for Agents with no Official mounts.
- `officialWorkflows$`: accepted catalog, immutable revisions and their exact
  Storage rows, selected from mounted Workflow identities without model routing.
- `storage$`: Agent-owned skill/Connector mount lookup keys, the org/user
  `memory` root, and the shared HEAD/exact-version index. Published Official rows are reused from revisions.
- `storageCache$`: a pure projection of all three read-only URL-cache scopes
  returned by index/revision JOINs. It issues no separate SQL. Missing cache
  rows are authoritative; local signing does not reread them.
- `permissionGrants$`, `workflows$`, `featureSwitches$`,
  `disabledPaidTools$`, `environment$`, `connectorSelection$`,
  `customConnectorDefinitions$` and `catalog$`: individually consumable groups.
  The Connector selection statement returns grants and custom definitions once;
  catalog consumers share one captured generation without S3 revalidation.

S1 creates the interface once. Authorization reads `agent$`; model validation
reads `modelFacts$`, `memberModels$` and the member preference owner
`memberMetadata$`. It does not await unrelated groups.
Immediately after S1 creates the authenticated org/member/Agent interface,
`preloadAgentRunContext$` triggers all groups once without awaiting them, in
parallel with authorization, remaining S1 validation and enqueue writes. It owns
their settled promises with `waitUntil`, even when validation rejects the request
before enqueue. Rejections stay cached in the original computeds; pick consumers
fail fast without a second loader. Rejected requests never use or return these
speculative facts. Reads on rejected requests and connection contention are
accepted for this timing phase; a missing-context pick retains its existing
post-claim preload. There is no `bootstrap$` aggregate and no transported
`PrefetchedAgentBootstrap`/`PrefetchedModelBootstrap`.

## Claim identity and graph boundaries

The lease UPDATE joins `chat_threads` and returns `userId` and `agentId` with its
existing claim fields in one statement. At the start of pick, matching IDs reuse
the supplied interface. Missing or mismatched IDs construct the same factory.
An organization match reuses `plan$` and `modelFacts$`; an organization-and-user
match also reuses `memberModels$`, `memberMetadata$` and `credits$`, independent
of Agent identity. A missing-context pick starts the same batch preload with the
same snapshot shapes before consuming any of these groups. Only the whole
read-only interface crosses into Thread; pick's individual graph nodes do not.
The request Store memoizes the computeds. Later-request queue drains build their
own interface, and no process cache or age policy is introduced.

Integration reconciliation may change the default Agent after the lease; that
execution gets a new Agent-scoped interface and retains matching org/member data.
The ordinary web path does not wait for the queue head to begin identity reads.

## Credit and plan semantics

Ethan approved using the captured credits balance on October 2, 2026. Both
preparation admission checks use that snapshot. The D-group extension captures
expired-credit and usage-pack totals once in `credits$`, with one shared cutoff
and the existing safe-integer/null contracts. Both credit consumers use `get`
instead of reaggregating the tables. Another run's spending or a payment
between capture and admission does not replace the balance snapshot.
The captured plan also determines the free-plan admission bit. Thread does not
restore plan `FOR UPDATE`; the Pi maintenance entrypoint also captures the plan
outside its launch transaction and uses that snapshot without `FOR UPDATE`.
Its credential, subscription, job/version and allowance activation fences
remain unchanged. Account transaction validation, official workflow
pointer/installation/automation admission, thread/session, lease and queue
fences remain intact.

## Scope and acceptance boundary

The W0 change restructured Agent/model sources and the Connector sources merged
in #37563; the A-group extension adds Official Workflow and Agent Storage groups.
The B-group org-only `allowance$` prepares its read once; launch-time allowance
activation remains fenced. Agent and feature-switch consumers reuse their
captured context groups. #37563's removed current-catalog revalidation remains
removed: a pick
uses one captured generation, including when the live catalog changes during
preload. Thread connector selections still read in S3 but start independently
of prompt/model material. Per-account credential failures remain settled until
the selected account consumes them; an unused malformed credential does not
fail another account's run.

Regression coverage uses real send/Run/Runner APIs for a matching context, queued
input drained in a later request without a context, model policy changes while
an external attachment response is pending, and fail-fast matching preload
failure. #37563's captured-generation behavior and next-pick account-default visibility are preserved. Deployed parent/PR
trace comparison reports statement/table counts separately from runner output,
and does not claim production latency improvements from a small sample.

## Official Workflow and Storage snapshot authority

The accepted catalog reuses its global authority key. Selected revision facts
and Agent mount groups reuse only the complete org/user/Agent identity. Revision selection has no model/CLI/path dependency: Thread assembles
framework-specific mount paths later from the captured accepted definitions.
The default `memory` root key is `(orgId, userId, "memory")`, independent of
framework, thread or message. Its HEAD and joined presign-cache rows are captured
by `storage$` / `storageCache$`; an absent root remains authoritative until the
existing write path initializes it. Thread/session-selected memory versions,
previous-session exact versions and request-owned mount keys stay local. These
are resolved by the single captured Thread Storage index, not per-consumer
loaders. Their keys use the same index/cache JOIN loader once; an absent Agent row or a
failed Agent snapshot is never retried by the thread loader. The exact Storage
rows and joined URL-cache rows resolved for the manifest also feed execution
signing, eliminating both the second `readExactVersions` call and a standalone
cache SELECT. A thread-owned historical/prefix version lookup likewise joins
its cache row without reloading the Storage identity. SQL cache keys use the
same policy constants and canonical JSON representation as the JS signer. Pi maintenance keeps its own standalone loader.

`official-workflow-catalog-sync.service.ts` is the production publisher for
release/revision rows. Both persistence functions use `onConflictDoNothing`,
then compare canonical payload and artifact identity; a differing existing row
rejects publication rather than being updated. Repository production writers
neither update nor delete these two immutable tables. Revision Storage and
version foreign keys prevent deleting referenced artifacts. Test-only catalog
reset routes are not a production mutation path.

The launch transaction retains catalog `FOR SHARE` and obtains the accepted
release ID in that locked statement. It must equal both the captured catalog
and run provenance. Under that fence, immutable captured payload/revisions need
no second SELECT. Installation and automation `FOR UPDATE` checks remain live;
no plan lock or subscription-account fence changes in this extension.

## Thread/message request facts

Thread-dependent values are ordinary `ChatThreadRequestFacts`, separate from
`AgentRunContextSignals`. An existing send extends its authorized S1 row with
the two session-binding IDs; a new send supplies the fields it actually inserts.
Only an inserted, committed input carries these facts. Pick compares org, thread,
user and Agent with the lease UPDATE receipt before passing them to Thread.
A missing or mismatched snapshot uses the same single Thread-row computed;
there is no alternate reader after a matching snapshot or read fails.

Thread uses that row for host lookup, session binding and Connector ownership.
A null host/session ID does not issue a host/session query. Session material is
read once from the captured session ID, without joining `chat_threads`; its
nullable result retains the former LEFT JOIN semantics. Connector selections
still start independently and read once for the captured thread.

The first eligible input and its immutable material are selected in one ordered
query, with a single anti-revocation check. When its ID is the committed S1 input,
Thread uses the known payload/model/workflow IDs and network-capture decision.
Older heads and later-request drains use the same selected row and read the
older input's capture row, never the newest send's values.

Two kinds of transaction protection remain distinct:

- The session/conversation lock remains. The thread binding write now compares
  user/Agent ownership and both `agent_session_id` and `agent_session_run_id`
  with the captured values; this replaces the transaction's separate
  thread-session SELECT. Memory scheduling omits the ownership JOIN because
  the transaction cannot commit unless this binding CAS succeeds. The existing
  memory ownership check remains for reassignment producers or a resolved
  Agent different from the captured thread Agent; those paths do not share the
  normal snapshot's ownership authority.
- The live queue-head SELECT remains an explicit FIFO fence. Current main
  compares the actual first eligible ID with the prepared association before
  writing the unique revoke edge. That edge prevents double consumption of one
  input, but does not by itself detect a different earlier visible input.
  Therefore this second queue read is not classified as a removable hint.

Claim UPDATE/FROM, queue/revoke writes, session/conversation locks, subscription
and activation fences remain writes/fences, not repeated bootstrap reads. The
current atomic-launch CTE already returns the newly inserted Run, so the older
PMS Run readback from the historical SQL map no longer exists.

Regression coverage observes real send/Run/Runner APIs for the current input,
a newer send claiming an older input while the previous lease is suspended,
and a separate request draining without S1 facts. The overlapping case waits
on the public post-commit notification and message GET, not a global background
flush that would deadlock the suspended reader.

## Model credentials and pricing authority (E group)

Global key/pricing nodes survive any identity reconciliation. Organization source
nodes survive an org match; member providers/accounts survive an org+user match.
All are included in immediate pre-authorization preload. Required org/gateway route facts are
consumed in S1; unrelated global groups are not awaited before enqueue. A missing
key, source or pricing category is authoritative; a rejected read is not retried.
Selection is pure; secret decryption occurs only for the selected source. Native
registered-provider firewall references and Pi credential capture retain their
existing protocols. The standalone Pi maintenance source reader also captures
managed metadata and its secret together; runtime preparation issues no SQL.

Pricing `kind` and raw `provider` originate in each catalog candidate route's
`pricingKind`/`pricingProvider`. `UsagePricingResolution` maps that raw provider
under the request's middleware policy; the global projection contains all raw
keys, so selection-dependent aliases do not require a second query. Categories
come from token usage, long-context thresholds and service tier. The existing
settlement `__fallback__` category is still a pricing row, not a loader retry or
a default model/key. The selected model determines which candidate keys are
consumed; final billing validation shares the same projection. This intentionally
reads only existence columns, not monetary rates, and does not change settlement.

The removed subscription loader was guarded by a null or owner-mismatched account
snapshot (or a non-subscription provider type, which its caller already excludes).
Healthy web and automation producers supply a non-null snapshot; an early/rejected
assembly does not proceed to subscription capture. Thus automation alone was not
evidence that the fallback executed. Owner reconciliation was the remaining
identity boundary: routing now obtains member facts from the matched queued
identity, and automation execution preserves that same member node while matching
the final Agent. Subscription capture consumes `executionContext$` directly;
candidate filtering requires matching org/member identity. The live
subscription-account transaction check, queue/session CAS, catalog and allowance
fences are unchanged. No credits/member-metadata ownership changes are included.

## Adding an identity-scoped data group

1. Add a `readonly <group>$: Computed<Promise<GroupSnapshot>>` field to
   `AgentRunContextSignals` and construct its read-only computed in
   `agent-run-context.signals.ts`. Query through `db$`; derive shared values by
   `get` from the group's canonical context nodes, never a second table read.
   Factory inputs remain the three plain IDs. No command/state, writes, OAuth
   refresh, retry or unbounded cache belongs in this interface.
2. Declare the exact identity key. Org-only groups may be reused on an org
   match (`plan$`, `modelFacts$`, `orgMetadata$`). Org+user groups may be reused
   when those two IDs match (`memberModels$`, `memberMetadata$`, `credits$`),
   regardless of Agent. Agent grants,
   workflow choices, permission scope and Agent-dependent Connector material
   require the full `(orgId, userId, agentId)` match. Add the appropriate reuse
   fields to pick's context reconciliation; never accept a broader key than the
   query/data authority allows. Reused groups must retain their dependent source
   identities too, not just a computed that secretly rereads a replaced source.
3. Include the new field in `preloadAgentRunContext$`'s node list. That command
   triggers and settles each promise under `waitUntil` immediately after context
   creation, before authorization/enqueue; missing-context picks keep their
   post-claim starter.
   Preserve the computed's original rejection so a selected group fails fast;
   do not substitute a successful default or invoke another loader.
4. S1 may await the group only if authorization, validation or enqueue itself
   needs it. Use `get(context.<group>$)` directly. Do not wait for unrelated
   groups. Early preload may overlap enqueue writes; it does not delay consume.
5. Pass the whole interface through queue-drain/pick/Thread. S3 reads only the
   group it consumes with `get(context.<group>$)`; do not pass individual nodes
   or rebuild a local S3 loader. Missing-context and mismatched-identity picks
   construct this same factory after the single claim UPDATE returns identity.
6. Cover a matching send, a later-request drain without context (or a real
   identity mismatch), and a selected group failing during preload. Drive the
   real APIs and observe HTTP/Run/Runner outcomes. Synchronize external
   dependencies where needed; add no production test hooks or internal retry.
7. Compare parent and candidate traces on a fixed deployed SHA and equivalent
   fixture/model/account shape. Count SQL statements from POST through launch
   commit; separately count each table/key, including joins and CTEs. Check
   both normal and missing-context paths. Total SQL must not increase; each
   adopted table/key is read once, apart from explicitly documented transaction
   fences. Check SQL start times against S3 start, not merely request return.
   Report account-specific/nullable cases and any uncaptured group honestly.

Feature switches and member metadata reuse the org+user authority key, including
when integration reconciliation changes the selected Agent. Agent session
configuration and memory/Connector thread ownership reuse the captured Agent;
thread/session/queue conditional checks stay intact without joining `agents`
again. Memory scheduling uses captured flags, not a transaction-time reread.

Future official-workflow/storage work follows this recipe. Adding those groups
does not authorize changing other fences or Pi maintenance behavior.
